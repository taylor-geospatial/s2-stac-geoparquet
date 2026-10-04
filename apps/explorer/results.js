// The derived pipeline of the search results: raw year rows in, the
// filtered and sorted view out. Pure functions, no DOM, no imports, so
// `node --test` runs them (results.test.mjs).
const cmpId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// `label` names the column and fits the control. `tip` says which end of
// it comes first, and the select carries the tip of whatever is chosen.
export const SORTS = {
  cloud: { label: "cloud", tip: "Least cloud first, so the clearest scene leads.",
    cmp: (a, b) => a.cloud - b.cloud || cmpId(a, b) },
  coverage: { label: "coverage",
    tip: "Most coverage first, so the fullest scene leads. A scene with no "
      + "coverage figure sorts last.",
    cmp: (a, b) => (b.cover ?? -1) - (a.cover ?? -1) || a.cloud - b.cloud || cmpId(a, b) },
  date: { label: "date", tip: "Newest first.",
    cmp: (a, b) => b.t - a.t || cmpId(a, b) },
};

// A null cover means "unknown", and the floor never excludes what it
// cannot judge — the same rule fillColor applies on the map.
export function filterRows(rows, f) {
  return rows.filter((r) => r.t >= f.t0 && r.t <= f.t1
    && r.cloud <= f.maxCloud
    && (f.minCoverage <= 0 || r.cover === null || r.cover >= f.minCoverage));
}

// Why a row fails the filters, one entry per failing gate, in the order the
// panel lists the controls: the date window, max cloud, min coverage. An
// empty list means the row passes. Each entry carries the loosest value of
// that gate that lets the row through, so a caller can relax the gate to
// exactly there and no further: `from`/`to` for the window (the row's day),
// the whole-number slider value for cloud (rounded up) and coverage
// (rounded down). Mirrors filterRows gate for gate.
export function whyFiltered(r, f) {
  const out = [];
  if (r.t < f.t0) out.push({ gate: "date", text: `${r.day} is before the date window`, from: r.day });
  if (r.t > f.t1) out.push({ gate: "date", text: `${r.day} is after the date window`, to: r.day });
  if (r.cloud > f.maxCloud) {
    out.push({ gate: "cloud", text: `${r.cloud.toFixed(1)}% cloud, over the ${f.maxCloud}% max`,
      value: Math.ceil(r.cloud) });
  }
  if (f.minCoverage > 0 && r.cover !== null && r.cover < f.minCoverage) {
    out.push({ gate: "cover", text: `${r.cover.toFixed(1)}% coverage, under the ${f.minCoverage}% min`,
      value: Math.floor(r.cover) });
  }
  return out;
}

// hasOwn, not `SORTS[key] ?? SORTS.cloud`: "__proto__", "constructor" and
// "toString" all find something on the prototype chain, so the ?? never
// fires and `.cmp` comes back undefined — .sort(undefined) is a lexicographic
// sort by string, not the cloud order the fallback promises.
export function sortRows(rows, key) {
  const s = Object.hasOwn(SORTS, key) ? SORTS[key] : SORTS.cloud;
  return [...rows].sort(s.cmp);
}

export function viewOf(rows, f, key) {
  return sortRows(filterRows(rows, f), key);
}

export function indexOfId(view, id) {
  return view.findIndex((r) => r.id === id);
}

export function clampIndex(view, i) {
  return view.length ? Math.min(view.length - 1, Math.max(0, i)) : -1;
}

export function filterKeyOf(f, key, search) {
  return [search?.tile, search?.year, search?.at,
    f.t0, f.t1, f.maxCloud, f.minCoverage, key].join("|");
}
