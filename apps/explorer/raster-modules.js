// The stretch, as GPU shader modules.
//
// These replace bands.js's paintRGBA. That function painted RGBA bytes on the
// CPU from Float32 sample planes; these inject GLSL into deck.gl's
// DECKGL_FILTER_COLOR hook, so the same arithmetic runs per fragment on the
// band textures that @developmentseed/deck.gl-geotiff uploads. One pipeline
// serves the tiles and the whole-scene preview, so the two cannot disagree.
//
// Units. A COG band is uint16, which the library uploads as `r16unorm`, and
// the sampler returns value / 65535. SCL and the TCI are uint8 (`r8unorm` and
// `rgba8unorm`), which return value / 255. Every module below multiplies the
// sample by `valueScale` to recover the raw digital number, because the
// controls, the histograms and the percentiles in bands.js are all in raw DN.
// Keeping the uniforms in DN means a min/max from a histogram needs no
// conversion.
//
// Nodata. Sentinel-2 writes 0, and bands.js compares the integer exactly. The
// comparison here is `abs(raw - nodata) < 0.5`, which is the same test for
// integer data and does not depend on the unorm divide round-tripping to an
// exact float.
import { CompositeBands } from "@developmentseed/deck.gl-raster/gpu-modules";
import { INDICES, SCL_CLASSES } from "./bands.js";

// The raw-DN scale for a texture of `bits` bits per sample.
export const valueScaleFor = (bits) => 2 ** bits - 1;

// The curve, as the integer the shaders switch on. bands.js names these on
// the spec; the GLSL cannot read a string.
const CURVES = { linear: 0, sqrt: 1, log: 2 };
const curveCode = (curve) => CURVES[curve] ?? 0;

// Shared GLSL: the curve and gamma that makeLut() used to bake into a
// 1024-entry lookup. Evaluated directly here, so there is no table and no
// quantisation to 1024 steps.
//
//   linear  t
//   sqrt    sqrt(t)
//   log     log10(1 + 9t)     keeps 0 -> 0 and 1 -> 1
//
// then gamma as t^(1/gamma), so gamma above 1 brightens the mid-tones.
const CURVE_GLSL = /* glsl */ `
vec3 s2_curve(vec3 t, int curve) {
  if (curve == 1) return sqrt(t);
  if (curve == 2) return log(1.0 + 9.0 * t) / log(10.0);
  return t;
}
`;

// ---------------------------------------------------------------------------
// BandStretch: the rgb and gray kinds.
//
// Per-channel min/max to 0..1, then the curve, then gamma. A channel whose
// band could not be opened is painted black by CompositeBands (its channelMap
// slot is -1) and must not key the pixel out, so `activeMask` says which
// channels carry real data. Matching bands.js: the pixel drops when ANY
// active channel is nodata, and `mono` feeds one channel to all three.
// ---------------------------------------------------------------------------
export const BandStretch = {
  name: "s2BandStretch",
  fs: `\
uniform s2BandStretchUniforms {
  vec3 chanMin;
  vec3 chanMax;
  vec3 activeMask;
  float valueScale;
  float nodata;
  float hasNodata;
  float invGamma;
  float mono;
  int curve;
} s2BandStretch;
`,
  inject: {
    "fs:#decl": CURVE_GLSL,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  {
    vec3 raw = mix(color.rgb, color.rrr, s2BandStretch.mono) * s2BandStretch.valueScale;
    if (s2BandStretch.hasNodata > 0.5) {
      vec3 hit = step(abs(raw - vec3(s2BandStretch.nodata)), vec3(0.5)) * s2BandStretch.activeMask;
      if (hit.r + hit.g + hit.b > 0.5) {
        discard;
      }
    }
    vec3 span = max(s2BandStretch.chanMax - s2BandStretch.chanMin, vec3(1e-9));
    vec3 t = clamp((raw - s2BandStretch.chanMin) / span, 0.0, 1.0);
    t = pow(s2_curve(t, s2BandStretch.curve), vec3(s2BandStretch.invGamma));
    color = vec4(t * s2BandStretch.activeMask, 1.0);
  }
`,
  },
  uniformTypes: {
    chanMin: "vec3<f32>",
    chanMax: "vec3<f32>",
    activeMask: "vec3<f32>",
    valueScale: "f32",
    nodata: "f32",
    hasNodata: "f32",
    invGamma: "f32",
    mono: "f32",
    curve: "i32",
  },
  getUniforms: (props = {}) => ({
    chanMin: props.chanMin ?? [0, 0, 0],
    chanMax: props.chanMax ?? [1, 1, 1],
    activeMask: props.activeMask ?? [1, 1, 1],
    valueScale: props.valueScale ?? 65535,
    nodata: props.nodata ?? 0,
    hasNodata: props.hasNodata ?? 0,
    invGamma: props.invGamma ?? 1,
    mono: props.mono ?? 0,
    curve: props.curve ?? 0,
  }),
};

// ---------------------------------------------------------------------------
// IndexRamp: the index kind (NDVI, NDWI).
//
// Band a arrives in color.r and band b in color.g, through CompositeBands.
// The ratio is (a - offset - (b - offset)) / (a - offset + (b - offset)),
// rescaled from min..max and read off a three-stop ramp. bands.js built a
// 256-entry table through the stops with rampTable(); the mix() pair below is
// the same piecewise-linear interpolation without the table.
// ---------------------------------------------------------------------------
export const IndexRamp = {
  name: "s2IndexRamp",
  fs: `\
uniform s2IndexRampUniforms {
  vec3 rampLo;
  vec3 rampMid;
  vec3 rampHi;
  float rangeMin;
  float rangeMax;
  float offset;
  float valueScale;
  float nodata;
  float hasNodata;
} s2IndexRamp;
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  {
    vec2 raw = color.rg * s2IndexRamp.valueScale;
    if (s2IndexRamp.hasNodata > 0.5 &&
        (abs(raw.r - s2IndexRamp.nodata) < 0.5 || abs(raw.g - s2IndexRamp.nodata) < 0.5)) {
      discard;
    }
    float x = raw.r - s2IndexRamp.offset;
    float y = raw.g - s2IndexRamp.offset;
    float denom = x + y;
    // bands.js drops the 0/0 of a fully dark pixel.
    if (abs(denom) < 1e-9) {
      discard;
    }
    float v = (x - y) / denom;
    float span = max(s2IndexRamp.rangeMax - s2IndexRamp.rangeMin, 1e-9);
    float t = clamp((v - s2IndexRamp.rangeMin) / span, 0.0, 1.0);
    vec3 c = t < 0.5
      ? mix(s2IndexRamp.rampLo, s2IndexRamp.rampMid, t * 2.0)
      : mix(s2IndexRamp.rampMid, s2IndexRamp.rampHi, (t - 0.5) * 2.0);
    color = vec4(c, 1.0);
  }
`,
  },
  uniformTypes: {
    rampLo: "vec3<f32>",
    rampMid: "vec3<f32>",
    rampHi: "vec3<f32>",
    rangeMin: "f32",
    rangeMax: "f32",
    offset: "f32",
    valueScale: "f32",
    nodata: "f32",
    hasNodata: "f32",
  },
  getUniforms: (props = {}) => ({
    rampLo: props.rampLo ?? [0, 0, 0],
    rampMid: props.rampMid ?? [0.5, 0.5, 0.5],
    rampHi: props.rampHi ?? [1, 1, 1],
    rangeMin: props.rangeMin ?? -1,
    rangeMax: props.rangeMax ?? 1,
    offset: props.offset ?? 0,
    valueScale: props.valueScale ?? 65535,
    nodata: props.nodata ?? 0,
    hasNodata: props.hasNodata ?? 0,
  }),
};

// ---------------------------------------------------------------------------
// SclPalette: the scl kind.
//
// The class index arrives in color.r. The palette is a 256 x 1 texture built
// from SCL_CLASSES, so bands.js stays the one place the ESA colours are
// written. A class the list does not name paints opaque black, as the old
// SCL_TABLE did, and nodata keys the pixel out.
//
// The band texture MUST be sampled with `nearest`. A class index is a label,
// and a linear filter between class 4 (vegetation) and class 6 (water) returns
// class 5. sclLayer() in cog.js sets that sampler.
// ---------------------------------------------------------------------------
export const SclPalette = {
  name: "s2SclPalette",
  fs: `\
uniform s2SclPaletteUniforms {
  float valueScale;
  float nodata;
  float hasNodata;
} s2SclPalette;
`,
  inject: {
    "fs:#decl": "uniform sampler2D s2SclPaletteTexture;",
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  {
    float raw = color.r * s2SclPalette.valueScale;
    if (s2SclPalette.hasNodata > 0.5 && abs(raw - s2SclPalette.nodata) < 0.5) {
      discard;
    }
    // The texel centre of the class value in a 256-wide palette.
    float u = (clamp(raw, 0.0, 255.0) + 0.5) / 256.0;
    color = vec4(texture(s2SclPaletteTexture, vec2(u, 0.5)).rgb, 1.0);
  }
`,
  },
  uniformTypes: {
    valueScale: "f32",
    nodata: "f32",
    hasNodata: "f32",
  },
  getUniforms: (props = {}) => ({
    s2SclPaletteTexture: props.paletteTexture,
    valueScale: props.valueScale ?? 255,
    nodata: props.nodata ?? 0,
    hasNodata: props.hasNodata ?? 0,
  }),
};

// ---------------------------------------------------------------------------
// TciNodata: the tci kind.
//
// The TCI is already stretched by ESA, so the only work is the swath edge.
// The library's own FilterNoDataVal reads the red channel alone, which would
// also drop a pixel that is dark red but carries green or blue. The COG's
// GDAL_NODATA is 0 for all three samples, and the old reader required all
// three to be 0 (cogNodata). This keeps that test.
// ---------------------------------------------------------------------------
export const TciNodata = {
  name: "s2TciNodata",
  fs: `\
uniform s2TciNodataUniforms {
  float valueScale;
  float nodata;
} s2TciNodata;
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  {
    vec3 raw = color.rgb * s2TciNodata.valueScale;
    vec3 hit = step(abs(raw - vec3(s2TciNodata.nodata)), vec3(0.5));
    if (hit.r + hit.g + hit.b > 2.5) {
      discard;
    }
    color = vec4(color.rgb, 1.0);
  }
`,
  },
  uniformTypes: { valueScale: "f32", nodata: "f32" },
  getUniforms: (props = {}) => ({
    valueScale: props.valueScale ?? 255,
    nodata: props.nodata ?? 0,
  }),
};

// ---------------------------------------------------------------------------
// JpegPreview: the scene thumbnail.
//
// The thumbnail JPEG paints the swath's nodata in one flat colour -- white on
// thumbnail.jpg, black on preview.jpg and on the thumbnail.jp2 that some 2018
// rows carry -- and the compression smears a fringe of near-that-colour
// pixels along the edge. The CPU version grew a mask one pixel from every
// exact match. This samples the eight neighbours and drops a near-match that
// touches an exact match, which is the same one-pixel growth.
//
// This module is the whole pipeline for a thumbnail: it samples the texture
// itself rather than sit behind CreateTexture, because the fringe test needs
// its own sampler handle for the neighbour taps. `texel` is one pixel step in
// UV, so those taps land on real neighbours.
// ---------------------------------------------------------------------------
export const JpegPreview = {
  name: "s2JpegPreview",
  fs: `\
uniform s2JpegPreviewUniforms {
  vec2 texel;
  float exactLevel;
  float nearLevel;
  float white;
} s2JpegPreview;
`,
  inject: {
    "fs:#decl": /* glsl */ `
uniform sampler2D s2JpegPreviewTexture;
// 1.0 when the sample is at or past the flat nodata colour on all three
// channels. The white flag flips the comparison, because black nodata is a
// floor and white nodata is a ceiling.
float s2_flat(vec3 c, float level, float white) {
  vec3 hit = mix(step(c, vec3(level)), step(vec3(level), c), white);
  return step(2.5, hit.r + hit.g + hit.b);
}
`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  {
    vec3 c = texture(s2JpegPreviewTexture, geometry.uv).rgb;
    float drop = s2_flat(c, s2JpegPreview.exactLevel, s2JpegPreview.white);
    if (drop < 0.5 && s2_flat(c, s2JpegPreview.nearLevel, s2JpegPreview.white) > 0.5) {
      // A near-match next to an exact match is compression fringe.
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          vec2 uv = geometry.uv + vec2(float(dx), float(dy)) * s2JpegPreview.texel;
          vec3 n = texture(s2JpegPreviewTexture, clamp(uv, 0.0, 1.0)).rgb;
          drop = max(drop, s2_flat(n, s2JpegPreview.exactLevel, s2JpegPreview.white));
        }
      }
    }
    if (drop > 0.5) {
      discard;
    }
    color = vec4(c, 1.0);
  }
`,
  },
  uniformTypes: {
    texel: "vec2<f32>",
    exactLevel: "f32",
    nearLevel: "f32",
    white: "f32",
  },
  getUniforms: (props = {}) => ({
    s2JpegPreviewTexture: props.previewTexture,
    texel: props.texel ?? [0, 0],
    // The CPU thresholds, as unorm: white nodata was >= 250 exact and >= 235
    // near; black nodata was == 0 exact and <= 24 near.
    exactLevel: props.exactLevel ?? 0,
    nearLevel: props.nearLevel ?? 0,
    white: props.white ?? 0,
  }),
};

export const JPEG_WHITE = { exactLevel: 250 / 255, nearLevel: 235 / 255, white: 1 };
export const JPEG_BLACK = { exactLevel: 0.5 / 255, nearLevel: 24 / 255, white: 0 };

// ---------------------------------------------------------------------------
// Building the pipelines from a spec.
// ---------------------------------------------------------------------------

const hex = (c) => [
  parseInt(c.slice(1, 3), 16) / 255,
  parseInt(c.slice(3, 5), 16) / 255,
  parseInt(c.slice(5, 7), 16) / 255,
];

// The 256 x 1 RGBA palette SclPalette samples. One per device, because a
// texture cannot outlive its device and the colours never change.
const sclTextures = new WeakMap();
export function sclPaletteTexture(device) {
  let texture = sclTextures.get(device);
  if (!texture) {
    const data = new Uint8Array(256 * 4);
    for (const [v, , colour] of SCL_CLASSES) {
      const [r, g, b] = hex(colour);
      data.set([r * 255, g * 255, b * 255, 255], v * 4);
    }
    // Every class the list does not name stays opaque black, as SCL_TABLE was.
    for (let v = 0; v < 256; v++) data[v * 4 + 3] = 255;
    texture = device.createTexture({
      data, format: "rgba8unorm", width: 256, height: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest",
        addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
    });
    sclTextures.set(device, texture);
  }
  return texture;
}

// The nodata uniforms a spec asks for. bands.js keeps `spec.nodata` as the
// raw value to key out, or null for none.
function nodataProps(spec) {
  const nd = spec.nodata === null || spec.nodata === undefined ? null : Number(spec.nodata);
  return { nodata: nd ?? 0, hasNodata: nd === null ? 0 : 1 };
}

// The pipeline for the rgb and gray kinds, over band textures already bound
// by CompositeBands. `active` says which of the three channels carry a band
// that opened.
export function stretchModule(spec, { valueScale, active = [1, 1, 1] }) {
  const chans = spec.kind === "gray"
    ? [spec.channels[0], spec.channels[0], spec.channels[0]]
    : spec.channels;
  return {
    module: BandStretch,
    props: {
      chanMin: chans.map((c) => c.min),
      chanMax: chans.map((c) => c.max),
      activeMask: active,
      valueScale,
      invGamma: 1 / Math.max(0.05, Number(spec.gamma) || 1),
      curve: curveCode(spec.curve),
      mono: spec.kind === "gray" ? 1 : 0,
      ...nodataProps(spec),
    },
  };
}

// The pipeline for the index kind.
export function indexModule(spec, { valueScale }) {
  const ramp = INDICES[spec.index].ramp.map(hex);
  const ch = spec.channels[0];
  return {
    module: IndexRamp,
    props: {
      rampLo: ramp[0], rampMid: ramp[1], rampHi: ramp[2],
      rangeMin: ch.min, rangeMax: ch.max,
      offset: spec.offset || 0,
      valueScale,
      ...nodataProps(spec),
    },
  };
}

// The pipeline for the scl kind.
export function sclModule(spec, { valueScale, device }) {
  return {
    module: SclPalette,
    props: { paletteTexture: sclPaletteTexture(device), valueScale, ...nodataProps(spec) },
  };
}

// CompositeBands bound to a spec's bands. `slots` maps a band name to its
// texture slot; a band that failed to open has no slot and its channel gets
// -1, which CompositeBands paints as 0.
export function compositeModule(spec, slots, textures, uvTransforms) {
  const order = channelBands(spec);
  const slotOf = (band) => (band && slots.has(band) ? slots.get(band) : -1);
  const ident = [0, 0, 1, 1];
  return {
    module: CompositeBands,
    props: {
      band0: textures[0], band1: textures[1], band2: textures[2], band3: textures[3],
      uvTransform0: uvTransforms[0] ?? ident, uvTransform1: uvTransforms[1] ?? ident,
      uvTransform2: uvTransforms[2] ?? ident, uvTransform3: uvTransforms[3] ?? ident,
      channelMap: [slotOf(order[0]), slotOf(order[1]), slotOf(order[2]), -1],
    },
  };
}

// The band each output channel reads, in r, g, b order. An index puts its two
// bands in r and g; a gray spec puts its one band in r and BandStretch's
// `mono` spreads it.
export function channelBands(spec) {
  if (spec.kind === "index") {
    const ix = INDICES[spec.index];
    return [ix.a, ix.b, null];
  }
  if (spec.kind === "gray" || spec.kind === "scl") return [spec.bands[0], null, null];
  return [spec.channels[0]?.band, spec.channels[1]?.band, spec.channels[2]?.band];
}
