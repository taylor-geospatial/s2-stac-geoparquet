import test from "node:test";
import assert from "node:assert/strict";
import { tileProps } from "./cog.js";

test("tileProps does not cap the ancestor walk", () => {
  const p = tileProps([0, 0, 1, 1], {});
  // deck.gl reads minZoom on the pyramid-level axis in _getNearestAncestor,
  // so any floor above 0 severs the coarse fallback.
  assert.ok(p.minZoom === undefined || p.minZoom === 0);
  assert.equal(p.extent[0], 0);
  assert.equal(p.refinementStrategy, "no-overlap");
});
