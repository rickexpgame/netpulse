// Central path resolution + config loading. Every module imports from here
// so state locations and schema checks live in exactly one place.
//
// Layout:
//   $NETPULSE_DIR/           (default ~/.netpulse)
//     config.json            user-editable; seeded from config.default.json on install
//     data.db                sqlite database
//     logs/                  (created by start-bg.sh; not used by the node app itself)
//
// Design intent: keep the plugin cache read-only so plugin updates never wipe
// user data. All mutable state lives in $NETPULSE_DIR.

// Private-by-default BEFORE any fs access: eliminates the race window where
// files get created with the process's inherited umask and then get chmod'd
// later. Running this first means every file the daemon creates lands at 600
// (or 700 for dirs), no further mitigation needed.
process.umask(0o077);

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.HOME || os.homedir();
const NETPULSE_DIR = process.env.NETPULSE_DIR || path.join(HOME, '.netpulse');
const APP_DIR = __dirname;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Ensure restrictive permissions on sensitive state files where we create them.
// Ignored on filesystems that don't support chmod (e.g. FAT32).
function chmodIfSupported(p, mode) {
  try { fs.chmodSync(p, mode); } catch (_) { /* ignore */ }
}

class ConfigError extends Error {
  constructor(message, source) {
    super(message);
    this.name = 'ConfigError';
    this.source = source;
  }
}

// Validate the shape enough to fail loudly on obvious typos (missing keys,
// wrong types). Critical: every numeric field consumed by setInterval/setTimeout
// or spawn() MUST be checked — otherwise missing/NaN values become 1-ms timers
// and flood the network.
function validateConfig(cfg, source) {
  const bad = (msg) => { throw new ConfigError(`${source}: ${msg}`, source); };
  const posInt = (n) => Number.isInteger(n) && n > 0;
  const posNum = (n) => Number.isFinite(n) && n > 0;

  if (!cfg || typeof cfg !== 'object') bad('not a JSON object');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) bad('port must be an integer 1-65535');
  if (typeof cfg.dbFile !== 'string' || !cfg.dbFile) bad('dbFile must be a non-empty string');
  if (!posNum(cfg.retentionDays)) bad('retentionDays must be a positive number');

  // ── ping ────────────────────────────────────────────────────────────────
  if (!cfg.ping || !Array.isArray(cfg.ping.targets) || cfg.ping.targets.length === 0) {
    bad('ping.targets must be a non-empty array');
  }
  if (!posInt(cfg.ping.intervalSec)) bad('ping.intervalSec must be a positive integer');
  if (!posInt(cfg.ping.timeoutMs)) bad('ping.timeoutMs must be a positive integer');
  for (const [i, t] of cfg.ping.targets.entries()) {
    if (!t || typeof t.host !== 'string' || !t.host) bad(`ping.targets[${i}].host must be a non-empty string`);
  }

  // ── speed ───────────────────────────────────────────────────────────────
  if (!cfg.speed) bad('speed section missing');
  if (typeof cfg.speed.testUrl !== 'string' || !cfg.speed.testUrl.startsWith('http')) {
    bad('speed.testUrl must be an http(s) URL');
  }
  if (!posInt(cfg.speed.intervalSec)) bad('speed.intervalSec must be a positive integer');
  if (!posInt(cfg.speed.timeoutSec)) bad('speed.timeoutSec must be a positive integer');
  if (!posInt(cfg.speed.bytes)) bad('speed.bytes must be a positive integer');
  if (!posNum(cfg.speed.thresholdMbps)) bad('speed.thresholdMbps must be > 0');

  // Optional: adaptive cadence (only validated when present + enabled)
  if (cfg.speed.adaptive) {
    const a = cfg.speed.adaptive;
    if (typeof a.enabled !== 'boolean') bad('speed.adaptive.enabled must be a boolean');
    if (a.enabled) {
      if (!posInt(a.minIntervalSec)) bad('speed.adaptive.minIntervalSec must be a positive integer');
      if (!posInt(a.maxIntervalSec)) bad('speed.adaptive.maxIntervalSec must be a positive integer');
      if (a.maxIntervalSec < a.minIntervalSec) bad('speed.adaptive.maxIntervalSec must be >= minIntervalSec');
    }
  }

  // Optional: idle gate (only validated when present + enabled)
  if (cfg.speed.idleGate) {
    const g = cfg.speed.idleGate;
    if (typeof g.enabled !== 'boolean') bad('speed.idleGate.enabled must be a boolean');
    if (g.enabled) {
      if (!posNum(g.thresholdKbps)) bad('speed.idleGate.thresholdKbps must be > 0');
      if (!posInt(g.sampleWindowSec)) bad('speed.idleGate.sampleWindowSec must be a positive integer');
    }
  }

  // ── ttfb ────────────────────────────────────────────────────────────────
  if (!cfg.ttfb) bad('ttfb section missing');
  if (!Array.isArray(cfg.ttfb.targets)) bad('ttfb.targets must be an array');
  if (!posInt(cfg.ttfb.intervalSec)) bad('ttfb.intervalSec must be a positive integer');
  if (!posInt(cfg.ttfb.timeoutSec)) bad('ttfb.timeoutSec must be a positive integer');
  for (const [i, t] of cfg.ttfb.targets.entries()) {
    if (!t || typeof t.url !== 'string' || !t.url.startsWith('http')) {
      bad(`ttfb.targets[${i}].url must be an http(s) URL`);
    }
  }
}

function loadConfig() {
  ensureDir(NETPULSE_DIR);
  const userCfg = path.join(NETPULSE_DIR, 'config.json');
  const defaultCfg = path.join(APP_DIR, 'config.default.json');
  const src = fs.existsSync(userCfg) ? userCfg : defaultCfg;

  let raw;
  try {
    raw = fs.readFileSync(src, 'utf8');
  } catch (e) {
    throw new ConfigError(`Failed to read ${src}: ${e.message}`, src);
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(
      `${src} is not valid JSON (${e.message}). ` +
      `Check for trailing commas or unquoted keys. ` +
      `Tip: delete the file and re-run install.sh to re-seed from defaults.`,
      src
    );
  }

  validateConfig(cfg, src);

  // Resolve relative dbFile to absolute under NETPULSE_DIR
  cfg.dbPath = path.isAbsolute(cfg.dbFile)
    ? cfg.dbFile
    : path.join(NETPULSE_DIR, cfg.dbFile);
  cfg._source = src;
  return cfg;
}

// Called by monitor.js / server.js at startup. Wraps loadConfig() with a
// user-friendly error handler that exits the process with code 2 rather than
// dumping a stack trace (which would just restart-loop under launchd/systemd).
function loadConfigOrDie() {
  try {
    return loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[fatal] ${e.message}`);
      console.error(`[fatal] Fix the above and restart. Logs live at $NETPULSE_DIR/logs/`);
    } else {
      console.error('[fatal]', e.stack || e.message);
    }
    // Exit code 2 = config error (distinguishable from crashes in launchd logs)
    process.exit(2);
  }
}

module.exports = {
  HOME,
  NETPULSE_DIR,
  APP_DIR,
  ConfigError,
  loadConfig,
  loadConfigOrDie,
  ensureDir,
  chmodIfSupported,
};
