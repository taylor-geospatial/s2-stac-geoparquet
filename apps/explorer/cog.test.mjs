import test from "node:test";
import assert from "node:assert/strict";
import { tileProps, destroyTileTextures, levelForResolution, tileRangeFor } from "./cog.js";

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
