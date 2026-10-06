// The explorer is one static page with no framework: Vite is here to resolve
// bare module specifiers and to give deck.gl, luma.gl and
// @developmentseed/deck.gl-geotiff ONE shared copy of their own internals.
//
// That sharing is the reason the app has a build at all. The raster layers
// construct luma.gl `Texture` objects and hand them to the shader pipeline
// that the app's own Deck instance runs. A second copy of @luma.gl/core, or
// of @deck.gl/core, gives two unrelated class identities and the textures do
// not bind. The previous CDN setup could not satisfy this: the deck.gl UMD
// bundle publishes 163 deck symbols on `window.deck` and no luma.gl ones.
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  // @developmentseed/geotiff decodes tile chunks in a Web Worker pool, and
  // that worker imports its decoders, so it code-splits. Rollup refuses to
  // split an IIFE worker, which is Vite's default.
  worker: { format: "es" },
  build: {
    outDir: "dist",
    rollupOptions: {
      // The harnesses under test/ build only when HARNESS is set, because
      // `npm run build` makes the tree that goes to GitHub Pages. Build them
      // with `npm run build:test` and serve dist/ to run them.
      input: process.env.HARNESS
        ? { index: "index.html", "test/render": "test/render.html",
          "test/pick": "test/pick.html" }
        : { index: "index.html" },
    },
    // The scene search reads GeoParquet footers and the raster layers decode
    // COG tiles, so the bundle is large by nature. Report honestly instead
    // of warning on every build.
    chunkSizeWarningLimit: 4096,
    sourcemap: true,
  },
});
