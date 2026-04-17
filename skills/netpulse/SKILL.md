---
name: netpulse
description: Lightweight 24/7 network stability & speed monitor with live web dashboard. Continuously pings targets (~2MB/day), periodically measures download throughput (~150MB/day total), serves charts at localhost:8089, and generates deep-dive Markdown reports. Cross-platform (macOS/Linux; Windows via WSL). Use this skill when the user says '监控网络', '网络稳定性', '网络测速', '24小时测网速', '持续测速', '测网络', 'monitor my network', 'network dashboard', 'is my internet stable', 'check internet over time', 'diagnose network issues', 'netpulse', or describes ongoing network issues and wants to diagnose them across hours or days instead of running a one-shot speedtest.
user_invocable: true
version: "1.0.3"
---

# netpulse — network stability & speed monitor

## The claim

**"Is my network usable?" is a better question than "how fast is my network?".** Speeds swing by 2–3× between minute-to-minute — what actually hurts is unstable latency, bursty loss, and degradation during specific hours. Single-shot tests miss all of that.

netpulse runs three lightweight loops forever:

- **Ping** every 10 s to 3 global targets → catches latency drift & packet loss
- **Speed** every 10 min (baseline) — downloads a **1 MB** file and records Mbps → checks whether the link *meets a usability threshold* (default 5 Mbps for smooth 1080p), **not** how fast it can possibly go. Two optimisations on top:
  - **Idle gate** — before each probe, sample local NIC throughput. If you're actively using the network (> 500 kbps), the probe is skipped that cycle. Keeps netpulse from competing with your own video calls / downloads.
  - **Adaptive cadence** — three consecutive healthy probes (≥ 2× threshold) → interval doubles, up to 1 hour. Any degraded/failed probe → reset to 5 min. Cuts daily probe volume by 50–80% on consistently-healthy links.
- **TTFB** every 10 min to 3 popular sites → reflects "how snappy does the web feel"

All samples land in a local SQLite file (`~/.netpulse/data.db`). A built-in web dashboard (`http://localhost:8089`) plots 1 h / 6 h / 24 h / 7 d trends. A Python analyzer emits a publishable Markdown report.

## When to use this skill

**Use it when** the user:

- Suspects their network is flaky but single-shot speedtests "look fine"
- Wants evidence across a day/week, not a moment
- Is debugging intermittent issues (dropouts, slow-loading pages at specific hours)
- Explicitly mentions netpulse, or asks for a "network dashboard" / "continuous speedtest" / "网络稳定性监控"
- Asks to "analyze my network" after running it for a while

**Do NOT use it when** the user:

- Wants a single-shot speedtest (`speedtest-cli`, `fast.com` are better — this takes 10 minutes to produce a first data point)
- Needs per-application bandwidth accounting (use `nettop`, `iftop`, or Little Snitch instead)
- Wants to intercept or shape traffic (wrong tool)

## Quick start — the happy path

From a fresh install, assuming the user said "set up netpulse" or equivalent, run the lifecycle scripts using their **absolute paths** (the skill's install location — resolve it from this SKILL.md's directory; don't rely on `$0` since the agent shell context may have that as the shell name):

```bash
# Substitute <skill-dir> with the absolute path to this skill's folder,
# e.g. ~/.claude/plugins/cache/netpulse/netpulse/1.0.2/skills/netpulse
bash <skill-dir>/scripts/install.sh      # seeds ~/.netpulse + npm install
bash <skill-dir>/scripts/start-bg.sh     # registers launchd / systemd / nohup
```

Then tell the user the dashboard is at `http://127.0.0.1:8089/` (macOS: offer to `open` it; Linux: suggest `xdg-open`).

Data starts flowing in ~10 s (first ping) and the first speed sample appears after ~10 min.

## Lifecycle commands

| Intent | Command |
|---|---|
| Install dependencies + seed config | `scripts/install.sh` |
| Run in foreground (for debugging) | `scripts/start-fg.sh` (Ctrl+C stops) |
| Start persistently, survives reboot | `scripts/start-bg.sh` (recommended) |
| Check health / running / sample counts | `scripts/status.sh` |
| Stop the service | `scripts/stop.sh` |
| Deep-dive Markdown report | `scripts/analyze.py` |
| JSON for further processing | `scripts/analyze.py --json` |
| Analyze only the last 24 h | `scripts/analyze.py --range 24h` |
| Full removal (keeps state by default) | `scripts/uninstall.sh` |
| Full removal **including** data/config | `scripts/uninstall.sh --purge` |

`start-bg.sh` auto-detects the best persistence mechanism:
- **macOS** → `~/Library/LaunchAgents/com.netpulse.plist` (launchd)
- **Linux** → `~/.config/systemd/user/netpulse.service` (systemd --user)
- **fallback** → `nohup` + pidfile at `~/.netpulse/netpulse.pid`

## User intent → what to run

When a user expresses one of these intents, run the corresponding action. Always offer to open the dashboard URL after starting.

| User says… | Do this |
|---|---|
| "Set up / start monitoring" | `install.sh` (if first run) → `start-bg.sh` → tell them the dashboard URL and that first speed sample takes 10 min |
| "How's it going?" / "Status?" | `status.sh` |
| "Show me the dashboard" | Print `http://127.0.0.1:8089/` (and platform-appropriate opener if you're confident) |
| "Analyze my network" / "Report" | `analyze.py` → render the returned Markdown inline |
| "Only show me the last N hours" | `analyze.py --range Nh` |
| "Is my internet stable?" | `analyze.py --range 24h`, then synthesize: read the `Overall:` line + worst loss target |
| "Stop monitoring" | `stop.sh` |
| "Remove netpulse" | `uninstall.sh` (then suggest `claude plugin remove netpulse` for the plugin itself) |
| "Wipe everything including data" | `uninstall.sh --purge` (confirm first — data is non-recoverable) |

If the user asks "what's my network doing right now?" and the DB has less than 30 min of data, tell them so — you don't have enough samples for a meaningful analysis yet. The monitor is cheap to leave running; suggest coming back in a few hours.

## How to interpret results

netpulse produces numbers; this section teaches Claude to turn them into diagnosis. Prefer this reasoning over parroting raw tables.

### The single most important distinction

**Is a bad number's cause shared across targets, or target-specific?**

- **Multiple targets degrade in sync** → local issue: your router, your ISP's last mile, your Wi-Fi. Fixable on your end.
- **One target degrades alone** → upstream path problem. Not your fault, not your fix. Common: ICMP rate-limiting, ISP international peering congestion, routing to a specific region.

`analyze.py` computes this as the **Correlation** section. Always read it before blaming the user's hardware.

### Latency percentiles

Stare at P90 and P99, not the mean. Healthy home internet:
- **P50 < 30 ms** to global DNS (8.8.8.8, 1.1.1.1)
- **P99 < 200 ms** — rare spikes are normal, but should be rare
- **Loss < 1 %** per target

If P50 is great (e.g. 8 ms) but P99 is 500 ms, the "experience" will feel inconsistent — that tail is what the user actually notices.

### Loss patterns

- **Steady-state loss** (gaps between loss minutes > 10 min, evenly spaced) → noisy link, could be Wi-Fi interference or MTU mismatch.
- **Bursty loss** (gap median < 5 min, clustered) → congestion. Happens especially during peak hours (evenings). Usually upstream.
- **Loss < 0.5 %** spread evenly → noise floor; don't worry.

### Speed variance

A coefficient of variation (stdev/mean) above 30 % usually means the CDN edge server is shifting or there's congestion on the path. Threshold pass-rate is what matters, not peak speed.

### Time-of-day patterns

The **hourly heatmap** in `analyze.py` output is gold. If you see loss/latency climb at 19:00–23:00 local time, that's classic peak-hour ISP congestion on upstream links. Compare with a "control" target (global DNS) that stays stable during the same hours to confirm it's path-specific.

### What "degraded" actually means for the user

The health tier in `/api/summary` uses these thresholds:

| Tier | Condition |
|---|---|
| **green** | last-hour loss < 1 % AND pass-rate ≥ 95 % AND avg latency < 100 ms |
| **yellow** | loss < 5 % AND pass-rate ≥ 70 % AND avg latency < 200 ms |
| **red** | anything worse |

Don't panic-report "red" without checking which dimension failed. A single bad target can't pull the whole tier down — but a 2-minute outage just ended can.

For a richer interpretation walkthrough, see `references/interpretation.md`.

## Customization

The user's config lives at `~/.netpulse/config.json` (seeded from `app/config.default.json` on first install). The service re-reads it on restart; edit + `stop.sh && start-bg.sh` to apply.

Common changes:

- **Add a target the user actually cares about**: append `{"host": "example.com", "label": "My site"}` to `ping.targets` or `{"url": "https://…/", "label": "…"}` to `ttfb.targets`
- **Higher quality bar**: `speed.thresholdMbps` to 10 or 25
- **Tighter data**: `ping.intervalSec` to 5 (2× data, still negligible flow)
- **Less storage**: `retentionDays` to 7
- **Different port**: `port` (if 8089 is taken)

See `references/advanced.md` for multi-target strategies, exporting to Prometheus, and adding new site-specific probes.

## Platform notes

- **macOS & Linux**: native, works out-of-the-box on Node 18+.
- **Windows**: Untested. Should work under WSL. `ping` flag differences would need handling for native Windows (use WSL for now).
- **Requires**: `node` ≥18, `curl`, `ping` (all common). `better-sqlite3` compiles natively on install — macOS uses Xcode CLT, Linux needs `gcc` + `make`.
- **Firewall**: Dashboard binds to `127.0.0.1` only. Never exposes itself to the network. If you want remote access, put it behind your own auth-aware reverse proxy.

## Known pitfalls

1. **First speed sample takes ~10 min**. Users impatiently re-running `status.sh` may assume it's broken. It isn't — `ping` data populates immediately.
2. **`baidu.com` — or any ICMP-rate-limited host — looks catastrophic in ping data.** That target may show 10 %+ loss while everything else is perfect. It's not your network. If the user has such a target in their config, inform them before drawing conclusions.
3. **TTFB vs ping mismatch**. Cloudflare DNS (1.1.1.1) might ping in 5 ms while `https://www.cloudflare.com/` has 400 ms TTFB. The gap is TLS handshake + app logic on their end, not your link.
4. **System sleep**. On a laptop, sleep stops the daemon's measurements — there'll be a gap in the timeline, not bad data. Mention this if analyzing overnight data and there's an obvious hole matching the user's sleep hours.
5. **`npm install` on first run** compiles native code. If it fails, the error is usually missing `gcc`/`make` on Linux or missing Xcode CLT on macOS. Suggest the fix explicitly.
6. **Idle gate is local-only, not LAN-wide.** The idle gate sees *this machine's* NIC counters only. It cannot detect a housemate's video call on another device sharing the same uplink. The right mental model: "don't compete with *my own* traffic" — not "never probe while anyone on the LAN is using the network". If that's a hard requirement, either run netpulse on a machine that's always idle (e.g. an always-on server), or raise `speed.idleGate.thresholdKbps` higher.
7. **Adaptive cadence means speed samples are sparse when things are good.** If the dashboard shows few dots for several hours, that's not a bug — it means the network passed threshold repeatedly and netpulse backed off. When something degrades, cadence snaps back to 5 min automatically.
8. **Default-interface detection can pick VPN / utun / docker interfaces** when those own the default route. `scripts/status.sh` prints the chosen interface on recent runs; if it's wrong, disable idle gate in config.

## Philosophy

This skill rejects three common patterns:

- **Single-shot speedtests** — they measure peak throughput at one moment, which is not what the user experiences across a day.
- **"Saturate the link" bandwidth testing** — it's rude to the user's current work and unnecessary for the question "is the link usable?".
- **Overbuilt monitoring stacks** — Prometheus + Grafana + Alertmanager for a home network is four orders of magnitude too much. SQLite + Chart.js + 300 lines of Node does everything a human actually needs.

The total data footprint is ~150 MB/day and the dashboard tells you more than most ISP-provided tools.

## Structure

```
skills/netpulse/
├── SKILL.md                 (you are here)
├── app/                     Node.js monitor (read-only on install)
│   ├── config.default.json  seeded to ~/.netpulse/config.json
│   ├── monitor.js           ping + speed + ttfb daemon
│   ├── server.js            HTTP + JSON API + static dashboard
│   ├── start.js             combined entry
│   ├── db.js                SQLite schema + pruning
│   ├── paths.js             single source of truth for locations
│   └── public/index.html    Chart.js dashboard
├── scripts/                 lifecycle (bash + python)
│   ├── install.sh           seed config, npm install, sanity checks
│   ├── start-fg.sh          foreground
│   ├── start-bg.sh          launchd / systemd / nohup autoselect
│   ├── stop.sh              mirror of start-bg
│   ├── status.sh            introspection
│   ├── uninstall.sh         reverses start-bg; --purge wipes state
│   └── analyze.py           deep report (Markdown or JSON)
└── references/
    ├── interpretation.md    how to read percentiles, patterns, correlations
    └── advanced.md          custom targets, exporting, integrations
```
