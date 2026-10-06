# Scene explorer

A single static page over the published catalog. There is no API, no server
and no database behind it: the scene search reads GeoParquet footers with
hyparquet, and the imagery is read from Cloud-Optimized GeoTIFFs in the
browser. Both go straight at the object store as HTTP range requests.

## Build

```sh
npm install
npm run build      # -> dist/, the tree GitHub Pages serves
npm run dev        # a dev server with hot reload
npm test           # the results.js unit tests
```

`.github/workflows/pages.yml` runs `npm ci && npm run build` and publishes
`dist/`.

### Why there is a build

The page loaded its dependencies from a CDN until the raster layers moved to
[`@developmentseed/deck.gl-raster`](https://developmentseed.org/deck.gl-raster/).
Those layers create luma.gl `Texture` objects and hand them to the shader
pipeline that this page's own deck.gl instance runs. A second copy of
`@luma.gl/core` or `@deck.gl/core` gives two unrelated class identities, and
the textures then do not bind. A bundler is what guarantees one copy.

The CDN setup could not: `deck.gl`'s UMD bundle publishes 163 deck.gl symbols
on `window.deck` and no luma.gl ones, so nothing could supply `Texture`. The
bundle also fixes the reason that UMD file was there at all — the esm.sh build
of deck.gl 9.4.0 drew correctly but returned nothing from picking, which the
scene grid's hover and click need.

## The imagery path

| File | What it holds |
| --- | --- |
| `cog.js` | Which COGs a scene is made of, the layer per band preset, the preview ladder, and the per-scene read cache. |
| `raster-modules.js` | The stretch, as GLSL shader modules. The tiles and the preview share them. |
| `bands.js` | The band tables, presets, index ramps, SCL palette, and the histogram and percentiles of an overview. No I/O. |
| `search.js` | The scene search over the item parts. |
| `app.js` | The page: map, panels, results, timeline, and the state machine over all of it. |

The library reads the overviews, picks the level for the zoom, and reprojects
each scene's UTM grid to Web Mercator on the GPU.

### 16-bit textures

A reflectance band is uint16, which the library uploads as an `r16unorm`
texture. WebGL2 samples that format only with `EXT_texture_norm16`. Where the
extension is missing every band reads zero and a composite comes out black, so
the app checks for it and says so instead. True colour (TCI) and SCL classes
are 8-bit and are not affected. A software renderer (SwiftShader, which is
what Chrome falls back to with no GPU) does not have the extension.

## Harnesses

`test/render.html` puts one real Sentinel-2 scene on a bare deck.gl instance,
one layer path at a time, and reads back what reached the framebuffer.
`test/pick.html` checks that picking works. Neither is in the published
build:

```sh
npm run build:test
npx http-server dist      # then open /test/render.html
```
