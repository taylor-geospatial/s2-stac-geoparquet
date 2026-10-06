// A Sentinel-2 scene on the map, with no server in between, through
// @developmentseed/deck.gl-raster.
//
// The library owns the two hard parts. Its COGLayer and MultiCOGLayer read a
// COG's overviews by range request and pick the level that matches the zoom,
// and its RasterLayer reprojects the UTM grid to Web Mercator on the GPU: it
// triangulates the image into a mesh whose vertices are placed by exact
// forward projection, then refines that mesh until the reprojection error is
// under an eighth of an input pixel. This file is the Sentinel-2 part only:
// which COGs a scene is made of, what the stretch does, and the preview that
// shows while the tiles load.
//
// What this replaces. The previous version of this file did the same work on
// the CPU: a control grid of lon/lat to UTM pixel coordinates every 16 output
// pixels, a nearest-neighbour walk over an overview window per tile, a
// Float32 sample plane per tile and band, and an RGBA painter over those
// planes. The warp, the plane cache and the painter are all gone. The stretch
// the painter applied is now GLSL (raster-modules.js), which the tiles and
// the preview share, so the two cannot disagree.
//
// Bands. Every band is its own COG in the scene directory (B02.tif, B08.tif,
// SCL.tif, ...) on its own 10, 20 or 60 m grid. MultiCOGLayer takes them as
// named sources, drives the tile grid from the finest one, samples the
// coarser ones at their closest level and stitches them, and hands every band
// to the shader with its own UV transform. That is the per-band grid problem
// the old reader solved by warping each band separately.
//
// Routing. A band count and a sampler decide the layer:
//
//   tci        COGLayer, one 8-bit RGB source, nodata on all three samples
//   scl        COGLayer, nearest sampling, because a class index is a label
//   gray/rgb   MultiCOGLayer, one to three sources, per-channel stretch
//   index      MultiCOGLayer, two sources, the ratio and a three-stop ramp
//
// The tci and scl paths pass their own getTileData and renderTile, which the
// library supports as a pair, because neither the all-three-samples nodata
// test nor nearest sampling is what its inferred pipeline chooses.
import { COORDINATE_SYSTEM, CompositeLayer } from "@deck.gl/core";
import * as affine from "@developmentseed/affine";
import {
  COGLayer, MultiCOGLayer, addAlphaChannel, inferTextureFormat,
} from "@developmentseed/deck.gl-geotiff";
import { RasterLayer } from "@developmentseed/deck.gl-raster";
import { CreateTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import { GeoTIFF, assembleTiles } from "@developmentseed/geotiff";
import { epsgResolver as remoteEpsgResolver, transformBounds } from "@developmentseed/proj";
import proj4 from "proj4";
import { sampleStats, indexStats, bandsOf } from "./bands.js";
import {
  JPEG_BLACK, JPEG_WHITE, JpegPreview, TciNodata, channelBands, compositeModule,
  indexModule, sclModule, stretchModule, valueScaleFor,
} from "./raster-modules.js";

const TILE_MIN_ZOOM = 4;
const TILE_MAX_ZOOM = 15;
const PREVIEW_MIN = 256;    // the stats overview's long side, at least
const HD_TARGET = 1200;     // the mid-resolution rung's long side

// ---------------------------------------------------------------------------
// The projection.
//
// Every Sentinel-2 scene is on a UTM/WGS84 grid, so the EPSG code is 326NN
// north or 327NN south and the definition follows from the zone. The library's
// default resolver asks epsg.io for the PROJJSON of a code it has not seen,
// which is one network round trip per scene before any pixel is read. This
// builds the definition locally in the shape wkt-parser returns, which is what
// the library and proj4 both consume, and falls back to the network only for a
// code that is not a UTM zone.
// ---------------------------------------------------------------------------
const utmDefs = new Map();
export function utmProjection(epsg) {
  if (utmDefs.has(epsg)) return utmDefs.get(epsg);
  const series = Math.floor(epsg / 100);
  if (series !== 326 && series !== 327) return null;
  const zone = epsg % 100;
  if (zone < 1 || zone > 60) return null;
  const def = {
    title: `EPSG:${epsg}`,
    name: `WGS 84 / UTM zone ${zone}${series === 327 ? "S" : "N"}`,
    projName: "Transverse Mercator",
    ellps: "WGS 84",
    a: 6378137,
    rf: 298.257223563,
    axis: "enu",
    units: "meter",
    to_meter: 1,
    datumCode: "EPSG_4326",
    lat0: 0,
    // The zone's central meridian, in radians.
    long0: ((zone * 6 - 183) * Math.PI) / 180,
    x0: 500000,
    y0: series === 327 ? 10000000 : 0,
    k0: 0.9996,
  };
  utmDefs.set(epsg, def);
  return def;
}

// The resolver handed to every layer. A Sentinel-2 grid never reaches the
// network; anything else falls back to the library's own resolver, which asks
// epsg.io.
export async function epsgResolver(epsg) {
  return utmProjection(epsg) ?? remoteEpsgResolver(epsg);
}

// proj4's converter between a COG's CRS and lon/lat. The library builds the
// same converter from the same definition for the tiles, so the preview and
// the tiles place a pixel identically.
const converterFor = (projection) => proj4(projection, "EPSG:4326");

// ---------------------------------------------------------------------------
// What this renderer can sample.
//
// A reflectance band is uint16, which the library uploads as an `r16unorm`
// texture, and WebGL2 can only sample that format with EXT_texture_norm16.
// Where the extension is missing every band reads zero, so a composite comes
// out black with nothing in the console to say why. The TCI and SCL are 8-bit
// and are not affected.
//
// Measured: a software renderer (SwiftShader, which is what Chrome falls back
// to with no GPU) does not have the extension. Desktop GPUs generally do.
let norm16 = null;
export function canSampleUint16() {
  if (norm16 === null) {
    const gl = document.createElement("canvas").getContext("webgl2");
    norm16 = !!gl && gl.getSupportedExtensions().includes("EXT_texture_norm16");
  }
  return norm16;
}

// ---------------------------------------------------------------------------
// Opening a COG.
//
// Only the headers are read, and the chunk cache that serves them goes on to
// serve the tile reads. The 64 KB chunk matters: a Sentinel-2 COG keeps all
// five IFDs inside the first few KB, so one chunk holds the whole pyramid
// description. Asking for exactly the bytes the parser wants costs about a
// dozen sequential round trips instead.
// ---------------------------------------------------------------------------
export async function openCog(href, signal) {
  const geotiff = await GeoTIFF.fromUrl(href, { chunkSize: 65536, cacheSize: 100, signal });
  const crs = geotiff.crs;
  if (typeof crs !== "number") {
    throw new Error(`${href} carries an inline CRS; only Sentinel-2 UTM grids are supported`);
  }
  const projection = utmProjection(crs);
  if (!projection) {
    throw new Error(`EPSG:${crs} is not a UTM/WGS84 code; only Sentinel-2 grids are supported`);
  }
  const converter = converterFor(projection);
  const toLngLat = (x, y) => converter.forward([x, y], false);
  // The UTM box edges curve in lon/lat, so the bounds come from sampling them,
  // not from the four corners. transformBounds does that sampling.
  const [west, south, east, north] = transformBounds(toLngLat, ...geotiff.bbox);
  const bits = geotiff.cachedTags.bitsPerSample[0];
  return {
    href, geotiff, projection, converter, epsg: crs,
    bits, valueScale: valueScaleFor(bits),
    nodata: geotiff.nodata,
    w: geotiff.width, h: geotiff.height,
    bands: geotiff.count,
    bounds: [west, south, east, north],
  };
}

// ---------------------------------------------------------------------------
// Reading whole levels, for the histograms and the previews.
// ---------------------------------------------------------------------------

// The image or overview whose long side first reaches `target`, or the closest
// there is. `geotiff.overviews` holds the coarser levels and `geotiff` itself
// is the finest, so both ends are candidates.
function levelAtLeast(cog, target) {
  const levels = [...cog.geotiff.overviews, cog.geotiff];
  let best = null;
  for (const level of levels) {
    const long = Math.max(level.width, level.height);
    if (long >= target && (!best || long < Math.max(best.width, best.height))) best = level;
  }
  if (best) return best;
  // Nothing reaches the target: the largest level there is.
  return levels.reduce((a, b) =>
    (Math.max(a.width, a.height) >= Math.max(b.width, b.height) ? a : b));
}

// One level read whole as a single RasterArray. A coarse Sentinel-2 overview
// is one or a few tiles, so this is a handful of range requests against a
// cache the headers already warmed.
//
// A TIFF stores an edge tile at full size, so the tile grid is wider and
// taller than the level it holds: the 1372 px level of a 10,980 px band is
// three 512 px tiles across, which is 1536. assembleTiles wants to be told
// that whole grid, and its result is padded to it, so the padding comes off
// here. Leaving it on would stretch the level's affine over the padding and
// place every pixel short of where it belongs.
async function readLevel(level, signal) {
  const { x: nx, y: ny } = level.tileCount;
  const xy = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) xy.push([x, y]);
  const tiles = await level.fetchTiles(xy, { boundless: false, signal });
  if (tiles.some((t) => t.array.layout === "band-separate")) {
    throw new Error("band-separate COGs are not supported");
  }
  const array = nx === 1 && ny === 1 ? tiles[0].array : assembleTiles(tiles, {
    width: nx * level.tileWidth, height: ny * level.tileHeight,
    tileWidth: level.tileWidth, tileHeight: level.tileHeight,
    minCol: 0, minRow: 0,
  });
  return crop(array, level.width, level.height);
}

// A pixel-interleaved RasterArray cut to its top-left w x h. The affine is
// unchanged, because the origin does not move.
function crop(array, w, h) {
  if (array.width === w && array.height === h) return array;
  const { count } = array;
  const data = new array.data.constructor(w * h * count);
  for (let y = 0; y < h; y++) {
    data.set(array.data.subarray(y * array.width * count, (y * array.width + w) * count),
      y * w * count);
  }
  let mask = null;
  if (array.mask) {
    mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      mask.set(array.mask.subarray(y * array.width, y * array.width + w), y * w);
    }
  }
  return { ...array, data, mask, width: w, height: h };
}

// ---------------------------------------------------------------------------
// Tile layers.
// ---------------------------------------------------------------------------

const LINEAR = { minFilter: "linear", magFilter: "linear" };
const NEAREST = { minFilter: "nearest", magFilter: "nearest" };

// A getTileData/renderTile pair for a single-source COGLayer. `sampler` picks
// the filter and `modules` is the pipeline after the texture is bound.
//
// This mirrors the library's own inferred pipeline for unsigned-integer data,
// through the helpers it exports for the purpose (addAlphaChannel,
// inferTextureFormat), and differs only in the modules it appends.
function singleSourcePipeline(cog, sampler, modules) {
  const { bitsPerSample, sampleFormat } = cog.geotiff.cachedTags;
  const getTileData = async (image, { device, x, y, signal, pool }) => {
    const tile = await image.fetchTile(x, y, { boundless: false, pool, signal });
    let { array } = tile;
    let samples = array.count;
    if (samples === 3) {
      // WebGL2 has no three-channel texture format; it wants RGBA.
      array = addAlphaChannel(array);
      samples = 4;
    }
    const texture = device.createTexture({
      data: array.data,
      format: inferTextureFormat(samples, bitsPerSample, sampleFormat),
      width: array.width, height: array.height,
      sampler,
    });
    return {
      texture, width: array.width, height: array.height,
      byteLength: array.data.byteLength,
    };
  };
  const renderTile = (data) => ({
    renderPipeline: [
      { module: CreateTexture, props: { textureName: data.texture } },
      ...modules,
    ],
  });
  return { getTileData, renderTile };
}

// Props every tile layer shares. The extent clips the tileset to the scene's
// own footprint, so no tile outside it is ever requested.
const tileProps = (bounds, events) => ({
  extent: bounds,
  minZoom: TILE_MIN_ZOOM,
  maxZoom: TILE_MAX_ZOOM,
  maxRequests: 6,
  refinementStrategy: "no-overlap",
  epsgResolver,
  ...events,
});

const tciModule = (cog) => ({
  module: TciNodata,
  props: { valueScale: cog.valueScale, nodata: cog.nodata ?? 0 },
});

// The visual (TCI) COG: three 8-bit samples ESA has already stretched, so the
// only work is the swath edge. See TciNodata for why the library's own
// FilterNoDataVal is not used here.
export function cogTileLayer(cog, id = "cog", events = {}) {
  return new COGLayer({
    id,
    geotiff: cog.geotiff,
    ...tileProps(cog.bounds, events),
    ...singleSourcePipeline(cog, LINEAR, [tciModule(cog)]),
  });
}

// One scene's composite. `styleKey` no longer forces a repaint: the stretch is
// uniforms, so a new min, curve, gamma or nodata reaches the shader on the
// next frame without refetching or repainting a tile. It stays in the
// signature because app.js keys its layer ids on it.
export function bandTileLayer(scene, spec, styleKey, id, events = {}) {
  const { kind } = scene && spec;
  if (kind === "scl" || kind === "tci") {
    const cog = settledCog(scene, spec.bands[0]);
    if (!cog) return null;
    return new SingleBandLayer({
      id, cog, spec,
      sampler: kind === "scl" ? NEAREST : LINEAR,
      ...tileProps(scene.bounds, events),
    });
  }
  // gray, rgb and index: the bands that opened become named sources, and a
  // channel whose band failed maps to nothing, which CompositeBands paints as
  // zero. That is the old painter's rule -- the channel goes black and the
  // others still show.
  const order = channelBands(spec);
  const opened = bandsOf(spec).filter((band) => settledCog(scene, band));
  if (!opened.length) return null;
  const sources = Object.fromEntries(opened.map((band) =>
    [band, { url: bandHref(scene.dir, band) }]));
  const pick = (band) => (band && opened.includes(band) ? band : undefined);
  const composite = kind === "index"
    ? { r: pick(order[0]), g: pick(order[1]) }
    : { r: pick(order[0]), g: pick(order[1]), b: pick(order[2]) };
  const { valueScale } = settledCog(scene, opened[0]);
  const active = kind === "gray"
    ? [1, 1, 1]
    : [0, 1, 2].map((i) => (pick(order[i]) ? 1 : 0));
  return new MultiCOGLayer({
    id,
    sources,
    composite,
    renderPipeline: [kind === "index"
      ? indexModule(spec, { valueScale })
      : stretchModule(spec, { valueScale, active })],
    ...tileProps(scene.bounds, events),
  });
}

// A COGLayer whose pipeline needs the GPU device -- the SCL palette texture
// lives on it -- so the modules are built in the layer's own lifecycle rather
// than by the caller.
class SingleBandLayer extends CompositeLayer {
  static layerName = "SingleBandLayer";

  renderLayers() {
    const { cog, spec, sampler } = this.props;
    const pipeline = spec.kind === "scl"
      ? [sclModule(spec, { valueScale: cog.valueScale, device: this.context.device })]
      : [tciModule(cog)];
    return new COGLayer(this.getSubLayerProps({
      id: "cog",
      geotiff: cog.geotiff,
      ...singleSourcePipeline(cog, sampler, pipeline),
    }));
  }
}

// ---------------------------------------------------------------------------
// Previews.
//
// The scrub ladder keeps its shape: the scene's thumbnail JPEG goes up as soon
// as the COG headers say where it belongs, a mid-resolution rung from the
// COG's own overview replaces it while the user flips through dates, and the
// tiles replace that on a commit. What changed is that none of the three is
// warped on the CPU any more. Each is one RasterLayer -- the same reprojection
// the tiles use, over one whole image instead of a tile grid -- so a preview
// is one GPU upload and no pixel loop.
//
// The *Image functions return a source: a plain description of what to draw,
// which app.js caches and hands to previewLayer. They do no GPU work, because
// a texture needs a device and a device belongs to a layer.
// ---------------------------------------------------------------------------

// The thumbnail JPEG as a preview source. Sync and cheap now: no canvas, no
// getImageData, no mask grown on the CPU. The bitmap goes to the GPU as it is
// and JpegPreview keys out the flat nodata colour and its fringe.
//
// One scale serves both axes, so the thumbnail must have the COG's shape; a
// thumbnail cut to another shape would be stretched into the wrong place.
// More than a pixel off: no preview.
export function previewImage(cog, bitmap, { white = false } = {}) {
  if (Math.abs(bitmap.width * cog.h - bitmap.height * cog.w) > bitmap.width) return null;
  return {
    kind: "jpeg", cog, bitmap,
    width: bitmap.width, height: bitmap.height,
    white,
    // The thumbnail is one more level of the COG's pyramid: its pixel size is
    // the base's scaled by the width ratio.
    scale: cog.w / bitmap.width,
    byteLength: bitmap.width * bitmap.height * 4,
  };
}

// The rung between the thumbnail and the tiles. The TCI's own overview pyramid
// is the ladder, and one level read whole is a sharper preview over the very
// same bounds. A 10,980 px TCI's pyramid is 5490 / 2745 / 1372 / 686 / 343, so
// the default target lands on 1372: a few hundred KB of range reads for a
// 1372 x 1372 texture.
export async function tciOverviewImage(cog, target = HD_TARGET, signal) {
  const level = levelAtLeast(cog, target);
  if (!level) return null;
  const array = await readLevel(level, signal);
  return {
    kind: "tci", cog, array,
    width: array.width, height: array.height,
    byteLength: array.data.byteLength,
  };
}

// The preview of a composite: each band's coarse overview, already read for
// the histograms, over the scene's bounds through the same shader modules the
// tiles use. Needs loadOverviews first; null if no band came.
export function bandPreviewImage(scene, spec) {
  if (!scene.bounds) return null;
  const arrays = new Map();
  for (const band of bandsOf(spec)) {
    const overview = scene.overviews.get(band)?.value;
    if (overview) arrays.set(band, overview);
  }
  if (!arrays.size) return null;
  // The finest overview read drives the mesh; the others are sampled over it
  // by their own UV transform, as MultiCOGLayer does for the tiles.
  const primary = [...arrays.values()].reduce((a, b) =>
    (a.array.width >= b.array.width ? a : b));
  return {
    kind: "bands", spec, arrays, primary,
    cog: primary.cog,
    width: primary.array.width, height: primary.array.height,
    byteLength: [...arrays.values()].reduce((n, o) => n + o.array.data.byteLength, 0),
  };
}

// A preview source as a deck.gl layer: one reprojected image over the scene,
// drawn beneath the tile layer until every tile in view has loaded. `cog` is
// anything carrying the bounds -- an opened COG or a band scene -- and stays
// in the signature for app.js; the placement comes from the source's own
// affine, not from the bounds.
export function previewLayer(source, cog, id = "cog-preview") {
  if (!source) return null;
  return new ScenePreviewLayer({ id, source });
}

// The preview's one layer. It owns the textures, because a texture needs the
// device and must be released when the preview changes, and defers everything
// else to RasterLayer.
class ScenePreviewLayer extends CompositeLayer {
  static layerName = "ScenePreviewLayer";

  initializeState() {
    this.state = { textures: null };
  }

  updateState({ props, oldProps }) {
    if (props.source !== oldProps.source) {
      this._releaseTextures();
      this.setState({ textures: null });
    }
  }

  finalizeState() {
    this._releaseTextures();
  }

  _releaseTextures() {
    for (const texture of this.state?.textures?.values() ?? []) texture.destroy();
  }

  // The textures this source needs, made once and kept until it changes.
  _textures() {
    if (this.state.textures) return this.state.textures;
    const { device } = this.context;
    const { source } = this.props;
    const textures = new Map();
    if (source.kind === "jpeg") {
      textures.set("image", device.createTexture({
        data: source.bitmap, format: "rgba8unorm", sampler: LINEAR,
      }));
    } else if (source.kind === "tci") {
      textures.set("image", device.createTexture(textureProps(source.cog, source.array, LINEAR)));
    } else {
      // One texture per band, each on its own grid.
      const sampler = source.spec.kind === "scl" ? NEAREST : LINEAR;
      for (const [band, overview] of source.arrays) {
        textures.set(band, device.createTexture(textureProps(overview.cog, overview.array, sampler)));
      }
    }
    this.setState({ textures });
    return textures;
  }

  // UV transforms place a band's own grid inside the primary band's extent.
  // Every band covers the same square, so the transform is the identity and
  // the difference in resolution is the texture's own size.
  _slots(source, textures) {
    const slots = new Map();
    const bound = [];
    const uv = [];
    for (const band of channelBands(source.spec)) {
      if (!band || slots.has(band) || !textures.has(band)) continue;
      slots.set(band, bound.length);
      bound.push(textures.get(band));
      uv.push([0, 0, 1, 1]);
    }
    // WebGL needs every declared sampler bound, even a slot the channel map
    // never reads.
    while (bound.length < 4) { bound.push(bound[0]); uv.push([0, 0, 1, 1]); }
    return { slots, bound, uv };
  }

  _renderPipeline(textures) {
    const { source } = this.props;
    const { cog } = source;
    if (source.kind === "jpeg") {
      // JpegPreview reads its own texture, because the fringe test taps the
      // eight neighbours; CreateTexture would bind the same texture a second
      // time under a name the shader layout does not have.
      return [{
        module: JpegPreview,
        props: {
          previewTexture: textures.get("image"),
          texel: [1 / source.width, 1 / source.height],
          ...(source.white ? JPEG_WHITE : JPEG_BLACK),
        },
      }];
    }
    if (source.kind === "tci") {
      return [
        { module: CreateTexture, props: { textureName: textures.get("image") } },
        tciModule(cog),
      ];
    }
    const { spec } = source;
    const { slots, bound, uv } = this._slots(source, textures);
    const { valueScale } = source.primary.cog;
    const active = spec.kind === "gray"
      ? [1, 1, 1]
      : channelBands(spec).map((band) => (band && slots.has(band) ? 1 : 0));
    return [
      compositeModule(spec, slots, bound, uv),
      spec.kind === "index" ? indexModule(spec, { valueScale })
        : spec.kind === "scl" ? sclModule(spec, { valueScale, device: this.context.device })
          : stretchModule(spec, { valueScale, active }),
    ];
  }

  // The affine of the image being drawn. A band overview and a whole TCI level
  // carry their own; the thumbnail JPEG carries none, so it is the base
  // transform scaled by the width ratio -- the thumbnail treated as one more
  // level of the pyramid, which is what the old reader did.
  _affine() {
    const { source } = this.props;
    if (source.kind === "bands") return source.primary.array.transform;
    if (source.kind === "tci") return source.array.transform;
    return affine.compose(source.cog.geotiff.transform, affine.scale(source.scale, source.scale));
  }

  renderLayers() {
    const { source } = this.props;
    const textures = this._textures();
    const renderPipeline = this._renderPipeline(textures);
    // The source's own affine on pixel coordinates, then its CRS to lon/lat.
    // RasterLayer refines the mesh until the error is under an eighth of an
    // input pixel, and that error is measured in input pixels, so lon/lat
    // output costs nothing in accuracy.
    const af = this._affine();
    const inv = affine.invert(af);
    const { converter } = source.cog;
    return new RasterLayer(this.getSubLayerProps({
      id: "raster",
      width: source.width,
      height: source.height,
      renderPipeline,
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
      reprojectionFns: {
        forwardTransform: (x, y) => affine.apply(af, x, y),
        inverseTransform: (x, y) => affine.apply(inv, x, y),
        forwardReproject: (x, y) => converter.forward([x, y], false),
        inverseReproject: (x, y) => converter.inverse([x, y], false),
      },
    }));
  }
}

// A luma.gl texture description for one read level of a COG.
function textureProps(cog, array, sampler) {
  const { bitsPerSample, sampleFormat } = cog.geotiff.cachedTags;
  const rgba = array.count === 3 ? addAlphaChannel(array) : array;
  return {
    data: rgba.data,
    format: inferTextureFormat(rgba.count, bitsPerSample, sampleFormat),
    width: rgba.width, height: rgba.height,
    sampler,
  };
}

// ---------------------------------------------------------------------------
// Scenes.
//
// A scene is a directory of band COGs; this is the per-scene memory of what
// has been opened and read, so nothing is fetched twice while the scene is on
// the map. `cogs` is band -> openCog promise and `overviews` is band -> the
// coarse level read whole, which feeds both the histograms and the preview. A
// band that fails to open keeps its rejection, so twenty tiles do not each
// retry a 404. All of it is dropped with the scene (app.js).
//
// There is no plane cache any more. The old reader kept a Float32 plane per
// tile and band so a stretch change could repaint without refetching; the
// stretch is now uniforms on the GPU, so there is nothing to repaint.
// ---------------------------------------------------------------------------
export const bandHref = (dir, band) => `${dir}/${band}.tif`;

export function openScene(id, dir) {
  return { id, dir, bounds: null, cogs: new Map(), overviews: new Map() };
}

// One band's COG, opened once per scene. The first to open sets the scene's
// bounds: every band covers the same 109.8 km square (10980 x 10 m, 5490 x
// 20 m, 1830 x 60 m), so any band's bounds are the scene's.
export function sceneCog(scene, band) {
  let p = scene.cogs.get(band);
  if (!p) {
    p = openCog(bandHref(scene.dir, band)).then((cog) => {
      scene.bounds ??= cog.bounds;
      p.value = cog;
      return cog;
    });
    // The rejection is kept on the promise for its awaiters; this only stops
    // an unhandled-rejection report for a band nobody awaits.
    p.catch(() => {});
    scene.cogs.set(band, p);
  }
  return p;
}

// A band's COG if it has already opened, else null. The layer builders are
// sync and run after loadOverviews has awaited them.
const settledCog = (scene, band) => scene.cogs.get(band)?.value ?? null;

// One band's coarsest level whose long side is at least PREVIEW_MIN, read
// whole -- a handful of range reads per band -- with its histogram and
// percentiles. Cached.
export function sceneOverview(scene, band) {
  let p = scene.overviews.get(band);
  if (!p) {
    p = sceneCog(scene, band).then(async (cog) => {
      const array = await readLevel(levelAtLeast(cog, PREVIEW_MIN));
      return {
        cog, band, array,
        w: array.width, h: array.height,
        // Stats on first use: the sort is for a histogram, and SCL has none.
        get stats() { return this._stats ??= sampleStats(array.data, 0); },
      };
    });
    scene.overviews.set(band, p);
  }
  return p;
}

// The stats of an index over two overviews already read (null when a band is
// missing or the two levels differ in size, which the fixed pairs -- both
// 10 m -- never do).
export function sceneIndexStats(scene, a, b, offset) {
  const oa = scene.overviews.get(a)?.value, ob = scene.overviews.get(b)?.value;
  return indexStats(oa?.array?.data, ob?.array?.data, offset, 0);
}

// Await each band's overview, remembering the settled value (or the error) on
// the promise so the sync layer builders can look it up; returns the bands
// that failed with their errors.
export async function loadOverviews(scene, bands) {
  const failed = [];
  await Promise.all(bands.map(async (band) => {
    const p = sceneOverview(scene, band);
    try { p.value = await p; } catch (err) { p.error = err; failed.push([band, err]); }
  }));
  return failed;
}
