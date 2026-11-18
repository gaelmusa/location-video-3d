# location-video-3d

Turn a Google Maps link into vertical (1080×1920, 30 fps) 3D location videos for social and real-estate ads, rendered headless with CesiumJS, Puppeteer and ffmpeg. No GPU is needed, and on GitHub Actions each video is split into frame ranges that render in parallel.

From one link it produces two videos:

1. **`<Title> - Ubicacion 50 km.mp4`**: a wide flyover that places the property among the nearest cities.
2. **`<Title> - Entorno.mp4`**: a close 3D view of the block, with the surrounding streets and nearby places drawn on the photorealistic tiles.

It can also render **zone videos**, which outline neighborhoods, avenues or custom areas of a city from OpenStreetMap boundaries.

## How it works

1. **Resolve the link.** Short (`maps.app.goo.gl`) and long Maps links, plain coordinates and text addresses are all accepted.
2. **Look up the area.** Nominatim and Overpass (OpenStreetMap) supply the neighborhood, streets, boundaries and points of interest. Mirrors are tried when one Overpass server is down.
3. **Build the camera path.** The path is planned so that every reference fits in the vertical frame.
4. **Render the scene.** A local CesiumJS page loads Google Photorealistic 3D Tiles through Cesium ion, and Puppeteer captures it frame by frame in headless Chromium (SwiftShader).
5. **Encode.** ffmpeg turns the frames into H.264. On GitHub Actions the frames are split across runners and the parts are joined at the end.

## Requirements

- Node.js 22
- A [Cesium ion](https://ion.cesium.com) access token, which you provide yourself. The free tier is for non-commercial use, so check Cesium's and Google's terms before using the videos commercially.

## Run locally

```bash
npm ci
echo "CESIUM_ION_TOKEN=your-token" > .env
LINK="https://maps.app.goo.gl/..." npm run render
```

The videos are written to `./salida/`. Optional environment variables:

| Variable | Meaning |
|---|---|
| `TITULO` | Title shown in the video. Defaults to the place name. |
| `PUNTOS` | Extra places to show, one per line: `name` or `name, maps-link`. |
| `VIDEO` | `macro` or `micro`, to render only one of the two videos. |

### Zone videos

```bash
node render/zonas-cli.js spec.json out-dir
```

The spec format (city context, subtitle, and a list of videos with their zones) is documented at the top of [`render/zonas-lib.js`](render/zonas-lib.js).

## Run on GitHub Actions

1. Fork the repository.
2. Add the repository secret `CESIUM_ION_TOKEN`.
3. Run the **Render video de ubicacion** or **Render videos de zona** workflow from the Actions tab.

Finished videos are uploaded as workflow artifacts. To report render progress to your own app, set `PROGRESS_URL`. It is optional and off by default.

## Status

This code comes from a tool I built and use in production to make location videos for real-estate ad campaigns in Argentina and Uruguay. Code comments and some on-screen strings are in Spanish. Issues and pull requests are welcome.

## Credits and licenses

- This project's code is released under the [MIT License](LICENSE).
- [CesiumJS](https://github.com/CesiumGS/cesium) (Apache-2.0) is loaded from jsDelivr. The Cesium and Google credits stay visible in every frame, as the tile terms require.
- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL), queried through Nominatim and Overpass. Please respect their [usage policies](https://operations.osmfoundation.org/policies/nominatim/).
- `data/ciudades.json` (city names, coordinates and population) is derived from [GeoNames](https://www.geonames.org) (CC BY 4.0).
- [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) downloads ffmpeg binaries that are licensed under the GPL.
