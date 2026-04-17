// Network monitoring daemon. Three independent loops (ping / speed / ttfb)
// write samples to a shared SQLite database. Designed to run forever with
// zero supervision — all errors are logged and swallowed so one bad
// measurement never stops the daemon.
const { spawn } = require('child_process');
const os = require('os');
const { loadConfigOrDie } = require('./paths');
const { openDb, pruneOldRows } = require('./db');
const { isInterfaceBusy } = require('./net-stats');

const CONFIG = loadConfigOrDie();
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

// Run one probe. Returns { ok, mbps?, passed?, failed?, error? } so callers
// (adaptive cadence) can decide the next interval.
async function runSpeedTest() {
  const ts = Date.now();
  const cfg = CONFIG.speed;
  const res = await downloadBytes(cfg.testUrl, cfg.timeoutSec);
  if (!res.ok) {
    insertSpeed.run(ts, cfg.bytes, res.durationMs || 0, 0, 0, 1, res.error);
    console.log(`[speed] ${new Date(ts).toISOString()} FAILED (${res.error})`);
    return { ok: false, failed: 1, error: res.error };
  }
  const mbps = (res.bytes * 8) / (res.durationMs / 1000) / 1_000_000;
  const passed = mbps >= cfg.thresholdMbps ? 1 : 0;
  insertSpeed.run(ts, res.bytes, res.durationMs, mbps, passed, 0, null);
  console.log(`[speed] ${new Date(ts).toISOString()} ${mbps.toFixed(2)} Mbps (${res.bytes}B in ${res.durationMs}ms) ${passed ? '✓' : '✗'} threshold=${cfg.thresholdMbps}`);
  return { ok: true, mbps, passed };
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

// ── Fixed-cadence driver (used for ping / ttfb / prune) ────────────────────
function startLoop(fn, intervalSec, label) {
  const run = async () => {
    try { await fn(); }
    catch (e) { console.error(`[${label}] error:`, e.message); }
  };
  run();
  setInterval(run, intervalSec * 1000);
}

// ── Adaptive + idle-gated speed loop ───────────────────────────────────────
// Two layered optimisations on top of the fixed-cadence speed probe:
//
//   (d) Idle gate — before running the probe, sample local NIC throughput.
//       If it exceeds idleGate.thresholdKbps, skip this cycle. This avoids
//       competing for bandwidth with the user's own active sessions (video
//       calls, downloads). Does NOT see other devices on the LAN.
//
//   (f) Adaptive cadence — after N consecutive healthy probes (mbps >= 2x
//       threshold), double the interval up to maxIntervalSec. Any degraded
//       probe resets to the configured base interval. Cuts daily probe
//       volume by ~50–80% on consistently-healthy networks.
//
// Both default ON but each can be disabled independently via config.
// Disabling both yields behaviour identical to v1.0.2.
let speedIntervalSec = CONFIG.speed.intervalSec;
let healthyStreak    = 0;
const adaptiveOn     = !!(CONFIG.speed.adaptive && CONFIG.speed.adaptive.enabled);
const idleGateOn     = !!(CONFIG.speed.idleGate && CONFIG.speed.idleGate.enabled);
const HEALTHY_MULT   = 2;
const HEALTHY_STREAK = 3;

async function speedTick() {
  try {
    // (d) Idle gate
    if (idleGateOn) {
      const cfg = CONFIG.speed.idleGate;
      const { busy, iface, kbps } = await isInterfaceBusy(cfg.thresholdKbps, cfg.sampleWindowSec);
      if (busy) {
        console.log(
          `[speed] ${new Date().toISOString()} SKIP (iface ${iface} at ${(kbps || 0).toFixed(0)} kbps > ${cfg.thresholdKbps} kbps — user active)`
        );
        return;  // Don't advance adaptive state; just retry at current cadence.
      }
    }

    // Probe
    const res = await runSpeedTest();

    // (f) Adaptive cadence
    if (adaptiveOn && res) {
      const healthyThresh = CONFIG.speed.thresholdMbps * HEALTHY_MULT;
      const isHealthy = res.ok && typeof res.mbps === 'number' && res.mbps >= healthyThresh;
      if (isHealthy) {
        healthyStreak++;
        if (healthyStreak >= HEALTHY_STREAK) {
          const next = Math.min(CONFIG.speed.adaptive.maxIntervalSec, speedIntervalSec * 2);
          if (next !== speedIntervalSec) {
            console.log(`[speed] adaptive: ${healthyStreak} healthy probes, cadence ${speedIntervalSec}s → ${next}s`);
            speedIntervalSec = next;
          }
        }
      } else {
        if (speedIntervalSec > CONFIG.speed.adaptive.minIntervalSec || healthyStreak > 0) {
          console.log(`[speed] adaptive: degraded/failed — cadence → ${CONFIG.speed.adaptive.minIntervalSec}s`);
        }
        healthyStreak = 0;
        speedIntervalSec = CONFIG.speed.adaptive.minIntervalSec;
      }
    }
  } catch (e) {
    console.error('[speed] tick error:', e.message);
  } finally {
    setTimeout(speedTick, speedIntervalSec * 1000);
  }
}

console.log(
  `[monitor] Starting on ${platform} — ping/${CONFIG.ping.intervalSec}s, ` +
  `speed/${CONFIG.speed.intervalSec}s (idleGate=${idleGateOn ? 'on' : 'off'}, adaptive=${adaptiveOn ? 'on' : 'off'}), ` +
  `threshold=${CONFIG.speed.thresholdMbps}Mbps, db=${CONFIG.dbPath}`
);
startLoop(pingAllTargets, CONFIG.ping.intervalSec, 'ping');
startLoop(runTtfb,        CONFIG.ttfb.intervalSec,  'ttfb');
startLoop(pruneLoop,      86400,                    'prune');
// Speed loop is self-scheduling (adaptive cadence requires dynamic intervals).
speedTick().catch((e) => console.error('[speed] fatal:', e));

process.on('SIGTERM', () => { console.log('[monitor] SIGTERM'); db.close(); process.exit(0); });
process.on('SIGINT',  () => { console.log('[monitor] SIGINT');  db.close(); process.exit(0); });
