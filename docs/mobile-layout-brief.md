# Mobile layout: the map is the page

## The complaint

On a phone the explorer shows almost no map. The sidebar occupies 46 vh at
the top, with the image panel below it at up to 45 vh. That leaves the map as
the
9 vh strip between them. The user's words: "Can we get the mobile experience
a bit better? Too much menus so that I can't see the map."

Screenshot for reference:
`/Users/cholmes/.claude/uploads/2a289305-6a96-4630-8a13-26ed2c5e7ad3/9eb49946-image.png`

## The design

At the mobile breakpoint (the existing `max-width: 760px`), the map fills the
viewport and **one** bottom sheet holds everything else. Desktop is unchanged:
sidebar left, image card at the map's lower right.

- `#map` covers the whole viewport.
- `#panel` becomes the sheet, fixed to the bottom at full width, with a
  rounded top and a grab handle. Its snap heights:
  - **peek**: handle plus one line of status, about 110 px. The default when a
    scene is drawn on the map.
  - **half**: 50 dvh. The default on load.
  - **full**: 88 dvh.
- `#imgpanel` is not a second sheet on mobile. When a scene is shown, its
  contents (the "Showing … Clear" bar and "Bands & stretch") render at the top
  of the same sheet, above the search controls. One sheet, never two.
- The handle responds to a drag, through pointer events that snap to the
  nearest stop on release, and to a tap, which cycles peek → half → full →
  peek.
- Showing a scene on the map snaps the sheet to peek, so the user sees the
  image they just asked for. The "Showing …" line remains visible at peek.
- The sheet's content scrolls inside it; the page itself never scrolls.
- Respect the phone: `dvh` units (the iOS URL bar changes `vh`), and
  `env(safe-area-inset-bottom)` padding so the home indicator does not sit on
  the controls.
- Keep MapLibre's zoom buttons clear of the sheet at every snap.

## Verification

Headless Chrome at three viewports — 390x844 (iPhone 14), 428x926 (iPhone 14
Plus, the screenshot's shape) and 1440x900 (desktop regression):

1. On load at phone size, the map is at least 50 % of the viewport height.
2. Search, then "Show on map": the sheet is at peek, the "Showing …" line is
   visible, and the map shows the scene.
3. Expanding to full reaches the band controls and the stretch handles; they
   work (change a preset, drag a handle).
4. The zoom buttons are hit-testable at every snap height.
5. Desktop: the sidebar and the lower-right image card are as they are today.

Save a screenshot of each state and list the paths in the report. The
before/after pair at 428x926 matters most — the user will look at it.

## Constraints

`apps/explorer/{index.html,style.css,app.js}` only, plus any test that asserts
on their text. No new dependencies. Simplified Technical English in lasting
comments and the commit body. Gates: `node --check` on the modules,
`CI_LIGHT=1 python3 tests/run_all.py`, `CI_LIGHT=1 python3 -m pytest tests -q`.
Make one commit with explicit paths, and do not push.
