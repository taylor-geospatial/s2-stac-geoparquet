# Search speed: request parallelism, one-request metadata, and V7

Follow-on to `docs/c1-layout-experiments.md`. That experiment found the
fastest sidecar-free layout (V7, one part per MGRS grid-zone prefix such as
`t=31U`, 2,000-row groups, 13-50 KB footers) and a larger lever outside
layout: Chrome serialises concurrent range GETs that share a URL, so the
eight column reads of a row group cost about 2,077 ms instead of 438 ms.

The experiment then concluded that no sidecar-free layout can finish ahead
of the sidecar, because the footer path spends three sequential metadata
round-trips. That premise is not fixed. This task tests whether it can be
removed.

<!-- vale Portolan-Mechanics.Headings = NO -->
<!-- A, B and C label the three experiments and keep their letters. -->
## A. Parallel range reads

`rangeGet` (apps/explorer/search.js:28) issues every read as
`fetch(url, {headers: {Range}})` with the default cache mode. Measure these
three ways to avoid the per-URL serialisation, on the published parts:

1. `cache: "no-store"` on the fetch.
2. One coalesced range per row group, as one request spanning
   `min(off)` to `max(off + len)` of the eight search columns, sliced in
   memory. Fewer requests, some wasted bytes. Report the waste for the
   published layout and for V7.
3. A distinct URL per concurrent read (the ignored-query-param trick the
   previous experiment measured). Treat this as the reference number, not
   as a candidate: a unique query string is a separate CDN cache key, so it
   shifts load to the origin and hurts every other reader.

Pick by measured wall time, with (3) discounted for the CDN cost. Keep the
206-only check and the Content-Range size check.

## B. One-request metadata
<!-- vale Portolan-Mechanics.Headings = YES -->

The footer path costs three sequential round-trips:

1. the sidecar 404 probe
2. the 8-byte tail read for the footer length
3. the footer itself

Replace
the last two with one speculative tail read of N bytes (start with 64 KB),
parse the footer length from its end, and issue a second request only when
the footer did not fit. Drop the sidecar probe when the caller says the
collection publishes no sidecars.

Report these for the published layout and for V7: metadata requests, bytes
and wall time, both cold and warm.

<!-- vale Portolan-Mechanics.Headings = NO -->
<!-- C labels the third experiment and keeps its letter. -->
## C. Does V7 plus A plus B finish ahead of the sidecar?
<!-- vale Portolan-Mechanics.Headings = YES -->

Rebuild **2024 only** as V7 on RAILS (the previous run's scratch is
deleted; `tools/rails/experiments/` has the build scripts), upload to
`_experiments/v7-2024/`, and measure the four query shapes from the
previous experiment (tile + 1 month, 3 months, year, 3 months with cloud
filter; the same three tiles; five repetitions; cold and warm) against:

- the published 2024 single-file part **with** its sidecar, current client
  (today's production number),
- the published 2024 part with A and B, sidecar on and off,
- V7 2024 with A and B, sidecar off.

State the RTT at the start and end. All variants must return identical
rows; assert it.

## Deliverable

Extend `docs/c1-layout-experiments.md` with these results, and answer:

1. Which change to `search.js` to merge, with its measured win.
2. Whether the sidecar can be dropped, and on which layout.
3. Whether to repartition Collection 1 to V7: the read win, the +1.6 %
   bytes and about 9,500 objects, and the fold cost (a V7 part peaks at
   1.3 GB RSS, so a GitHub runner can fold it, which would end the RAILS
   dependency for routine operation).

Merge the `search.js` change in this task if the measurements support it,
because it is a small, self-contained edit to the production client. Keep the
sidecar working. A repartition is not part of this task; recommend only.

Clean up `_experiments/` and the RAILS scratch when the numbers are in.
