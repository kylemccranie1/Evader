# Evader

Installable PWA with a live, moving map for the I-10 corridor between **Holt (exit 56)** and **DeFuniak Springs (exit 85)**, Florida.

1. **Police reports** — pulled from a Waze-format feed and shown on the map, with "police ahead" alerts based on your heading.
2. **Guardrail-both-sides zones** — stretches of I-10 where a guardrail runs along both the left (median) and right side of a carriageway, drawn in orange with "zone ahead" alerts.

## Run

```
npm start        # serves on http://localhost:8080 (any static server works; GPS needs https or localhost)
npm test         # geometry / zone-detection tests
```

Tap **▶ Sim** to drive the corridor without GPS.

## How the guardrail zones work

On first load the app queries OpenStreetMap (Overpass API) for I-10 carriageways, `barrier=guard_rail` ways and the exit 56/85 junctions. `js/geo.js` samples each carriageway every 15 m and marks a point when a roughly-parallel rail lies within 22 m on **both** sides relative to travel direction. Runs are merged across small gaps and clipped to the two exits. Results are cached in `localStorage` for 30 days (works offline).

**Caveat:** this is only as complete as OpenStreetMap. Unmapped guardrail won't show, so treat the layer as a hint and verify against imagery/ground truth. Tunables are in `findBothSidesZones` options.

## Police feed

Waze has no open public API. For real data supply a feed you're entitled to use (e.g. the Waze for Cities partner program) under **⚙ Settings**, using `{top} {bottom} {left} {right}` placeholders for the viewport. JSON in the Waze `alerts` shape is parsed (`type: POLICE`). Without a URL the app shows clearly-labelled DEMO markers. Browser CORS applies; a feed on another origin needs CORS headers or your own proxy. Don't scrape Waze's undocumented live-map endpoints — that violates their terms.

## Layout

`index.html`, `styles.css`, `manifest.webmanifest`, `sw.js` (offline shell + tile cache), `js/` (app, geo, guardrails, police), `vendor/leaflet` (bundled, BSD-2).
