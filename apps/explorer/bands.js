// The band mapper's tables and sample statistics (Task 28): which bands a
// Sentinel-2 L2A scene has, the presets, the SCL palette, the index ramps, and
// the histogram and percentiles of an overview. No I/O here, and no painting:
// the stretch these tables describe runs on the GPU (raster-modules.js), which
// reads the ramps and the palette from here so there is one source for them.
//
// Sample values are the files' DN as stored: uint16 with DN/10000 =
// reflectance for the reflectance bands (0 = nodata; processing baselines
// >= 04.00, January 2022 on, add a BOA offset of 1000 so DN = 10000*rho +
// 1000), uint8 classes for SCL. Stretching works on DN as is — the handles
// show DN — and an index is (a - b) / (a + b) on DN, which cancels the
// 1/10000 scale but not the 1000 offset: on a >= 04.00 scene the raw-DN
// NDVI of a field at rho_nir 0.5, rho_red 0.1 is 0.5 instead of 0.67. So the
// offset is subtracted first when the row says which baseline it is
// (`s2:processing_baseline`, projected by the scene query); a row without
// it gets no correction and the panel says so.

// name -> label (ESA naming), central wavelength, native grid.
export const BANDS = {
  B01: { label: "Coastal aerosol", nm: 443, res: 60 },
  B02: { label: "Blue", nm: 490, res: 10 },
  B03: { label: "Green", nm: 560, res: 10 },
  B04: { label: "Red", nm: 665, res: 10 },
  B05: { label: "Red edge 1", nm: 705, res: 20 },
  B06: { label: "Red edge 2", nm: 740, res: 20 },
  B07: { label: "Red edge 3", nm: 783, res: 20 },
  B08: { label: "NIR", nm: 842, res: 10 },
  B8A: { label: "Narrow NIR", nm: 865, res: 20 },
  B09: { label: "Water vapour", nm: 945, res: 60 },
  B11: { label: "SWIR 1", nm: 1610, res: 20 },
  B12: { label: "SWIR 2", nm: 2190, res: 20 },
  AOT: { label: "Aerosol optical thickness", nm: null, res: 20 },
  WVP: { label: "Water vapour column", nm: null, res: 20 },
  SCL: { label: "Scene classification", nm: null, res: 20 },
};
// Collection 1 scenes also carry Sen2Cor's cloud and snow probability masks
// (assets `cloud` and `snow`: CLD_20m.tif, SNW_20m.tif next to the bands),
// uint8 percent on the 20 m grid. app.js offers them as single bands only
// when that collection is shown; `fixed` is the stretch they open with —
// the whole 0..100 % scale, not the overview's percentiles, so a clear
// scene and an overcast one read on the same grey scale.
export const MASK_BANDS = {
  CLD_20m: { label: "Cloud probability", nm: null, res: 20, fixed: [0, 100] },
  SNW_20m: { label: "Snow probability", nm: null, res: 20, fixed: [0, 100] },
};
export const bandInfo = (b) => BANDS[b] ?? MASK_BANDS[b] ?? null;
export const bandTitle = (b) => {
  const d = bandInfo(b);
  return d ? `${b} ${d.label}${d.nm ? ` ${d.nm} nm` : ""} · ${d.res} m` : b;
};
// [min, max] a band's handles always open at, or null for the percentile seed.
export const fixedRange = (b) => bandInfo(b)?.fixed ?? null;

// The indices: (a - b) / (a + b), and the fixed diverging ramp each is drawn
// with over -1..1 (three stops; the handles narrow the range the ramp spans,
// the ramp itself does not change, and it is linear between the handles —
// the curve and gamma are for bands, where a nonlinear lift has no zero
// point to move). NDVI: brown -> pale -> green, the ColorBrewer BrBG ends.
// NDWI (McFeeters, green/NIR): brown -> pale -> blue, so water is blue and
// land brown.
export const INDICES = {
  ndvi: { label: "NDVI", a: "B08", b: "B04", ramp: ["#8c510a", "#f5f5f5", "#01665e"] },
  ndwi: { label: "NDWI", a: "B03", b: "B08", ramp: ["#a6611a", "#f5f5f5", "#0571b0"] },
};

// ESA's SCL classes and the palette its own products use.
export const SCL_CLASSES = [
  [0, "No data", "#000000"],
  [1, "Saturated / defective", "#ff0000"],
  [2, "Dark area", "#2f2f2f"],
  [3, "Cloud shadow", "#643200"],
  [4, "Vegetation", "#00a000"],
  [5, "Not vegetated", "#ffe65a"],
  [6, "Water", "#0000ff"],
  [7, "Unclassified", "#808080"],
  [8, "Cloud, medium probability", "#c0c0c0"],
  [9, "Cloud, high probability", "#ffffff"],
  [10, "Thin cirrus", "#64c8ff"],
  [11, "Snow / ice", "#ff96ff"],
];

// The presets. `kind` says how the channels are painted: tci is the visual
// COG as is (Task 27's path, already stretched by ESA), rgb three bands,
// gray one, index one ratio, scl the palette. custom and single take their
// bands from the selects.
export const PRESETS = {
  tci: { label: "True color (TCI)", kind: "tci", bands: ["TCI"] },
  fcir: { label: "False color IR", kind: "rgb", bands: ["B08", "B04", "B03"] },
  agri: { label: "Agriculture", kind: "rgb", bands: ["B11", "B08", "B02"] },
  swir: { label: "SWIR", kind: "rgb", bands: ["B12", "B8A", "B04"] },
  ndvi: { label: "NDVI", kind: "index", index: "ndvi" },
  ndwi: { label: "NDWI", kind: "index", index: "ndwi" },
  scl: { label: "SCL classes", kind: "scl", bands: ["SCL"] },
  single: { label: "Single band…", kind: "gray" },
  custom: { label: "Custom RGB", kind: "rgb" },
};

// The distinct bands a spec reads, in channel order.
export function bandsOf(spec) {
  if (spec.kind === "index") { const ix = INDICES[spec.index]; return [ix.a, ix.b]; }
  return [...new Set(spec.bands)];
}

// Histogram and percentiles of one band's overview: the file's nodata (0)
// is left out of the count, so an empty swath edge cannot pull the 2nd
// percentile to zero. 64 bins over the data's own min..max; p2/p98 by a
// numeric sort of the valid samples (a 686 x 686 overview sorts in tens of
// milliseconds).
export function sampleStats(data, nodata = 0) {
  const valid = new Float32Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) { const v = data[i]; if (v !== nodata && Number.isFinite(v)) valid[n++] = v; }
  if (!n) return null;
  const sorted = valid.subarray(0, n).sort();
  const at = (q) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  const min = sorted[0], max = sorted[n - 1];
  return { n, min, max, p2: at(0.02), p98: at(0.98), hist: histogram(sorted, min, max) };
}

// The same for an index over two overviews of the same size, on -1..1.
export function indexStats(a, b, offset = 0, nodata = 0) {
  if (!a || !b || a.length !== b.length) return null;
  const vals = new Float32Array(a.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === nodata || b[i] === nodata) continue;
    const x = a[i] - offset, y = b[i] - offset, v = (x - y) / (x + y);
    if (Number.isFinite(v)) vals[n++] = Math.max(-1, Math.min(1, v));
  }
  if (!n) return null;
  const sorted = vals.subarray(0, n).sort();
  const at = (q) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  return { n, min: -1, max: 1, p2: at(0.02), p98: at(0.98), hist: histogram(sorted, -1, 1) };
}

export const HIST_BINS = 64;
function histogram(values, lo, hi) {
  const bins = new Uint32Array(HIST_BINS), span = hi - lo || 1;
  for (let i = 0; i < values.length; i++) {
    bins[Math.min(HIST_BINS - 1, Math.floor(((values[i] - lo) / span) * HIST_BINS))]++;
  }
  return bins;
}
