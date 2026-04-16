// HTTP server: serves the dashboard + JSON APIs. Pure stdlib http so the
// only runtime dependency is better-sqlite3.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { loadConfigOrDie, APP_DIR } = require('./paths');
const { openDb } = require('./db');

const CONFIG = loadConfigOrDie();
const PORT = parseInt(process.env.PORT || CONFIG.port, 10);
const db = openDb(CONFIG.dbPath);

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function parseRange(str) {
  const m = /^(\d+)([hd])$/.exec(str || '24h');
  if (!m) return 24 * 3600_000;
  const n = parseInt(m[1], 10);
  return n * (m[2] === 'h' ? 3600_000 : 86400_000);
}

// ── /api/summary ────────────────────────────────────────────────────────────
function getSummary() {
  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  const fiveMinAgo = now - 5 * 60_000;

  const pingRow = db.prepare(`
    SELECT AVG(latency_ms)                           AS avg_latency,
           SUM(lost) * 1.0 / COUNT(*)                AS loss_rate,
           COUNT(*)                                  AS samples,
           SUM(CASE WHEN lost = 1 THEN 1 ELSE 0 END) AS losses
      FROM pings WHERE ts >= ?
  `).get(oneHourAgo);

  const speedRow = db.prepare(`
    SELECT AVG(mbps)                      AS avg_mbps,
           MAX(mbps)                      AS max_mbps,
           MIN(mbps)                      AS min_mbps,
           SUM(passed) * 1.0 / COUNT(*)   AS pass_rate,
           COUNT(*)                       AS samples,
           SUM(failed)                    AS failures
      FROM speed_samples WHERE ts >= ?
  `).get(oneHourAgo);

  const latestSpeed = db.prepare(
    'SELECT ts, mbps, passed, failed, error FROM speed_samples ORDER BY ts DESC LIMIT 1'
  ).get();

  const recentLatency = db.prepare(`
    SELECT AVG(latency_ms) AS avg_latency, SUM(lost) * 1.0 / COUNT(*) AS loss_rate
      FROM pings WHERE ts >= ?
  `).get(fiveMinAgo);

  let health = 'unknown';
  if (pingRow.samples > 0 && speedRow.samples > 0) {
    const lossPct = pingRow.loss_rate * 100;
    const passPct = speedRow.pass_rate * 100;
    if (lossPct < 1 && passPct >= 95 && pingRow.avg_latency < 100) health = 'green';
    else if (lossPct < 5 && passPct >= 70 && pingRow.avg_latency < 200) health = 'yellow';
    else health = 'red';
  }

  return {
    now,
    threshold_mbps: CONFIG.speed.thresholdMbps,
    health,
    last_hour: { ping: pingRow, speed: speedRow },
    last_5_min_ping: recentLatency,
    latest_speed: latestSpeed,
  };
}

// ── /api/data ──────────────────────────────────────────────────────────────
function bucketMs(rangeMs) {
  if (rangeMs <= 3600_000)     return 30_000;
  if (rangeMs <= 6 * 3600_000) return 2 * 60_000;
  if (rangeMs <= 24 * 3600_000) return 5 * 60_000;
  return 30 * 60_000;
}

function getTimeSeries(rangeMs) {
  const since = Date.now() - rangeMs;
  const bucket = bucketMs(rangeMs);

  const pings = db.prepare(`
    SELECT (ts / ?) * ?                              AS bucket_ts,
           target,
           AVG(CASE WHEN lost = 0 THEN latency_ms END) AS avg_latency,
           SUM(lost) * 1.0 / COUNT(*)                AS loss_rate,
           COUNT(*)                                  AS samples
      FROM pings WHERE ts >= ?
      GROUP BY bucket_ts, target
      ORDER BY bucket_ts ASC, target ASC
  `).all(bucket, bucket, since);

  const speeds = db.prepare(
    'SELECT ts, mbps, passed, failed, duration_ms FROM speed_samples WHERE ts >= ? ORDER BY ts ASC'
  ).all(since);

  const ttfb = db.prepare(`
    SELECT (ts / ?) * ?                            AS bucket_ts,
           target,
           AVG(CASE WHEN failed = 0 THEN ttfb_ms END) AS avg_ttfb,
           SUM(failed) * 1.0 / COUNT(*)            AS fail_rate
      FROM ttfb WHERE ts >= ?
      GROUP BY bucket_ts, target
      ORDER BY bucket_ts ASC, target ASC
  `).all(bucket, bucket, since);

  return { range_ms: rangeMs, bucket_ms: bucket, since, pings, speeds, ttfb };
}

// ── Static ─────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = u.pathname;

    if (pathname === '/api/summary') return sendJson(res, getSummary());
    if (pathname === '/api/data') {
      return sendJson(res, getTimeSeries(parseRange(u.searchParams.get('range'))));
    }
    if (pathname === '/api/config') {
      return sendJson(res, {
        threshold_mbps: CONFIG.speed.thresholdMbps,
        ping_interval_sec: CONFIG.ping.intervalSec,
        speed_interval_sec: CONFIG.speed.intervalSec,
        ping_targets: CONFIG.ping.targets,
        ttfb_targets: CONFIG.ttfb.targets,
        retention_days: CONFIG.retentionDays,
      });
    }
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, path.join(APP_DIR, 'public', 'index.html'));
    }
    // Vendored JS (Chart.js + date adapter). Tightly scoped: only this prefix,
    // only .js files, no traversal. The safe path is rebuilt from the basename
    // so attempts like /vendor/../../../etc/passwd are impossible.
    if (pathname.startsWith('/vendor/')) {
      const base = path.basename(pathname);
      if (!/^[A-Za-z0-9._-]+\.js$/.test(base)) {
        res.writeHead(404); res.end('Not found'); return;
      }
      return serveStatic(res, path.join(APP_DIR, 'public', 'vendor', base));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error('[server] error:', e);
    sendJson(res, { error: e.message }, 500);
  }
});

// ── Explicit error handling so port conflicts produce a useful log line
// instead of a bare stack trace that launchd/systemd will just restart-loop on.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use by another process.`);
    console.error(`[server] Fix by either:`);
    console.error(`[server]   1. Stopping whatever else is on that port (lsof -iTCP:${PORT}), or`);
    console.error(`[server]   2. Changing "port" in ${CONFIG._source} and restarting.`);
  } else if (err.code === 'EACCES') {
    console.error(`[server] Permission denied binding to port ${PORT}. Use a port >= 1024.`);
  } else {
    console.error(`[server] ${err.code || 'error'}: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[server]  Listening on http://127.0.0.1:${PORT}`);
});

function shutdown(sig) {
  console.log(`[server]  ${sig} received, closing…`);
  server.close(() => { db.close(); process.exit(0); });
  // Force-exit if close hangs (e.g. long-lived client keep-alive)
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
