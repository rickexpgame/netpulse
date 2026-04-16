// Central path resolution. Every module imports from here so state locations
// are defined in exactly one place.
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

function loadConfig() {
  ensureDir(NETPULSE_DIR);
  const userCfg = path.join(NETPULSE_DIR, 'config.json');
  const defaultCfg = path.join(APP_DIR, 'config.default.json');
  const src = fs.existsSync(userCfg) ? userCfg : defaultCfg;
  const raw = fs.readFileSync(src, 'utf8');
  const cfg = JSON.parse(raw);
  // Resolve relative dbFile to absolute under NETPULSE_DIR
  cfg.dbPath = path.isAbsolute(cfg.dbFile)
    ? cfg.dbFile
    : path.join(NETPULSE_DIR, cfg.dbFile);
  return cfg;
}

module.exports = {
  HOME,
  NETPULSE_DIR,
  APP_DIR,
  loadConfig,
  ensureDir,
};
