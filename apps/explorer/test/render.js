// Render harness for the raster layers. Not part of the app and not
// published: it puts one real Sentinel-2 scene on a bare Deck instance, one
// layer path at a time, and reports what reached the framebuffer. The app's
// own search, map and panel are not involved, so a failure here is the
// reader's or the shader's.
//
// Run it through test/render.mjs, which drives it in headless Chrome and
// checks the numbers.
import { COORDINATE_SYSTEM, Deck, MapView } from "@deck.gl/core";
import * as affine from "@developmentseed/affine";
import { RasterLayer } from "@developmentseed/deck.gl-raster";
import { CompositeBands } from "@developmentseed/deck.gl-raster/gpu-modules";
import { BandStretch, IndexRamp } from "../raster-modules.js";
import {
  bandTileLayer, cogTileLayer, openScene, previewImage, previewLayer, sceneCog,
  loadOverviews, tciOverviewImage,
} from "../cog.js";

const DIR = new URLSearchParams(location.search).get("dir")
  ?? "https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com"
   + "/sentinel-2-c1-l2a/31/U/ES/2024/7/S2B_T31UES_20240730T104209_L2A";

const results = [];
window.HARNESS = { done: false, results };

// Fraction of the canvas that is not transparent, and the mean colour of the
// pixels that are. A layer that silently drew nothing gives coverage 0; a
// layer whose nodata test is inverted gives coverage near 1 with a mean at
// the flat colour.
function readback(canvas) {
  const gl = canvas.getContext("webgl2");
  const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let opaque = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue;
    opaque++; r += px[i]; g += px[i + 1]; b += px[i + 2];
  }
  return {
    coverage: +(opaque / (w * h)).toFixed(4),
    mean: opaque ? [r, g, b].map((c) => Math.round(c / opaque)) : null,
  };
}

const deck = new Deck({
  parent: document.getElementById("map"),
  views: new MapView({ repeat: false }),
  initialViewState: { longitude: 0, latitude: 0, zoom: 1 },
  controller: false,
  // No basemap: every opaque pixel on the canvas came from the layer.
  layers: [],
});
await new Promise((resolve) => { deck.setProps({ onLoad: resolve }); });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Put one layer up over the scene's own bounds, wait for it, read back.
async function show(name, layer, bounds, { tiles = false, ms = 4000 } = {}) {
  const [west, south, east, north] = bounds;
  const viewState = {
    longitude: (west + east) / 2, latitude: (south + north) / 2,
    zoom: tiles ? 9 : 7,
  };
  let loaded = !tiles;
  const wrapped = tiles
    ? layer.clone({ onViewportLoad: () => { loaded = true; } })
    : layer;
  deck.setProps({ layers: [wrapped], initialViewState: viewState, viewState });
  const deadline = Date.now() + (tiles ? 60000 : 20000);
  while (!loaded && Date.now() < deadline) await settle(250);
  await settle(ms);
  deck.redraw("harness");
  await settle(400);
  const out = { name, loaded, ...readback(deck.canvas) };
  results.push(out);
  deck.setProps({ layers: [] });
  await settle(200);
  return out;
}

// A RasterLayer over float copies of a spec's overviews. Diagnostic only:
// the app uses the library's own texture path.
function floatCompositeLayer(scene, spec, id, channels) {
  const device = deck.deviceManager?.devices?.[0] ?? deck.device;
  const overs = spec.bands.map((band) => scene.overviews.get(band).value);
  const primary = overs.reduce((a, b) => (a.array.width >= b.array.width ? a : b));
  const textures = overs.map((o) => device.createTexture({
    data: Float32Array.from(o.array.data),
    format: "r32float",
    width: o.array.width, height: o.array.height,
    sampler: { minFilter: "linear", magFilter: "linear" },
  }));
  while (textures.length < 4) textures.push(textures[0]);
  const ident = [0, 0, 1, 1];
  const af = primary.array.transform;
  const inv = affine.invert(af);
  const { converter } = primary.cog;
  const isIndex = spec.kind === "index";
  return new RasterLayer({
    id,
    width: primary.array.width, height: primary.array.height,
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    reprojectionFns: {
      forwardTransform: (x, y) => affine.apply(af, x, y),
      inverseTransform: (x, y) => affine.apply(inv, x, y),
      forwardReproject: (x, y) => converter.forward([x, y], false),
      inverseReproject: (x, y) => converter.inverse([x, y], false),
    },
    renderPipeline: [
      {
        module: CompositeBands,
        props: {
          band0: textures[0], band1: textures[1], band2: textures[2], band3: textures[3],
          uvTransform0: ident, uvTransform1: ident, uvTransform2: ident, uvTransform3: ident,
          channelMap: isIndex ? [0, 1, -1, -1] : [0, 1, 2, -1],
        },
      },
      isIndex
        ? { module: IndexRamp, props: { rampLo: [0.55, 0.32, 0.04], rampMid: [0.96, 0.96, 0.96],
          rampHi: [0.004, 0.4, 0.37], rangeMin: -1, rangeMax: 1, offset: 0,
          valueScale: 1, nodata: 0, hasNodata: 1 } }
        : { module: BandStretch, props: {
          chanMin: channels.map((c) => c.min), chanMax: channels.map((c) => c.max),
          activeMask: [1, 1, 1], valueScale: 1, nodata: 0, hasNodata: 1,
          invGamma: 1, mono: 0, curve: 0 } },
    ],
  });
}

const spec = (over) => ({
  curve: "linear", gamma: 1, nodata: 0, offset: 0, ...over,
});

try {
  // 1. The TCI, as the preview ladder's three rungs and then as tiles.
  const scene = openScene("harness", DIR);
  const cog = await sceneCog(scene, "TCI");
  results.push({ name: "openCog", epsg: cog.epsg, w: cog.w, h: cog.h,
    bands: cog.bands, nodata: cog.nodata, bounds: cog.bounds.map((v) => +v.toFixed(4)) });

  const resp = await fetch(`${DIR}/L2A_PVI.jpg`);
  const bitmap = await createImageBitmap(await resp.blob());
  const thumb = previewImage(cog, bitmap, { white: false });
  await show("preview:jpeg", previewLayer(thumb, cog, "p1"), cog.bounds);

  const hd = await tciOverviewImage(cog);
  results.push({ name: "tciOverviewImage", width: hd.width, height: hd.height });
  await show("preview:tci-overview", previewLayer(hd, cog, "p2"), cog.bounds);

  await show("tiles:tci", cogTileLayer(cog, "t1"), cog.bounds, { tiles: true });

  // 2. A three-band composite, its preview and its tiles.
  const rgbSpec = spec({
    kind: "rgb", bands: ["B08", "B04", "B03"],
    channels: [{ band: "B08", min: 0, max: 4000 }, { band: "B04", min: 0, max: 3000 },
      { band: "B03", min: 0, max: 3000 }],
  });
  const failed = await loadOverviews(scene, rgbSpec.bands);
  results.push({ name: "loadOverviews", failed: failed.map(([b]) => b) });
  const { bandPreviewImage } = await import("../cog.js");
  const rgbPrev = bandPreviewImage(scene, rgbSpec);
  await show("preview:rgb", previewLayer(rgbPrev, scene, "p3"), scene.bounds);
  await show("tiles:rgb", bandTileLayer(scene, rgbSpec, "k", "t2"), scene.bounds, { tiles: true });

  // Diagnostics. CompositeBands with no module after it shows the raw
  // samples: reflectance over 65535 is very dark but alpha is 1, so coverage
  // says whether the band textures bound at all. The second drops the nodata
  // test, to tell "nothing sampled" from "everything discarded".
  const { MultiCOGLayer } = await import("@developmentseed/deck.gl-geotiff");
  const { epsgResolver } = await import("../cog.js");
  const sources = {
    B08: { url: `${DIR}/B08.tif` }, B04: { url: `${DIR}/B04.tif` },
    B03: { url: `${DIR}/B03.tif` },
  };
  const common = {
    sources, composite: { r: "B08", g: "B04", b: "B03" },
    extent: scene.bounds, minZoom: 4, maxZoom: 15, epsgResolver,
  };
  await show("diag:composite-only",
    new MultiCOGLayer({ id: "d1", ...common, renderPipeline: [] }),
    scene.bounds, { tiles: true });
  await show("diag:rgb-no-nodata",
    bandTileLayer(scene, { ...rgbSpec, nodata: null }, "k", "d2"),
    scene.bounds, { tiles: true });

  // Does this renderer support 16-bit normalized textures? Without
  // EXT_texture_norm16 a uint16 band cannot be sampled at all and every
  // reflectance band reads zero. SwiftShader has no such support, so the
  // headless numbers above are the renderer's limit, not the shader's.
  const norm16 = (() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    return !!gl && gl.getSupportedExtensions().includes("EXT_texture_norm16");
  })();
  results.push({ name: "EXT_texture_norm16", supported: norm16 });

  // So the band math is proven over a format every WebGL2 renderer samples:
  // the same overviews, uploaded as r32float, through the same CompositeBands
  // and BandStretch. A float texture is not normalized, so the raw DN arrives
  // directly and valueScale is 1.
  await show("diag:float-rgb", floatCompositeLayer(scene, rgbSpec, "f1",
    [{ band: "B08", min: 0, max: 4000 }, { band: "B04", min: 0, max: 3000 },
      { band: "B03", min: 0, max: 3000 }]), scene.bounds);

  // 3. An index (two bands, the ratio and the ramp).
  const ndviSpec = spec({
    kind: "index", index: "ndvi", bands: ["B08", "B04"],
    channels: [{ index: "ndvi", min: -1, max: 1 }],
  });
  await loadOverviews(scene, ndviSpec.bands);
  await show("preview:ndvi", previewLayer(bandPreviewImage(scene, ndviSpec), scene, "p4"), scene.bounds);
  await show("tiles:ndvi", bandTileLayer(scene, ndviSpec, "k", "t3"), scene.bounds, { tiles: true });
  await show("diag:float-ndvi", floatCompositeLayer(scene, ndviSpec, "f2", null), scene.bounds);

  // 4. SCL: the palette, through the nearest-sampled single-band path.
  const sclSpec = spec({ kind: "scl", bands: ["SCL"], channels: [] });
  await loadOverviews(scene, sclSpec.bands);
  await show("preview:scl", previewLayer(bandPreviewImage(scene, sclSpec), scene, "p5"), scene.bounds);
  await show("tiles:scl", bandTileLayer(scene, sclSpec, "k", "t4"), scene.bounds, { tiles: true });

  // 5. A single band, grey.
  const graySpec = spec({
    kind: "gray", bands: ["B08"],
    channels: [{ band: "B08", min: 0, max: 4000 }],
  });
  await loadOverviews(scene, graySpec.bands);
  await show("preview:gray", previewLayer(bandPreviewImage(scene, graySpec), scene, "p6"), scene.bounds);
  await show("tiles:gray", bandTileLayer(scene, graySpec, "k", "t5"), scene.bounds, { tiles: true });
} catch (err) {
  results.push({ name: "ERROR", message: err.message, stack: String(err.stack).slice(0, 600) });
}
window.HARNESS.done = true;
