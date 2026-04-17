# Advanced: customization, extension, integration

## Custom targets

Edit `~/.netpulse/config.json`, then `stop.sh && start-bg.sh`.

### Add a ping target

```json
"ping": {
  "targets": [
    { "host": "8.8.8.8",   "label": "Google DNS" },
    { "host": "gateway.local",  "label": "Local router" },
    { "host": "work-vpn.example.com", "label": "VPN" }
  ]
}
```

The `host` is passed straight to `ping` — hostnames and IPs both work. Label is only used in the dashboard (and your own recognition).

### Add a TTFB target (site responsiveness)

```json
"ttfb": {
  "targets": [
    { "url": "https://news.ycombinator.com/", "label": "HN" },
    { "url": "https://github.com/",           "label": "GitHub" }
  ]
}
```

TTFB uses `curl -I` (HEAD) so it's cheap — a few KB per probe. Don't add more than ~5 targets or one slow target will back up the loop.

## Choosing targets thoughtfully

**Good baseline set** (what ships by default):
- `8.8.8.8` Google DNS — global
- `1.1.1.1` Cloudflare DNS — global, different backbone
- `9.9.9.9` Quad9 DNS — third global, different backbone

Three globally-distributed, independently-routed, ICMP-friendly targets. When they all agree on "healthy", you can trust it.

**Targets to add**:
- Your **router's LAN IP** (`192.168.1.1` or similar) → measures Wi-Fi / last-hop health in isolation. If this is bad but global DNS is fine, your Wi-Fi is the problem.
- Your **ISP's gateway** (find it with `traceroute` — usually the 2nd or 3rd hop) → isolates ISP access vs upstream.
- A host you **actually use** that feels slow → turns the vague "Slack is laggy" into data.

**Targets to avoid**:
- Hosts that **rate-limit ICMP** (some cloud providers, some popular sites) — you'll see phantom "loss" that doesn't match real experience. `baidu.com` is a notorious example.
- Hosts behind **anycast with aggressive regional shifting** — the ping bounces between different edge servers and jitter looks terrible.
- Hosts that may **block you** if they notice constant ping traffic.

## Tuning intervals

The default 10 s ping / 10 min speed / 10 min TTFB is a sweet spot:

- **Finer pings** (5 s): catches shorter outages, 2× data but still < 5 MB/day.
- **More frequent speed tests** (5 min): doubles total data to ~300 MB/day. Noticeable on metered connections.
- **Less frequent** (60 min speed): suitable for long-term trend monitoring where 10-min resolution is overkill. Total ~25 MB/day.

```json
"ping":  { "intervalSec": 5 },
"speed": { "intervalSec": 1800 },     // every 30 min
"ttfb":  { "intervalSec": 1800 }
```

## Idle gate + adaptive cadence (new in v1.0.3)

The speed probe doesn't fire blindly every 10 minutes. Two optimisations decide when it actually runs:

### Idle gate

Before each speed probe, netpulse reads your default interface's NIC counters, waits 3 seconds, reads again. If the observed throughput exceeds a threshold (default **500 kbps**), the probe is skipped that cycle — netpulse will not compete with your own active traffic.

```jsonc
"speed": {
  "idleGate": {
    "enabled": true,        // set false to always probe
    "thresholdKbps": 500,   // raise if you do background sync all day
    "sampleWindowSec": 3    // seconds of observation before deciding
  }
}
```

**Important caveats** (explicit because they affect how to reason about results):

- The idle gate sees *this machine's* NIC. It **cannot** detect a colleague's video call on another device on the same LAN. If you need LAN-wide idle awareness, either run netpulse on a dedicated always-idle machine, or raise `thresholdKbps` high enough to tolerate ambient LAN traffic.
- Default-interface detection is best-effort. If you're on a VPN (utun / tun) or using Docker, the route might point to an interface that doesn't reflect real WAN usage. `scripts/status.sh` shows the chosen interface when available; disable the gate if the pick is wrong.
- NIC counters can wrap/reset on link flap or reboot; netpulse treats a negative delta as "unknown" and fails open (runs the probe).

### Adaptive cadence

When the link is consistently healthy, the probe interval doubles. When something degrades, it resets.

```jsonc
"speed": {
  "intervalSec": 600,       // default cadence (starting point)
  "adaptive": {
    "enabled": true,
    "minIntervalSec": 300,  // floor after any failure
    "maxIntervalSec": 3600  // ceiling when consistently healthy
  }
}
```

Rules:
- 3 consecutive probes with mbps ≥ **2× threshold** → interval doubles (up to max)
- Any failure or mbps < threshold → interval resets to `minIntervalSec`
- On a healthy 1 Gb residential link, you'll typically see the cadence ramp from 10 min → 20 min → 40 min → 1 h within half a day.

### Disabling either

```jsonc
"speed": {
  "idleGate": { "enabled": false },
  "adaptive": { "enabled": false }
}
```

When both are off, behaviour matches v1.0.2 exactly: fixed-cadence probe every `intervalSec` seconds.

## Changing the threshold

The threshold defines "does this qualify as usable?":

| Use case | Suggested threshold |
|---|---|
| Web browsing only | 2 Mbps |
| 1080p streaming | 5 Mbps (default) |
| 4K streaming | 15 Mbps |
| Simultaneous 4K + calls + downloads | 25 Mbps |
| Professional uplink for remote work | 50 Mbps |

```json
"speed": { "thresholdMbps": 25 }
```

## Changing the speed test endpoint

The default uses `speed.cloudflare.com/__down?bytes=N` which is free, reliable, globally-anycast, and supports arbitrary byte counts. Alternatives:

- **Self-hosted**: `https://yourserver.com/blob-1mb.bin` if you have a nearby server. Removes Cloudflare as a confounder.
- **Different CDN**: `https://speedtest.tele2.net/1MB.zip` (free, but less anycast).
- **Larger file** for more stable measurement: change `bytes` to 5 MB (5242880) and `testUrl` to match.

```json
"speed": {
  "testUrl": "https://speed.cloudflare.com/__down?bytes=5242880",
  "bytes":   5242880
}
```

Larger files reduce TCP-slow-start noise but multiply data usage.

## Data retention

Default 30 days. Observations:

- **Disk usage**: a packed day of data is ~1 MB. A year is ~400 MB. SQLite compresses well; not a concern.
- **Query speed**: indexes on `ts` keep 30-day queries sub-100 ms. 365 days still OK.
- **Useful window**: longitudinal issues (ISP gradually getting worse) take weeks to spot. Consider 90 days for that.

```json
"retentionDays": 90
```

## JSON output for automation

`analyze.py --json` emits a structured snapshot:

```json
{
  "span": { "start": "...", "end": "...", "hours": 47.2 },
  "samples": { "pings": 66736, "speed": 280, "ttfb": 840 },
  "latency_distribution": [
    { "target": "8.8.8.8", "p50_ms": 8.1, "p90_ms": 53.6, ... }
  ],
  "speed": { "total": 280, "passed": 278, "mbps_median": 63.1, ... },
  "correlation": { "pivot": "baidu.com", "others": [...] }
}
```

Pipe into `jq`, post to a webhook, or feed to another agent:

```bash
analyze.py --json | jq '.latency_distribution[] | select(.loss_pct > 1)'
```

## Integrating with external monitoring

netpulse's SQLite can be scraped by anything that reads SQL.

### Prometheus exporter (bring your own)

A ~50-line Python script can query the DB and emit Prometheus metrics on a different port:

```python
from prometheus_client import start_http_server, Gauge
# SELECT latency P50, P99, loss %, mbps median from the last minute
# Expose as net_p50_ms, net_p99_ms, net_loss_pct, net_mbps_median
```

Skeleton lives in SQLite; build the exporter per your needs.

### Direct queries

```bash
sqlite3 ~/.netpulse/data.db "
  SELECT strftime('%H', ts/1000, 'unixepoch', 'localtime') AS hour,
         AVG(latency_ms) AS avg_ms,
         SUM(lost)*1.0/COUNT(*) AS loss
  FROM pings WHERE ts > strftime('%s', 'now', '-7 days') * 1000
  GROUP BY hour ORDER BY hour;
"
```

## Running multiple instances

Rare but supported. Each needs its own `NETPULSE_DIR` and port:

```bash
NETPULSE_DIR=~/.netpulse-work PORT=8090 scripts/start-fg.sh
```

Different configs (different targets, different thresholds) for different contexts.

## When things go wrong

**`npm install` fails**
Native compile needs a toolchain. Install:
- macOS: `xcode-select --install`
- Debian/Ubuntu: `sudo apt install build-essential`
- Fedora: `sudo dnf groupinstall "Development Tools"`

**Monitor crashes repeatedly**
Check `~/.netpulse/logs/netpulse.log`. Common causes:
- Disk full — data.db write fails
- Config JSON syntax error — check with `jq . < ~/.netpulse/config.json`
- Missing `curl` or `ping` on PATH

**Dashboard shows no data**
- Confirm daemon running: `scripts/status.sh`
- Confirm port listening: `lsof -iTCP:8089 -sTCP:LISTEN`
- First speed sample takes 10 min; ping data appears in 10 s.

**Port 8089 taken**
Change `"port"` in config.json, restart.
