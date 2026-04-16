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
// wrong types), but keep the check shallow — users adding new ping targets
// or tuning thresholds shouldn't need to update code.
function validateConfig(cfg, source) {
  const bad = (msg) => { throw new ConfigError(`${source}: ${msg}`, source); };

  if (!cfg || typeof cfg !== 'object') bad('not a JSON object');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) bad('port must be an integer 1-65535');
  if (typeof cfg.dbFile !== 'string' || !cfg.dbFile) bad('dbFile must be a non-empty string');
  if (!cfg.ping || !Array.isArray(cfg.ping.targets) || cfg.ping.targets.length === 0) {
    bad('ping.targets must be a non-empty array');
  }
  for (const [i, t] of cfg.ping.targets.entries()) {
    if (!t || typeof t.host !== 'string' || !t.host) bad(`ping.targets[${i}].host must be a non-empty string`);
  }
  if (!Number.isFinite(cfg.ping.intervalSec) || cfg.ping.intervalSec < 1) bad('ping.intervalSec must be >= 1');
  if (!cfg.speed || typeof cfg.speed.testUrl !== 'string') bad('speed.testUrl must be a string URL');
  if (!Number.isFinite(cfg.speed.thresholdMbps) || cfg.speed.thresholdMbps <= 0) {
    bad('speed.thresholdMbps must be > 0');
  }
  if (!cfg.ttfb || !Array.isArray(cfg.ttfb.targets)) bad('ttfb.targets must be an array');
  if (!Number.isFinite(cfg.retentionDays) || cfg.retentionDays < 1) bad('retentionDays must be >= 1');
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
