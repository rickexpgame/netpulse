# netpulse

A lightweight network stability & speed monitor that runs 24/7 on your machine, packaged as a [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin.

> **"Is my network usable?"** is a better question than **"how fast is my network?"**
> Speeds swing 2–3× minute to minute. What actually hurts is unstable latency, bursty loss, and degradation at specific hours. Single-shot speedtests miss all of that.

## What it does

| Loop | Interval | Purpose | Traffic |
|---|---|---|---|
| **Ping** | every 10 s | Latency & packet loss to 3 global targets | ~2 MB/day |
| **Speed** | every 10 min | Does the link still meet your usability threshold (default 5 Mbps)? Downloads a 1 MB file — never saturates your connection | ~150 MB/day |
| **TTFB** | every 10 min | How snappy do pages actually feel? | negligible |

All samples land in a local SQLite database. A built-in dashboard at `http://localhost:8089` shows 1 h / 6 h / 24 h / 7 d trends. A Python analyzer produces a Markdown report you can paste anywhere.

The dashboard shows four sections — a 4-card status bar (Health / Latency / Packet Loss / Speed), then stacked charts for latency lines per target, bucketed packet-loss bars, speed-sample scatter with threshold line, and TTFB-per-site trends. Dark theme, mobile-responsive.

## One-click install (for Claude Code users)

```bash
claude plugin add github:rickexpgame/netpulse
```

Then, in Claude Code, say something like:

> Set up netpulse and start monitoring my network.

Claude picks up the skill and handles installation, background persistence (launchd on macOS, systemd on Linux), and opening the dashboard.

When you want a report:

> Analyze my network.

## Manual install (without Claude Code)

```bash
git clone https://github.com/rickexpgame/netpulse.git
cd netpulse/skills/netpulse
./scripts/install.sh
./scripts/start-bg.sh
open http://127.0.0.1:8089
```

Requires Node 18+, `curl`, `ping`. Works on macOS and Linux. Windows via WSL.

## Reading the data

After ~1 hour you'll have enough data for a first look. After 24+ hours the hourly pattern (peak-hour congestion, overnight drift) becomes visible.

```bash
./scripts/analyze.py              # full Markdown report
./scripts/analyze.py --range 24h  # last 24 hours only
./scripts/analyze.py --json       # structured for automation
```

The analyzer's core move: if a target's loss correlates < 30% with other targets, it's **path-specific** (upstream problem, not your fault). If it correlates > 50%, it's a **local or ISP issue** worth acting on.

## Customize

Edit `~/.netpulse/config.json`:

```jsonc
{
  "speed": { "thresholdMbps": 25 },          // 4K streaming standard
  "ping": {
    "targets": [
      { "host": "8.8.8.8",        "label": "Google DNS" },
      { "host": "192.168.1.1",    "label": "My router" },
      { "host": "my-vpn.example", "label": "Work VPN" }
    ]
  }
}
```

Then `./scripts/stop.sh && ./scripts/start-bg.sh` to apply.

See [`skills/netpulse/references/advanced.md`](skills/netpulse/references/advanced.md) for the full knobs (intervals, retention, speed test endpoint, Prometheus export).

## Uninstall

```bash
./scripts/uninstall.sh            # stops service, keeps state
./scripts/uninstall.sh --purge    # also wipes ~/.netpulse
claude plugin remove netpulse     # remove the plugin itself
```

## Design choices

- **Speed "sufficiency" over "peak"**. Downloading 1 MB tells you "does this link clear X Mbps?" — it doesn't saturate your connection. Peak-throughput testing rudely competes with the user's actual work.
- **SQLite, not Prometheus**. For a home network, four orders of magnitude less overhead. 300 lines of Node + Chart.js does everything a human actually needs.
- **No cloud dependency**. Everything local — the dashboard binds to `127.0.0.1` only. Nothing phones home.
- **Cross-platform persistence**. `start-bg.sh` auto-selects launchd / systemd / nohup.

## Architecture

```
skills/netpulse/
├── SKILL.md              # Teaches Claude when/how to use this
├── app/                  # The monitor itself
│   ├── monitor.js        # ping/speed/ttfb daemons
│   ├── server.js         # HTTP + JSON API + dashboard
│   └── public/index.html # Chart.js frontend
├── scripts/              # Lifecycle: install / start / stop / analyze
└── references/           # Deep guides loaded as-needed
```

State lives in `~/.netpulse/` (config, database, logs). The plugin cache is read-only — updates never clobber your data.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome at [github.com/rickexpgame/netpulse](https://github.com/rickexpgame/netpulse).
