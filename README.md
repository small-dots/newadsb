# Aircraft MapLibre 3D demo

An AirNav-inspired local prototype that demonstrates the same rendering split:

- pitch at 0°: MapLibre symbol layer with AirNav's 2D aircraft sprites;
- any non-zero pitch: MapLibre custom 2.5D layer, sharing its WebGL canvas with Three.js;
- the same AirNav sprite atlas is rendered once at aircraft altitude and once as a ground shadow;
- aircraft placed at ADS-B-like longitude, latitude, altitude and heading, with an optional altitude drop line;
- screen-size clamping so dense traffic remains legible at operational map zooms.

## Run

Use Node 20.19+ (or Node 22+):

```sh
npm install
npm run dev
```

Then open the local URL printed by Vite. The sample uses the locally downloaded GLB files in `airnavradar-models/`.

## Data mapping

`src/main.js` has the model-family map used by the sample. The complete source-derived lookup is in:

- `airnavradar-models/icao-to-model.tsv`

For production, replace the demo's generated canvas sprites with an appropriately licensed sprite atlas, and retain the same MapLibre symbol-layer fallback path.
