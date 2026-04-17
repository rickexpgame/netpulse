// Interface throughput utilities — used by the speed loop's idle gate.
//
// Caveats (important, surfaced to docs too):
//   - Counters reflect THIS machine's NIC only. They cannot see a colleague's
//     video call on a different device sharing the same LAN / uplink. Idle
//     gating is a defence against netpulse competing with *your own* active
//     usage; it is not a full LAN-awareness scheme.
//   - Default-interface detection is best-effort. VPN tunnels (utun*, tun*),
//     Docker bridges (docker0, br-*), and link-level interfaces (anpi*, awdl0)
//     can all appear as defaults depending on state. We resolve by route
//     lookup; if that fails the probe runs unconditionally (fail-open).
//   - /proc/net/dev and `netstat -I` counters wrap/reset on link flap or
//     reboot. We handle negative deltas by reporting "unknown" and letting
//     the caller fail open.
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const PLATFORM = os.platform();

function execFileP(cmd, args, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    child.on('error', reject);
  });
}

// Default-route interface. Returns null on any failure — caller fails open.
async function getDefaultInterface() {
  try {
    if (PLATFORM === 'darwin') {
      const out = await execFileP('route', ['-n', 'get', 'default']);
      const m = out.match(/interface:\s*(\S+)/);
      return m ? m[1] : null;
    }
    if (PLATFORM === 'linux') {
      // Prefer iproute2; fall back to /proc/net/route if ip is missing.
      try {
        const out = await execFileP('ip', ['-o', 'route', 'show', 'to', 'default']);
        const m = out.match(/\bdev\s+(\S+)/);
        if (m) return m[1];
      } catch (_) { /* fall through */ }
      try {
        const data = fs.readFileSync('/proc/net/route', 'utf8');
        // Rows look like: "eth0  00000000  0102A8C0  0003  0  0  0  00000000  0  0  0"
        // Destination of 0 = default route.
        for (const line of data.split('\n').slice(1)) {
          const cols = line.trim().split(/\s+/);
          if (cols[1] === '00000000') return cols[0];
        }
      } catch (_) {}
    }
  } catch (_) { /* swallow */ }
  return null;
}

// Current cumulative RX+TX byte counters for `iface`, or null on failure.
async function readInterfaceBytes(iface) {
  try {
    if (PLATFORM === 'linux') {
      const data = fs.readFileSync('/proc/net/dev', 'utf8');
      const line = data.split('\n').find((l) => l.trim().startsWith(iface + ':'));
      if (!line) return null;
      const cols = line.split(':')[1].trim().split(/\s+/);
      return { rx: parseInt(cols[0], 10), tx: parseInt(cols[8], 10) };
    }
    if (PLATFORM === 'darwin') {
      // netstat -I en0 -b — 2nd row is the <Link#N> entry (link-level counters).
      // Cols (0-indexed): 0 Name 1 Mtu 2 Network 3 Address 4 Ipkts 5 Ierrs
      //                   6 Ibytes 7 Opkts 8 Oerrs 9 Obytes 10 Coll
      const out = await execFileP('netstat', ['-I', iface, '-b']);
      const lines = out.trim().split('\n');
      if (lines.length < 2) return null;
      // Find the row where col[2] starts with "<Link#" — that's the link-level row.
      for (const line of lines.slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 10 && cols[2] && cols[2].startsWith('<Link#')) {
          const rx = parseInt(cols[6], 10);
          const tx = parseInt(cols[9], 10);
          if (Number.isFinite(rx) && Number.isFinite(tx)) return { rx, tx };
        }
      }
      return null;
    }
  } catch (_) { /* swallow */ }
  return null;
}

// sampleThroughputKbps — take two readings `sampleSec` apart on the default
// interface and return the aggregate (rx+tx) throughput in kilobits/second,
// or null if unmeasurable. Caller treats null as "unknown → don't gate".
async function sampleThroughputKbps(sampleSec) {
  const iface = await getDefaultInterface();
  if (!iface) return { iface: null, kbps: null };
  const before = await readInterfaceBytes(iface);
  if (!before) return { iface, kbps: null };
  await new Promise((r) => setTimeout(r, sampleSec * 1000));
  const after = await readInterfaceBytes(iface);
  if (!after) return { iface, kbps: null };
  const deltaBytes = (after.rx + after.tx) - (before.rx + before.tx);
  if (deltaBytes < 0) return { iface, kbps: null };  // counter wrapped
  const kbps = deltaBytes * 8 / 1000 / sampleSec;
  return { iface, kbps };
}

// isInterfaceBusy — true if throughput over sampleSec exceeds thresholdKbps.
// Returns false (NOT busy) on any measurement failure so the probe can run
// anyway. Fail-open is preferred because the whole purpose is to skip when
// measurably busy — uncertainty should not silently halt monitoring.
async function isInterfaceBusy(thresholdKbps, sampleSec) {
  const { iface, kbps } = await sampleThroughputKbps(sampleSec);
  if (kbps == null) return { busy: false, iface, kbps: null };
  return { busy: kbps > thresholdKbps, iface, kbps };
}

module.exports = {
  getDefaultInterface,
  readInterfaceBytes,
  sampleThroughputKbps,
  isInterfaceBusy,
};
