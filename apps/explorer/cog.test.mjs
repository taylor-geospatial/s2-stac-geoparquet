import test from "node:test";
import assert from "node:assert/strict";
import { tileProps, destroyTileTextures, levelForResolution, tileRangeFor,
  bandWindowImage, commonResolution, destroyLayerTextures } from "./cog.js";

test("tileProps does not cap the ancestor walk", () => {
  const p = tileProps([0, 0, 1, 1], {});
  // deck.gl reads minZoom on the pyramid-level axis in _getNearestAncestor,
  // so any floor above 0 severs the coarse fallback.
  assert.ok(p.minZoom === undefined || p.minZoom === 0);
  assert.equal(p.extent[0], 0);
  assert.equal(p.refinementStrategy, "no-overlap");
});

test("destroyTileTextures releases every texture it is given", () => {
  let destroyed = 0;
  const tex = () => ({ destroy: () => { destroyed++; } });
  destroyTileTextures({ texture: tex(), mask: tex() });
  assert.equal(destroyed, 2);
});

test("destroyTileTextures tolerates an empty tile", () => {
  assert.doesNotThrow(() => destroyTileTextures(null));
  assert.doesNotThrow(() => destroyTileTextures({}));
});

test("tileProps sets a byte budget so the cache can evict", () => {
  const p = tileProps([0, 0, 1, 1], {});
  assert.ok(p.maxCacheByteSize > 0);
});

const fakeLevel = (w, h, tw, th, tc) =>
  ({ width: w, height: h, tileWidth: tw, tileHeight: th, tileCount: tc });
// bbox is the projected (UTM metre) extent openCog reads from the GeoTIFF.
// levelForResolution needs it to turn a level's pixel width into metres.
const fakeCog = (levels) => ({
  w: 10980, h: 10980, bounds: [0, 0, 1, 1],
  geotiff: { ...levels[levels.length - 1], overviews: levels.slice(0, -1),
    bbox: [0, 0, 109800, 109800] },
});

test("levelForResolution picks the coarsest level that is fine enough", () => {
  const cog = fakeCog([fakeLevel(1372, 1372, 512, 512, { x: 3, y: 3 }),
    fakeLevel(10980, 10980, 512, 512, { x: 22, y: 22 })]);
  // The scene spans 109.8 km. The coarse level is 80 m/px, the fine 10 m/px.
  assert.equal(levelForResolution(cog, 100).width, 1372);
  assert.equal(levelForResolution(cog, 20).width, 10980);
});

test("levelForResolution handles a COG with no overviews", () => {
  const cog = fakeCog([fakeLevel(10980, 10980, 512, 512, { x: 22, y: 22 })]);
  assert.equal(levelForResolution(cog, 1000).width, 10980);
});

test("tileRangeFor clamps a view that overhangs the scene", () => {
  const level = fakeLevel(1372, 1372, 512, 512, { x: 3, y: 3 });
  const r = tileRangeFor(level, [0, 0, 1, 1], [-5, -5, 5, 5]);
  assert.deepEqual(r, { minCol: 0, maxCol: 2, minRow: 0, maxRow: 2 });
});

test("tileRangeFor returns null when the view misses the scene", () => {
  const level = fakeLevel(1372, 1372, 512, 512, { x: 3, y: 3 });
  assert.equal(tileRangeFor(level, [0, 0, 1, 1], [10, 10, 11, 11]), null);
});

// One 512 px level that is exactly one tile, so windowImage's assemble and
// crop both short-circuit and the stub needs no GPU and no real TIFF.
const stubCog = () => {
  const level = {
    width: 512, height: 512, tileWidth: 512, tileHeight: 512,
    tileCount: { x: 1, y: 1 }, overviews: [], bbox: [0, 0, 5120, 5120],
    fetchTiles: async () => [{ array: {
      width: 512, height: 512, count: 1, layout: "pixel-interleaved",
      data: new Uint8Array(512 * 512),
    } }],
  };
  return { w: 512, h: 512, bounds: [0, 0, 1, 1], geotiff: level };
};
const stubScene = () => ({
  bounds: [0, 0, 1, 1], dir: "stub", overviews: new Map(),
  cogs: new Map([["B08", Promise.resolve(stubCog())],
    ["B04", Promise.resolve(stubCog())]]),
});

test("bandWindowImage stamps the band set it was built from", async () => {
  const img = await bandWindowImage(stubScene(), { kind: "index", index: "ndvi" },
    [0, 0, 1, 1], 100);
  assert.equal(img.specKey, "B08+B04");
  assert.equal(img.kind, "bands");
  assert.equal(img.arrays.size, 2);
});

test("tileRangeFor adds a one-tile margin around the view", () => {
  // A 5 x 5 tile grid, view over the middle tile only. Without a margin the
  // range is the single tile (2,2); the sharp rung would then stop at the
  // view edge, and a pan under the threshold shows bare ground.
  const level = fakeLevel(2560, 2560, 512, 512, { x: 5, y: 5 });
  const r = tileRangeFor(level, [0, 0, 1, 1], [0.45, 0.45, 0.55, 0.55]);
  assert.deepEqual(r, { minCol: 1, maxCol: 3, minRow: 1, maxRow: 3 });
});

test("tileRangeFor keeps the margin inside the level", () => {
  const level = fakeLevel(1372, 1372, 512, 512, { x: 3, y: 3 });
  const r = tileRangeFor(level, [0, 0, 1, 1], [-5, -5, 5, 5]);
  assert.deepEqual(r, { minCol: 0, maxCol: 2, minRow: 0, maxRow: 2 });
});

// A 20 m band's pyramid is half the width of a 10 m band's at every rung.
// levelForResolution picks per band, so a target between the two rungs used
// to give the two bands different grids and the composite came out shifted.
const stubCogAt = (baseWidth) => {
  const mk = (w) => ({
    width: w, height: w, tileWidth: 512, tileHeight: 512,
    tileCount: { x: Math.ceil(w / 512), y: Math.ceil(w / 512) },
    fetchTiles: async (xy) => xy.map(([x, y]) => ({ x, y, array: {
      width: 512, height: 512, count: 1, layout: "pixel-interleaved",
      transform: [20, 0, 0, 0, -20, 0], data: new Uint8Array(512 * 512),
    } })),
  });
  const fine = mk(baseWidth);
  return { w: baseWidth, h: baseWidth, bounds: [0, 0, 1, 1],
    geotiff: { ...fine, overviews: [mk(baseWidth / 2)], bbox: [0, 0, 20480, 20480] } };
};

test("a mixed-resolution composite reads every band at one resolution", () => {
  // 20480 m span. The 10 m band's rungs are 10 and 20 m/px; the 20 m
  // band's are 20 and 40. At a 15 m target the 10 m band alone would take
  // its 10 m rung and the two bands would land on different tile grids.
  const fine = stubCogAt(2048);
  const coarse = stubCogAt(1024);
  assert.equal(levelForResolution(fine, 15).width, 2048);
  assert.equal(commonResolution([fine, coarse], 15), 20);
  // Read at the common value and both bands pick the same 1024 px level.
  assert.equal(levelForResolution(fine, 20).width, 1024);
  assert.equal(levelForResolution(coarse, 20).width, 1024);
});

test("destroyLayerTextures frees nothing for an unknown layer", () => {
  assert.equal(destroyLayerTextures("no-such-layer"), 0);
});

test("tileProps keeps a tile-count bound beside the byte budget", () => {
  // deck.gl sets maxCacheSize to Infinity once maxCacheByteSize is given,
  // so the count bound has to be stated or the resident set is unbounded.
  const p = tileProps([0, 0, 1, 1], {});
  assert.ok(Number.isFinite(p.maxCacheSize) && p.maxCacheSize > 0);
});
