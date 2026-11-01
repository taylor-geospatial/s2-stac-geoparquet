import test from "node:test";
import assert from "node:assert/strict";
import { viewKeyOf, viewChangedEnough, WarmBudget, rungFor, toneOf } from "./warm.js";

const view = (zoom, w, s, e, n) => ({ zoom, bounds: [w, s, e, n] });

test("a zoom step retires the warm set", () => {
  assert.ok(viewChangedEnough(view(11, 0, 0, 1, 1), view(12, 0, 0, 1, 1)));
});

test("a small pan does not retire the warm set", () => {
  assert.equal(
    viewChangedEnough(view(11, 0, 0, 1, 1), view(11, 0.1, 0, 1.1, 1)), false);
});

test("a large pan retires the warm set", () => {
  assert.ok(viewChangedEnough(view(11, 0, 0, 1, 1), view(11, 0.9, 0, 1.9, 1)));
});

test("a first view always counts as a change", () => {
  assert.ok(viewChangedEnough(null, view(11, 0, 0, 1, 1)));
});

test("the budget evicts oldest first and reports what it dropped", () => {
  const b = new WarmBudget(100);
  b.add("a", 60); b.add("b", 60);
  assert.deepEqual(b.evictTo(100), ["a"]);
  assert.equal(b.has("a"), false);
  assert.equal(b.bytes, 60);
});

test("a rung from another view is not sharp for this one", () => {
  assert.equal(rungFor({ hd: true, viewKey: "a", specKey: "TCI" },
    "b", "TCI"), "soft");
  assert.equal(rungFor({ hd: true, viewKey: "b", specKey: "TCI" },
    "b", "TCI"), "sharp");
});

test("a rung from another band set is not sharp", () => {
  assert.equal(rungFor({ hd: true, viewKey: "b", specKey: "TCI" },
    "b", "B08+B04"), "soft");
});

test("an entry with no sharp read is soft", () => {
  assert.equal(rungFor({ hd: false }, "b", "TCI"), "soft");
});

test("a scene with no usable thumbnail still reports a soft rung", () => {
  // previewImage returned null, so the entry carries only the raw bitmap.
  assert.equal(toneOf({ hd: false, thumb: { raw: true } }, "v1", "TCI"), 1);
  assert.notEqual(toneOf({ hd: false, thumb: { raw: true } }, "v1", "TCI"), 0);
});

test("tone 1 survives a view change and tone 2 does not", () => {
  const e = { hd: true, thumb: {}, viewKey: "v1", specKey: "TCI" };
  assert.equal(toneOf(e, "v2", "TCI"), 1);
  assert.equal(toneOf(e, "v1", "TCI"), 2);
  assert.equal(toneOf(null, "v1", "TCI"), 0);
});
