# How to read netpulse results

Numbers without diagnosis are just numbers. This file is the interpretation layer — load it when the user wants a real analysis, not a data dump.

## The fundamental move: isolate the cause

The single most useful reasoning in networking diagnosis is asking: **does this bad number correlate across targets?**

| Pattern | Likely cause | Where to look |
|---|---|---|
| All targets degrade simultaneously | Local: Wi-Fi, router, or ISP last-mile | Reboot router, check cable, test another device |
| One target degrades alone | Upstream path issue (not your fault) | Traceroute that target; note the hop where latency jumps |
| Loss spreads in time (hourly clusters) | ISP peak-hour congestion | Log for a week, confirm pattern before complaining |
| Speed swings but ping is steady | CDN edge routing or TCP slow-start noise | Not really a problem unless threshold failures follow |

The `Correlation` section in `analyze.py`'s output is exactly this computation — when the worst target's loss overlaps < 30% with other targets, it's path-specific.

## Reading the hourly heatmap

`analyze.py` prints a per-hour × per-target grid. What to look for:

- **Horizontal band**: a time window where *every* target degrades → local or ISP-wide
- **Vertical stripe**: one target bad across all hours → path-specific (and stable)
- **Single-cell outlier**: a specific hour on a specific target → one-time incident, don't over-weight
- **Evening ramp** (19:00–23:00 local): classic ISP uplink congestion. Confirmed when:
  - Only certain targets show it (upstream peering overloaded)
  - Your download speed also dips during those hours
  - Hours outside that window are quiet

## Percentiles over means

The average hides the tail. Given a P50 of 10 ms and a P99 of 400 ms, the user will experience the occasional 400 ms hang vividly. Report:

- **P50** — typical experience
- **P90** — "reasonably bad" moments (~10 % of samples)
- **P99** — the worst 1 %, where user annoyance lives
- **Max** — single outlier (one hiccup doesn't mean much; repeated spikes do)

A good home connection: P50 ≤ 30 ms, P90 ≤ 80 ms, P99 ≤ 200 ms, Max rarely > 500 ms.

## Loss: steady vs bursty

Same 1 % total loss means very different things depending on distribution:

- **Uniform** — noise floor (Wi-Fi interference, line quality). Tolerable.
- **Clustered** — brief outages. User notices: video calls drop, downloads stall.

The `Gap median` column in loss clustering tells you which. < 2 min → bursty. > 10 min → spread. Bursty loss is what actually damages user experience even when the total percentage looks small.

## Jitter (stdev of latency)

Stable link: stdev / mean < 30 %. Unstable: > 60 %.

Voice calls, gaming, and video conferencing are more sensitive to jitter than to absolute latency. Two links with mean 40 ms look identical until you notice one has stdev 5 ms (rock-solid) and the other 60 ms (wobbly).

## Speed: threshold > peak

Don't fixate on "my ISP promised 500 Mbps but I only saw 92". Ask: "did it ever fail the threshold?".

- **Pass rate ≥ 99 %** → functional.
- **Pass rate 90–99 %** → mostly fine, watch for a pattern in the failures.
- **Pass rate < 90 %** → genuine problem. Look at when failures cluster (time of day, day of week, correlate with loss).

The CV (coefficient of variation, stdev/mean) tells you consistency. CV < 20 % is steady; > 40 % means something (CDN shuffle, congestion, flaky link).

## TTFB: disentangling DNS/TLS from network

TTFB includes: DNS lookup + TCP handshake + TLS handshake + server response. If ping to 1.1.1.1 is 5 ms but `cloudflare.com` TTFB is 400 ms, the extra 395 ms is NOT network — it's TLS setup + their backend. Reassure users that this gap is normal.

Compare TTFB across targets to find the actual slow one:
- Google ~100–150 ms → healthy baseline
- Other sites significantly higher → the site is slow, not your network

## Narrative to produce

When summarizing for a user, reach for a verdict first, then support it. Good structure:

1. **One-line verdict** — "Your network is healthy. One upstream path (baidu.com) is flaky but it's not your fault."
2. **Evidence** — "Three global targets show P50 8 ms and <0.3 % loss across 47 hours."
3. **The one anomaly** — "`baidu.com` has 7.8 % loss with a clear 19:00–23:00 ramp. Same-minute correlation with other targets is 2.9 % → path-specific, classic cross-border peering congestion."
4. **What to do** — "Nothing to fix on your end. If you access Chinese sites frequently and this bothers you, consider a VPN with China-optimized routing."

Avoid:
- Dumping raw tables without explanation.
- Confident assertions about root cause beyond what the data supports.
- Blaming the user's hardware when correlation analysis hasn't ruled out upstream issues.
