// Network monitoring daemon. Three independent loops (ping / speed / ttfb)
// write samples to a shared SQLite database. Designed to run forever with
// zero supervision — all errors are logged and swallowed so one bad
// measurement never stops the daemon.
const { spawn } = require('child_process');
const os = require('os');
const { loadConfig } = require('./paths');
const { openDb, pruneOldRows } = require('./db');

const CONFIG = loadConfig();
const db = openDb(CONFIG.dbPath);

// ── Platform-specific ping flags ────────────────────────────────────────────
// macOS/FreeBSD:  -W <milliseconds>
// Linux:          -W <seconds>
// Windows:        -w <milliseconds>   (not supported for now)
const platform = os.platform();
const pingArgs = (host) => {
  const timeoutMs = CONFIG.ping.timeoutMs;
  if (platform === 'darwin' || platform === 'freebsd') {
    return ['-c', '1', '-W', String(timeoutMs), host];
  }
  // Linux: seconds, round up
  return ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
};

const insertPing  = db.prepare('INSERT INTO pings (ts, target, latency_ms, lost) VALUES (?, ?, ?, ?)');
const insertSpeed = db.prepare('INSERT INTO speed_samples (ts, bytes, duration_ms, mbps, passed, failed, error) VALUES (?, ?, ?, ?, ?, ?, ?)');
const insertTtfb  = db.prepare('INSERT INTO ttfb (ts, target, ttfb_ms, failed) VALUES (?, ?, ?, ?)');

// ── Ping one target ─────────────────────────────────────────────────────────
// Parses the platform-agnostic "time=X.X ms" field. Non-zero exit → lost.
function pingOnce(host) {
  return new Promise((resolve) => {
    const child = spawn('ping', pingArgs(host));
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve({ latency: null, lost: true }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ latency: null, lost: true });
      const m = out.match(/time[=<]([\d.]+)\s*ms/);
      if (!m) return resolve({ latency: null, lost: true });
      resolve({ latency: parseFloat(m[1]), lost: false });
    });
  });
}

async function pingAllTargets() {
  const ts = Date.now();
  const results = await Promise.all(
    CONFIG.ping.targets.map(async (t) => ({ target: t.host, ...(await pingOnce(t.host)) }))
  );
  const tx = db.transaction((rows) => {
    for (const r of rows) insertPing.run(ts, r.target, r.latency, r.lost ? 1 : 0);
  });
  tx(results);
  const alive = results.filter((r) => !r.lost);
  const avg = alive.length ? (alive.reduce((s, r) => s + r.latency, 0) / alive.length).toFixed(1) : 'all lost';
  console.log(`[ping]  ${new Date(ts).toISOString()} avg=${avg}ms loss=${results.length - alive.length}/${results.length}`);
}

// ── Speed test: download a fixed-size file, record Mbps ─────────────────────
function downloadBytes(url, timeoutSec) {
  return new Promise((resolve) => {
    const args = [
      '-s',
      '-o', platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{time_total} %{size_download} %{http_code}',
      '--max-time', String(timeoutSec),
      url,
    ];
    const child = spawn('curl', args);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    const start = Date.now();
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      const elapsed = Date.now() - start;
      if (code !== 0) return resolve({ ok: false, error: `curl exit ${code}`, durationMs: elapsed });
      const parts = out.trim().split(/\s+/);
      const durationMs = Math.round(parseFloat(parts[0]) * 1000);
      const bytes = parseInt(parts[1], 10);
      const httpCode = parts[2];
      if (httpCode !== '200' || !bytes) {
        return resolve({ ok: false, error: `http ${httpCode}`, durationMs });
      }
      resolve({ ok: true, durationMs, bytes });
    });
  });
}

async function runSpeedTest() {
  const ts = Date.now();
  const cfg = CONFIG.speed;
  const res = await downloadBytes(cfg.testUrl, cfg.timeoutSec);
  if (!res.ok) {
    insertSpeed.run(ts, cfg.bytes, res.durationMs || 0, 0, 0, 1, res.error);
    console.log(`[speed] ${new Date(ts).toISOString()} FAILED (${res.error})`);
    return;
  }
  const mbps = (res.bytes * 8) / (res.durationMs / 1000) / 1_000_000;
  const passed = mbps >= cfg.thresholdMbps ? 1 : 0;
  insertSpeed.run(ts, res.bytes, res.durationMs, mbps, passed, 0, null);
  console.log(`[speed] ${new Date(ts).toISOString()} ${mbps.toFixed(2)} Mbps (${res.bytes}B in ${res.durationMs}ms) ${passed ? '✓' : '✗'} threshold=${cfg.thresholdMbps}`);
}

// ── TTFB: HEAD request, measure time_starttransfer ──────────────────────────
function measureTtfb(url, timeoutSec) {
  return new Promise((resolve) => {
    const args = [
      '-s',
      '-o', platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{time_starttransfer} %{http_code}',
      '--max-time', String(timeoutSec),
      '-I',
      url,
    ];
    const child = spawn('curl', args);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve({ ok: false }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false });
      const [t, httpCode] = out.trim().split(/\s+/);
      if (!httpCode || (!httpCode.startsWith('2') && !httpCode.startsWith('3'))) {
        return resolve({ ok: false });
      }
      resolve({ ok: true, ttfbMs: parseFloat(t) * 1000 });
    });
  });
}

async function runTtfb() {
  const ts = Date.now();
  const results = await Promise.all(
    CONFIG.ttfb.targets.map(async (t) => ({ target: t.label, ...(await measureTtfb(t.url, CONFIG.ttfb.timeoutSec)) }))
  );
  const tx = db.transaction((rows) => {
    for (const r of rows) insertTtfb.run(ts, r.target, r.ok ? r.ttfbMs : null, r.ok ? 0 : 1);
  });
  tx(results);
  const alive = results.filter((r) => r.ok);
  const avg = alive.length ? (alive.reduce((s, r) => s + r.ttfbMs, 0) / alive.length).toFixed(0) : 'all failed';
  console.log(`[ttfb]  ${new Date(ts).toISOString()} avg=${avg}ms ok=${alive.length}/${results.length}`);
}

// ── Prune: once a day ───────────────────────────────────────────────────────
async function pruneLoop() {
  const deleted = pruneOldRows(db, CONFIG.retentionDays);
  if (deleted > 0) console.log(`[prune] Deleted ${deleted} rows older than ${CONFIG.retentionDays} days`);
}

// ── Driver ──────────────────────────────────────────────────────────────────
function startLoop(fn, intervalSec, label) {
  const run = async () => {
    try { await fn(); }
    catch (e) { console.error(`[${label}] error:`, e.message); }
  };
  run();
  setInterval(run, intervalSec * 1000);
}

console.log(`[monitor] Starting on ${platform} — ping/${CONFIG.ping.intervalSec}s, speed/${CONFIG.speed.intervalSec}s, threshold=${CONFIG.speed.thresholdMbps}Mbps, db=${CONFIG.dbPath}`);
startLoop(pingAllTargets, CONFIG.ping.intervalSec, 'ping');
startLoop(runSpeedTest,   CONFIG.speed.intervalSec, 'speed');
startLoop(runTtfb,        CONFIG.ttfb.intervalSec,  'ttfb');
startLoop(pruneLoop,      86400,                    'prune');

process.on('SIGTERM', () => { console.log('[monitor] SIGTERM'); db.close(); process.exit(0); });
process.on('SIGINT',  () => { console.log('[monitor] SIGINT');  db.close(); process.exit(0); });
