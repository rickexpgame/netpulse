#!/usr/bin/env python3
"""
netpulse analyze — deep-dive report from accumulated data.

Emits a Markdown report covering:
  1. Latency distribution per target (P50/P90/P99)
  2. Time-of-day pattern — hourly heatmap surfacing peak congestion
  3. Loss clustering — bursty vs steady-state
  4. Cross-target correlation — is a bad target's fault shared or local?
  5. Speed distribution — threshold pass rate, variance
  6. TTFB stability
  7. Worst 5 windows (non-outlier target)

Run directly:   ./scripts/analyze.py
From a skill:   python3 scripts/analyze.py [--range 24h|7d|all] [--json]

Design: pure stdlib (no pandas) so it runs anywhere Python 3 is available.
"""
import sqlite3, statistics, datetime, os, sys, json, argparse, pathlib


def ms_to_dt(ms):
    return datetime.datetime.fromtimestamp(ms / 1000)


def percentile(sorted_values, pct):
    """Linear-interpolated quantile. Matches numpy's default 'linear' method.
    Unlike nearest-rank, this gives sensible answers on sparse data:
      values=[1, 100], pct=50 → 50.5 (midpoint), not 100."""
    if not sorted_values:
        return None
    n = len(sorted_values)
    if n == 1:
        return sorted_values[0]
    # k in [0, n-1]; fractional position on the sorted index line
    k = (n - 1) * (pct / 100.0)
    f = int(k)           # lower index
    c = min(f + 1, n - 1)  # upper index
    if f == c:
        return float(sorted_values[f])
    return sorted_values[f] + (sorted_values[c] - sorted_values[f]) * (k - f)


def resolve_db_path():
    netpulse_dir = os.environ.get("NETPULSE_DIR") or os.path.expanduser("~/.netpulse")
    cfg_path = pathlib.Path(netpulse_dir) / "config.json"
    if cfg_path.exists():
        cfg = json.loads(cfg_path.read_text())
        db_file = cfg.get("dbFile", "data.db")
        if os.path.isabs(db_file):
            return db_file
        return str(pathlib.Path(netpulse_dir) / db_file)
    return str(pathlib.Path(netpulse_dir) / "data.db")


def parse_range(s):
    if s == "all":
        return None
    m = __import__("re").match(r"^(\d+)([hd])$", s)
    if not m:
        return 24 * 3600 * 1000
    n, unit = int(m.group(1)), m.group(2)
    return n * (3600_000 if unit == "h" else 86_400_000)


def analyze(db_path, range_ms):
    if not os.path.exists(db_path):
        return None, f"Database not found at {db_path}. Is netpulse running?"
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    now = int(datetime.datetime.now().timestamp() * 1000)
    since = now - range_ms if range_ms else 0

    def ping_count():
        return db.execute("SELECT COUNT(*) FROM pings WHERE ts >= ?", (since,)).fetchone()[0]

    if ping_count() == 0:
        return None, "No ping samples yet. Wait a minute and try again."

    report = {}
    report["db_path"] = db_path
    report["range"] = "all" if range_ms is None else f"{range_ms // 60_000} minutes"

    first = db.execute("SELECT MIN(ts) FROM pings WHERE ts >= ?", (since,)).fetchone()[0]
    last = db.execute("SELECT MAX(ts) FROM pings WHERE ts >= ?", (since,)).fetchone()[0]
    report["span"] = {
        "start": ms_to_dt(first).isoformat(timespec="seconds"),
        "end": ms_to_dt(last).isoformat(timespec="seconds"),
        "hours": round((last - first) / 3600_000, 2),
    }
    report["samples"] = {
        "pings": db.execute("SELECT COUNT(*) FROM pings WHERE ts >= ?", (since,)).fetchone()[0],
        "speed": db.execute("SELECT COUNT(*) FROM speed_samples WHERE ts >= ?", (since,)).fetchone()[0],
        "ttfb":  db.execute("SELECT COUNT(*) FROM ttfb WHERE ts >= ?", (since,)).fetchone()[0],
    }

    # ── 1. Latency distribution per target ──────────────────────────────────
    targets = [r[0] for r in db.execute(
        "SELECT DISTINCT target FROM pings WHERE ts >= ? ORDER BY target", (since,))]
    dist = []
    for t in targets:
        vals = sorted(r[0] for r in db.execute(
            "SELECT latency_ms FROM pings WHERE target=? AND lost=0 AND ts >= ?", (t, since)))
        total_row = db.execute(
            "SELECT COUNT(*), SUM(lost) FROM pings WHERE target=? AND ts >= ?", (t, since)).fetchone()
        if vals:
            dist.append({
                "target": t,
                "samples": total_row[0],
                "loss_pct": (total_row[1] or 0) / total_row[0] * 100,
                "p50_ms": percentile(vals, 50),
                "p90_ms": percentile(vals, 90),
                "p99_ms": percentile(vals, 99),
                "max_ms": vals[-1],
                "stdev_ms": statistics.stdev(vals) if len(vals) > 2 else 0,
            })
    report["latency_distribution"] = dist

    # ── 2. Hourly pattern ───────────────────────────────────────────────────
    hourly = db.execute("""
        SELECT CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER) hr,
               target,
               AVG(CASE WHEN lost=0 THEN latency_ms END) avg_lat,
               SUM(lost)*1.0/COUNT(*) loss, COUNT(*) n
        FROM pings WHERE ts >= ? GROUP BY hr, target ORDER BY hr, target
    """, (since,)).fetchall()
    report["hourly_pattern"] = [dict(r) for r in hourly]

    # ── 3. Loss clustering per target ───────────────────────────────────────
    clustering = []
    for t in targets:
        rows = db.execute("""
            SELECT (ts/60000)*60000 mb FROM pings
            WHERE target=? AND lost=1 AND ts >= ?
            GROUP BY mb ORDER BY mb
        """, (t, since)).fetchall()
        times = [r[0] for r in rows]
        if len(times) < 2:
            clustering.append({"target": t, "loss_minutes": len(times), "gap_median_min": None})
            continue
        gaps = [(times[i + 1] - times[i]) / 60_000 for i in range(len(times) - 1)]
        gaps.sort()
        clustering.append({
            "target": t,
            "loss_minutes": len(times),
            "gap_median_min": gaps[len(gaps) // 2],
            "gap_mean_min": sum(gaps) / len(gaps),
        })
    report["loss_clustering"] = clustering

    # ── 4. Cross-target correlation (pick the worst target as pivot) ────────
    worst = max(dist, key=lambda d: d["loss_pct"]) if dist else None
    correlation = None
    if worst and worst["loss_pct"] > 1:
        pivot = worst["target"]
        pivot_loss_mins = {r[0] for r in db.execute("""
            SELECT DISTINCT (ts/60000)*60000 FROM pings
            WHERE target=? AND lost=1 AND ts >= ?
        """, (pivot, since)).fetchall()}
        corr = {"pivot": pivot, "pivot_loss_minutes": len(pivot_loss_mins), "others": []}
        if pivot_loss_mins:
            id_list = ",".join(str(x) for x in pivot_loss_mins)
            for t in targets:
                if t == pivot:
                    continue
                overlap = db.execute(f"""
                    SELECT COUNT(DISTINCT (ts/60000)*60000) FROM pings
                    WHERE target=? AND lost=1 AND ts >= ? AND (ts/60000)*60000 IN ({id_list})
                """, (t, since)).fetchone()[0]
                corr["others"].append({
                    "target": t,
                    "overlap_minutes": overlap,
                    "overlap_pct": overlap / len(pivot_loss_mins) * 100,
                })
        correlation = corr
    report["correlation"] = correlation

    # ── 5. Speed distribution ───────────────────────────────────────────────
    speeds = [r[0] for r in db.execute(
        "SELECT mbps FROM speed_samples WHERE failed=0 AND ts >= ? ORDER BY mbps", (since,))]
    total = db.execute("SELECT COUNT(*), SUM(passed), SUM(failed) FROM speed_samples WHERE ts >= ?", (since,)).fetchone()
    durs = [r[0] for r in db.execute("SELECT duration_ms FROM speed_samples WHERE failed=0 AND ts >= ?", (since,))]
    report["speed"] = {
        "total": total[0], "passed": total[1] or 0, "failed": total[2] or 0,
        "mbps_min": min(speeds) if speeds else None,
        "mbps_max": max(speeds) if speeds else None,
        "mbps_median": percentile(speeds, 50),
        "mbps_mean": (sum(speeds) / len(speeds)) if speeds else None,
        "mbps_cv_pct": (statistics.stdev(speeds) / statistics.mean(speeds) * 100) if len(speeds) > 2 else None,
        "duration_median_ms": percentile(sorted(durs), 50) if durs else None,
    }

    # ── 6. TTFB ─────────────────────────────────────────────────────────────
    ttfb_targets = [r[0] for r in db.execute(
        "SELECT DISTINCT target FROM ttfb WHERE ts >= ? ORDER BY target", (since,))]
    ttfb_stats = []
    for t in ttfb_targets:
        vals = sorted(r[0] for r in db.execute(
            "SELECT ttfb_ms FROM ttfb WHERE target=? AND failed=0 AND ts >= ?", (t, since)))
        total_row = db.execute(
            "SELECT COUNT(*), SUM(failed) FROM ttfb WHERE target=? AND ts >= ?", (t, since)).fetchone()
        if vals:
            ttfb_stats.append({
                "target": t,
                "p50_ms": percentile(vals, 50),
                "p90_ms": percentile(vals, 90),
                "failures": total_row[1] or 0,
                "samples": total_row[0],
            })
    report["ttfb"] = ttfb_stats

    return report, None


# ── Markdown rendering ──────────────────────────────────────────────────────
def render_markdown(r):
    out = []
    out.append("# netpulse — network analysis")
    out.append("")
    out.append(f"**Period:** {r['span']['start']} → {r['span']['end']}  ({r['span']['hours']} h)")
    out.append(f"**Samples:** {r['samples']['pings']} pings · {r['samples']['speed']} speed · {r['samples']['ttfb']} TTFB")
    out.append("")

    # 1. Latency
    out.append("## 1. Latency distribution")
    out.append("")
    out.append("| Target | P50 | P90 | P99 | Max | Loss% | Stdev | n |")
    out.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for d in r["latency_distribution"]:
        out.append(
            f"| {d['target']} | {d['p50_ms']:.1f}ms | {d['p90_ms']:.1f}ms | "
            f"{d['p99_ms']:.1f}ms | {d['max_ms']:.1f}ms | {d['loss_pct']:.2f}% | "
            f"{d['stdev_ms']:.1f}ms | {d['samples']} |"
        )
    out.append("")

    # 2. Hourly pattern
    if r["hourly_pattern"]:
        out.append("## 2. Time-of-day pattern")
        out.append("")
        out.append("Per-target hourly average latency and loss. Look for evening-peak congestion.")
        out.append("")
        by_hr = {}
        targets = []
        for row in r["hourly_pattern"]:
            by_hr.setdefault(row["hr"], {})[row["target"]] = (row["avg_lat"], row["loss"])
            if row["target"] not in targets:
                targets.append(row["target"])
        out.append("| Hour | " + " | ".join(targets) + " |")
        out.append("|---|" + "|".join(["---:"] * len(targets)) + "|")
        for hr in sorted(by_hr.keys()):
            cells = []
            for t in targets:
                if t in by_hr[hr]:
                    lat, loss = by_hr[hr][t]
                    marker = " ⚠" if (loss or 0) > 0.05 else ""
                    cells.append(f"{lat or 0:.0f}ms / {(loss or 0) * 100:.0f}%{marker}")
                else:
                    cells.append("—")
            out.append(f"| {hr:02d}:00 | " + " | ".join(cells) + " |")
        out.append("")

    # 3. Loss clustering
    if r["loss_clustering"]:
        out.append("## 3. Loss clustering")
        out.append("")
        has_any = any(c["loss_minutes"] > 0 for c in r["loss_clustering"])
        if not has_any:
            out.append("No loss observed. ✓")
        else:
            out.append("| Target | Loss minutes | Gap median | Gap mean |")
            out.append("|---|---:|---:|---:|")
            for c in r["loss_clustering"]:
                gm = f"{c['gap_median_min']:.1f}min" if c.get("gap_median_min") else "—"
                gmn = f"{c.get('gap_mean_min', 0):.1f}min" if c.get("gap_mean_min") else "—"
                out.append(f"| {c['target']} | {c['loss_minutes']} | {gm} | {gmn} |")
            out.append("")
            out.append("_Gap median < 5 min → bursty loss (problem recurs in waves)._")
        out.append("")

    # 4. Correlation
    if r["correlation"]:
        c = r["correlation"]
        out.append(f"## 4. Correlation — is `{c['pivot']}`'s loss shared?")
        out.append("")
        out.append(f"`{c['pivot']}` lost packets in **{c['pivot_loss_minutes']}** distinct minutes.")
        out.append("")
        out.append("| Other target | Co-loss minutes | Overlap |")
        out.append("|---|---:|---:|")
        for o in c["others"]:
            flag = " ← common-path issue" if o["overlap_pct"] > 30 else ""
            out.append(f"| {o['target']} | {o['overlap_minutes']} | {o['overlap_pct']:.1f}%{flag} |")
        out.append("")
        max_overlap = max((o["overlap_pct"] for o in c["others"]), default=0)
        if max_overlap < 15:
            out.append(f"**Verdict:** Losses are path-specific to `{c['pivot']}`, not a local/ISP issue.")
        elif max_overlap < 50:
            out.append(f"**Verdict:** Some shared path but mostly `{c['pivot']}`-specific.")
        else:
            out.append(f"**Verdict:** Loss correlates across multiple targets — likely local/ISP problem.")
        out.append("")

    # 5. Speed
    s = r["speed"]
    if s["total"] > 0:
        out.append("## 5. Speed samples")
        out.append("")
        if s["mbps_median"] is None:
            out.append(f"All {s['total']} samples failed.")
        else:
            pass_rate = (s["passed"] / s["total"]) * 100
            out.append(f"- **Pass rate:** {s['passed']}/{s['total']} ({pass_rate:.1f}%)")
            out.append(f"- **Median speed:** {s['mbps_median']:.1f} Mbps  ·  mean {s['mbps_mean']:.1f} Mbps")
            out.append(f"- **Range:** {s['mbps_min']:.1f} – {s['mbps_max']:.1f} Mbps")
            if s["mbps_cv_pct"] is not None:
                out.append(f"- **Stability:** CV {s['mbps_cv_pct']:.1f}% (stdev / mean)")
            else:
                out.append(f"- **Stability:** (need ≥3 samples for variance)")
            if s["duration_median_ms"] is not None:
                out.append(f"- **Download latency:** median {s['duration_median_ms']}ms for test file")
        out.append("")

    # 6. TTFB
    if r["ttfb"]:
        out.append("## 6. TTFB (time-to-first-byte)")
        out.append("")
        out.append("| Target | P50 | P90 | Failures |")
        out.append("|---|---:|---:|---:|")
        for t in r["ttfb"]:
            out.append(f"| {t['target']} | {t['p50_ms']:.0f}ms | {t['p90_ms']:.0f}ms | {t['failures']}/{t['samples']} |")
        out.append("")

    # ── Summary verdict ─────────────────────────────────────────────────────
    # Judge by the *worst* target for a blanket verdict. Separately note
    # correlation (from section 4): if worst is an outlier, call it path-specific.
    out.append("---")
    out.append("")
    lat_summary = "insufficient data"
    if r["latency_distribution"]:
        losses = [d["loss_pct"] for d in r["latency_distribution"]]
        worst = max(losses)
        best = min(losses)
        n = len(losses)
        ok_count = sum(1 for l in losses if l < 1)

        # correlation-aware: a single bad target among many → likely upstream path issue
        corr = r.get("correlation") or {}
        overlaps = [o["overlap_pct"] for o in corr.get("others", [])]
        max_overlap = max(overlaps) if overlaps else None

        if best >= 5:
            lat_summary = f"significant degradation across all targets ({best:.1f}%–{worst:.1f}% loss)"
        elif best >= 1:
            lat_summary = f"mild loss across all targets ({best:.1f}%–{worst:.1f}%)"
        elif worst >= 5 and ok_count >= n - 1 and (max_overlap is None or max_overlap < 30):
            lat_summary = f"infrastructure healthy; one upstream path degraded ({worst:.1f}% loss, likely path-specific)"
        elif worst >= 5:
            lat_summary = f"partial degradation ({worst:.1f}% loss on at least one target, possibly local)"
        elif worst >= 1:
            lat_summary = "mostly healthy with minor intermittent loss"
        else:
            lat_summary = "infrastructure healthy"

    if s["total"] > 0 and s["passed"] / s["total"] >= 0.95:
        speed_summary = "bandwidth consistently meets threshold"
    elif s["total"] > 0:
        pass_rate = s["passed"] / s["total"] * 100
        speed_summary = f"threshold passed only {pass_rate:.1f}% of the time"
    else:
        speed_summary = "not enough speed samples yet"
    out.append(f"**Overall:** {lat_summary}; {speed_summary}.")
    out.append("")

    return "\n".join(out)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--range", default="all", help="Analysis window: 1h, 6h, 24h, 7d, or 'all' (default: all).")
    p.add_argument("--json", action="store_true", help="Emit raw JSON instead of Markdown.")
    p.add_argument("--db", default=None, help="Override database path.")
    args = p.parse_args()

    db_path = args.db or resolve_db_path()
    range_ms = parse_range(args.range)
    report, err = analyze(db_path, range_ms)
    if err:
        print(err, file=sys.stderr)
        sys.exit(1)
    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        print(render_markdown(report))


if __name__ == "__main__":
    main()
