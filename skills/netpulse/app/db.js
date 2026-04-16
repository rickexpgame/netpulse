// SQLite setup. WAL mode so the writer (monitor) and reader (server) share
// the file without locking each other out.
const fs = require('fs');
const Database = require('better-sqlite3');

function openDb(dbPath) {
  // Restrictive perms: samples may reveal browsing patterns on shared hosts.
  // Apply BEFORE first open so the file is born private. We also re-apply after
  // open in case better-sqlite3 recreated the file with the process umask.
  const existed = fs.existsSync(dbPath);
  const db = new Database(dbPath);
  try { fs.chmodSync(dbPath, 0o600); } catch (_) { /* filesystem may not support chmod */ }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  // WAL creates side-files -wal and -shm; tighten those too.
  for (const suffix of ['-wal', '-shm']) {
    try { fs.chmodSync(dbPath + suffix, 0o600); } catch (_) {}
  }
  if (!existed) {
    console.log(`[db]     Created ${dbPath} (mode 600)`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pings (
      ts         INTEGER NOT NULL,
      target     TEXT    NOT NULL,
      latency_ms REAL,
      lost       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pings_ts ON pings(ts);

    CREATE TABLE IF NOT EXISTS speed_samples (
      ts           INTEGER NOT NULL,
      bytes        INTEGER NOT NULL,
      duration_ms  INTEGER NOT NULL,
      mbps         REAL    NOT NULL,
      passed       INTEGER NOT NULL,
      failed       INTEGER NOT NULL DEFAULT 0,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_speed_ts ON speed_samples(ts);

    CREATE TABLE IF NOT EXISTS ttfb (
      ts      INTEGER NOT NULL,
      target  TEXT    NOT NULL,
      ttfb_ms REAL,
      failed  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ttfb_ts ON ttfb(ts);
  `);

  return db;
}

function pruneOldRows(db, retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400_000;
  const a = db.prepare('DELETE FROM pings         WHERE ts < ?').run(cutoff);
  const b = db.prepare('DELETE FROM speed_samples WHERE ts < ?').run(cutoff);
  const c = db.prepare('DELETE FROM ttfb          WHERE ts < ?').run(cutoff);
  return a.changes + b.changes + c.changes;
}

module.exports = { openDb, pruneOldRows };
