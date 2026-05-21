# 3dRoof

3dRoof is a low-budget proof of concept for turning a Florida property address into a roof-analysis workflow:

- Google Places autocomplete for address entry.
- Google Place Details for precise latitude/longitude.
- Google Solar API Building Insights and Data Layers for solar metadata, DSM, RGB and mask layers.
- Browser-side GeoTIFF parsing for DSM elevation grids.
- Local roof-plane analysis for area, pitch, azimuth, confidence and fallback decisions.
- A simple 3D mesh viewer powered by React Three Fiber.

The app runs without an API key using synthetic DSM data, so the measurement pipeline and 3D viewer are testable immediately.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set `VITE_GOOGLE_MAPS_API_KEY` in `.env.local` to enable live Google Places and Solar API calls.

## Google APIs To Enable

Enable these APIs in the same Google Cloud project:

- Places API (New) (`places.googleapis.com`)
- Maps JavaScript API
- Solar API

For the browser API key in Credentials:

- Application restrictions: HTTP referrers with `http://127.0.0.1:5173/*` and `http://localhost:5173/*`
- API restrictions: include Places API (New), Maps JavaScript API, and Solar API (or temporarily "Don't restrict key" while testing)

Billing must be enabled on the project. If you see `AutocompletePlaces are blocked`, the key restrictions or billing are the usual cause—not the React app code.

## Deploy on Vercel

1. Import [github.com/adirremi/3Droof](https://github.com/adirremi/3Droof) in Vercel.
2. Add environment variable: `VITE_GOOGLE_MAPS_API_KEY` (same value as local).
3. In Google Cloud key HTTP referrers, also add your Vercel URL, for example:
   - `https://*.vercel.app/*`
   - `https://your-project.vercel.app/*`
4. Deploy. Vercel will run `npm run build` and serve the `dist` folder.

## Current Accuracy Model

The analyzer is an MVP algorithm. It estimates local slopes from DSM neighboring pixels, clusters cells into roof-plane buckets by pitch and azimuth, and scores confidence using DSM coverage, plane complexity, mask availability and pitch range. Low-confidence roofs should be sent to a paid EagleView/Nearmap-style measurement provider before quoting.
