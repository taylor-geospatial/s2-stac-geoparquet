import test from "node:test";
import assert from "node:assert/strict";
import { SORTS, filterRows, sortRows, viewOf, indexOfId, clampIndex, filterKeyOf, whyFiltered,
  groupWindow, mergeStrip }
  from "./results.js";

const day = (d) => Date.parse(`${d}T12:00:00Z`);
const rows = [
  { id: "S2A_1", day: "2024-01-05", t: day("2024-01-05"), cloud: 40, cover: 100 },
  { id: "S2A_2", day: "2024-03-10", t: day("2024-03-10"), cloud: 5, cover: 30 },
  { id: "S2A_3", day: "2024-07-01", t: day("2024-07-01"), cloud: 5, cover: null },
  { id: "S2A_4", day: "2024-11-20", t: day("2024-11-20"), cloud: 80, cover: 90 },
];
const all = { maxCloud: 100, minCoverage: 0,
  t0: Date.parse("2024-01-01T00:00:00Z"), t1: Date.parse("2024-12-31T23:59:59.999Z") };

test("filterRows applies cloud, coverage and date window", () => {
  assert.equal(filterRows(rows, all).length, 4);
  assert.deepEqual(filterRows(rows, { ...all, maxCloud: 10 }).map((r) => r.id),
    ["S2A_2", "S2A_3"]);
  // a null cover is never excluded by the coverage floor
  assert.deepEqual(filterRows(rows, { ...all, minCoverage: 50 }).map((r) => r.id),
    ["S2A_1", "S2A_3", "S2A_4"]);
  assert.deepEqual(filterRows(rows, { ...all,
    t0: Date.parse("2024-03-01T00:00:00Z"),
    t1: Date.parse("2024-08-31T23:59:59.999Z") }).map((r) => r.id),
    ["S2A_2", "S2A_3"]);
});

test("sortRows: cloud ties break on id, coverage sorts nulls last, date is newest first", () => {
  assert.deepEqual(sortRows(rows, "cloud").map((r) => r.id),
    ["S2A_2", "S2A_3", "S2A_1", "S2A_4"]);
  assert.deepEqual(sortRows(rows, "coverage").map((r) => r.id),
    ["S2A_1", "S2A_4", "S2A_2", "S2A_3"]);
  assert.deepEqual(sortRows(rows, "date").map((r) => r.id),
    ["S2A_4", "S2A_3", "S2A_2", "S2A_1"]);
  assert.notEqual(sortRows(rows, "date"), rows); // never mutates its input
  assert.equal(rows[0].id, "S2A_1");
  // The fallback is an own-property check, not a truthiness test: a key off
  // the prototype chain finds an object whose .cmp is undefined, and
  // .sort(undefined) would sort by string instead of falling back to cloud.
  const cloudOrder = ["S2A_2", "S2A_3", "S2A_1", "S2A_4"];
  assert.deepEqual(sortRows(rows, "__proto__").map((r) => r.id), cloudOrder);
  assert.deepEqual(sortRows(rows, "nonsense").map((r) => r.id), cloudOrder);
});

test("viewOf composes, indexOfId and clampIndex behave at the edges", () => {
  const view = viewOf(rows, { ...all, maxCloud: 10 }, "cloud");
  assert.deepEqual(view.map((r) => r.id), ["S2A_2", "S2A_3"]);
  assert.equal(indexOfId(view, "S2A_3"), 1);
  assert.equal(indexOfId(view, "S2A_1"), -1);
  assert.equal(clampIndex(view, 5), 1);
  assert.equal(clampIndex(view, -3), 0);
  assert.equal(clampIndex([], 0), -1);
});

test("filterKeyOf changes when any input changes", () => {
  const search = { tile: "31UFU", year: 2024, at: 1 };
  const a = filterKeyOf(all, "cloud", search);
  assert.notEqual(a, filterKeyOf({ ...all, maxCloud: 99 }, "cloud", search));
  assert.notEqual(a, filterKeyOf(all, "date", search));
  assert.notEqual(a, filterKeyOf(all, "cloud", { ...search, at: 2 }));
  assert.equal(typeof filterKeyOf(all, "cloud", null), "string");
});

test("whyFiltered names each failing gate and the value that admits the row", () => {
  // Every row of the fixture passes the open filters.
  for (const r of rows) assert.deepEqual(whyFiltered(r, all), []);
  const f = { ...all, maxCloud: 30, minCoverage: 50,
    t0: Date.parse("2024-02-01T00:00:00Z"), t1: Date.parse("2024-10-31T23:59:59.999Z") };
  // S2A_1: before the window and too cloudy; its cover passes.
  assert.deepEqual(whyFiltered(rows[0], f).map((w) => [w.gate, w.from ?? w.value]),
    [["date", "2024-01-05"], ["cloud", 40]]);
  // S2A_2: only its coverage fails, relaxed down to its own value.
  assert.deepEqual(whyFiltered(rows[1], f).map((w) => [w.gate, w.value]), [["cover", 30]]);
  // S2A_3: a null cover is never a reason, the same rule filterRows keeps.
  assert.deepEqual(whyFiltered(rows[2], f), []);
  // S2A_4: after the window and too cloudy.
  assert.deepEqual(whyFiltered(rows[3], f).map((w) => [w.gate, w.to ?? w.value]),
    [["date", "2024-11-20"], ["cloud", 80]]);
  // A fractional cloud rounds up, so the relaxed slider admits the row.
  const frac = { ...rows[0], cloud: 38.2, t: day("2024-06-01"), day: "2024-06-01" };
  assert.equal(whyFiltered(frac, f)[0].value, 39);
  // The reasons agree with filterRows: a row fails exactly when it has one.
  for (const r of rows) {
    assert.equal(whyFiltered(r, f).length === 0, filterRows([r], f).length === 1, r.id);
  }
});

// --- strip view -------------------------------------------------------------

test("groupWindow clamps to the part and grows by radius", () => {
  // Middle of a part: symmetric.
  assert.deepEqual(groupWindow(625, 271, 20), { lo: 251, hi: 291 });
  // Near each end: clamped, never negative, never past the last group.
  assert.deepEqual(groupWindow(625, 3, 20), { lo: 0, hi: 23 });
  assert.deepEqual(groupWindow(625, 620, 20), { lo: 600, hi: 624 });
  // A radius wider than the part takes the whole part.
  assert.deepEqual(groupWindow(10, 4, 999), { lo: 0, hi: 9 });
  // A single-group part.
  assert.deepEqual(groupWindow(1, 0, 5), { lo: 0, hi: 0 });
  // Radius 0 is the home group alone.
  assert.deepEqual(groupWindow(625, 271, 0), { lo: 271, hi: 271 });
});

test("mergeStrip dedupes by id and keeps acquisition order", () => {
  const a = [{ id: "b", t: 2 }, { id: "a", t: 1 }];
  const b = [{ id: "c", t: 3 }, { id: "b", t: 2 }];
  const out = mergeStrip(a, b);
  assert.deepEqual(out.map((r) => r.id), ["a", "b", "c"]);
  // A widened window re-reads groups it already read, so the same batch
  // can arrive twice. The view must not double up.
  assert.deepEqual(mergeStrip(out, b).map((r) => r.id), ["a", "b", "c"]);
  // An empty batch leaves the view alone.
  assert.deepEqual(mergeStrip(out, []).map((r) => r.id), ["a", "b", "c"]);
  // A tie on time falls back to the id, so the order is stable.
  const tie = mergeStrip([], [{ id: "z", t: 1 }, { id: "y", t: 1 }]);
  assert.deepEqual(tie.map((r) => r.id), ["y", "z"]);
});
