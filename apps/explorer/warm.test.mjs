import test from "node:test";
import assert from "node:assert/strict";
import { viewKeyOf, viewChangedEnough, WarmBudget } from "./warm.js";

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
