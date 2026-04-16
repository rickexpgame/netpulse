// Single entry point. Run with: node start.js
// Both monitor and server open their own better-sqlite3 handle; WAL mode
// serializes correctly within the same process.
require('./monitor');
require('./server');
