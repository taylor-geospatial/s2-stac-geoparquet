# Render harness: a never-blank gate in CI

## The complaint

The explorer must never show bare ground where imagery was. Nothing checks
this. A regression reaches the user.

The zoom blank of 2026-11-01 is the example. Each zoom step dropped the
raster and showed the green MGRS fill until the next pyramid level loaded.
The cause was one prop. No test could see it, because no test runs the
explorer at all.

## What exists

`apps/explorer/test/render.js` already reads back `coverage`, the
non-transparent fraction of the framebuffer. That number is the never-blank
measure.

## What is missing

* The driver. `test/render.js` names `test/render.mjs` in its own header
  comment. That file does not exist.
* The workflow. No job under `.github/workflows/` runs the explorer.

## The work

Add the driver and a CI job. The job builds with `npm run build:test`,
serves `dist/`, opens `test/render.html`, commits a scene, zooms in three
steps, and reads `coverage` after each step. The gate fails when coverage
drops below a floor during a zoom.

## Where this comes from

The continuous-imagery work of 2026-11-01 fixed the zoom blank and the
scrub resolution. That design records manual sign-off as the accepted bar
and names this harness as the follow-up.
