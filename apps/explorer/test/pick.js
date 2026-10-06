// Does deck.gl's picking pass work in this build?
//
// The page used to load deck.gl from its UMD dist because the esm.sh build of
// 9.4.0 drew correctly but returned nothing from picking, and the scene grid's
// hover and click depend on it (see task-20-report). The bundle replaces that
// workaround, so this checks the thing the workaround existed for: a layer
// with known geometry, picked at a point inside it and a point outside it.
import { Deck, MapView } from "@deck.gl/core";
import { GeoJsonLayer } from "@deck.gl/layers";
import { MVTLayer } from "@deck.gl/geo-layers";

const square = {
  type: "Feature",
  properties: { name: "target" },
  geometry: {
    type: "Polygon",
    coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
  },
};

const deck = new Deck({
  parent: document.getElementById("map"),
  views: new MapView({ repeat: false }),
  initialViewState: { longitude: 0, latitude: 0, zoom: 6 },
  controller: false,
  layers: [new GeoJsonLayer({
    id: "square",
    data: { type: "FeatureCollection", features: [square] },
    filled: true,
    getFillColor: [255, 0, 0],
    pickable: true,
  })],
});
await new Promise((resolve) => { deck.setProps({ onLoad: resolve }); });
await new Promise((r) => setTimeout(r, 2500));

const { width, height } = deck.canvas;
const centre = deck.pickObject({ x: Math.round(width / 2), y: Math.round(height / 2) });
const corner = deck.pickObject({ x: 4, y: 4 });

window.HARNESS = {
  done: true,
  results: [{
    name: "pickObject",
    // The square is centred on the viewport, so the centre pick must find it
    // and the corner pick must find nothing.
    centreHit: !!centre,
    centreLayer: centre?.layer?.id ?? null,
    centreName: centre?.object?.properties?.name ?? null,
    cornerHit: !!corner,
    // MVTLayer is what the app actually picks; this only proves it constructs
    // and reports itself pickable in this build.
    mvtLayerBuilds: !!new MVTLayer({ id: "mvt", data: "about:blank", pickable: true }),
  }],
};
