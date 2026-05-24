# AggsData — Delivered Price Estimator

An interactive, browser-based tool for estimating delivered aggregate prices at any point on the map. Click anywhere to instantly see a weighted price estimate drawn from nearby historical sales orders, view competing plant locations, and run drive-time analysis — all without a backend.

---

## Features

### Price Estimation
- **Click-to-estimate** — click any point on the map to compute an estimated delivered ASP (Average Selling Price)
- **Kriging-weighted interpolation** — spatial weight decays with the semivariogram model; range tracks the selected search radius
- **Time decay** — recent orders are weighted more heavily (configurable recency boost)
- **Volume weighting** — Hill-function curve discounts both very small and very large orders to capture representative market prices
- **Price escalation** — historical prices are normalised to current-dollar equivalents using a configurable annual escalation rate (default 3%)
- **Confidence range** — estimated price is shown with a ± band

### Filters
- **Search radius** — 5 / 10 / 25 mile toggle
- **Product type** — All / Concrete Aggregate / Asphalt Aggregate / Base Material
- **Product** — dynamically populated from the data
- **Date range** — pick-your-own from/to date window

### Map Layers
| Layer | Description |
|---|---|
| Plant markers | Owned (amber) and competitor (red) plants; shape indicates geology (diamond = limestone, square = hard rock, triangle = sand & gravel) |
| Order dots | Historical delivery points colour-coded green |
| Search radius ring | Shown around the clicked point |
| Drive-time heatmap | Competitive advantage map — green where owned plants are closer, red where competitors are closer |
| Isochrones | 15 / 30 / 45 minute drive-time rings from all owned plants (unified per band) |

### Results Panel
- Estimated delivered ASP with confidence range
- Orders used and radius metadata
- Nearby plants list (owned and competitor) with distances
- **Drive Time Analysis** — fetches real road routes from the N nearest plants via OSRM; shows one-way and round-trip times with configurable overhead

### Orders Table
- Sortable columns: date, product, plant, distance to plant, distance to point, volume, base ASP, delivery fee, total ASP
- Download as CSV
- Collapsible drawer

### Address Search
- Mapbox Geocoding API with real-time suggestions (debounced)
- Proximity-biased to the current map view
- Pan-to-location on selection; ✕ clear button

---

## Quick Start

This is a fully static application — no server or build step required.

```
1. Clone or download the repository
2. Add your Mapbox token to map.js (see Configuration below)
3. Open index.html in a browser, or serve the folder with any static server
```

For a simple local server:
```bash
# Python 3
python -m http.server 8080
# then open http://localhost:8080
```

---

## Configuration

All tuneable parameters live in the `CONFIG` object at the top of `map.js`:

| Key | Default | Description |
|---|---|---|
| `defaultRadius` | `5` | Initial search radius in miles |
| `priceRange` | `0.05` | ± band shown around the estimate (5%) |
| `semivariogramRange` | `30` | Fallback variogram range (miles); overridden by search radius at runtime |
| `nugget` | `0.10` | Kriging nugget effect |
| `recentWeight` | `2.0` | Extra weight multiplier for orders within the past year |
| `volumeRefTons` | `200` | Hill-function half-saturation tonnage (upward slope) |
| `volumeCap` | `2000` | Tonnage above which the large-order discount kicks in |
| `escalationPct` | `3.0` | Annual % used to bring historical prices to present value |
| `truckOverheadMinutes` | `10` | Fixed overhead added to each drive-time result |
| `mapboxToken` | — | Your Mapbox public token (`pk.*`) — required for address search |
| `enableAddressSearch` | `true` | Set `false` to hide the search bar |
| `enablePriceHeatmap` | `false` | Set `true` to expose the base-ASP heatmap toggle in the legend |

---

## Data Files

| File | Format | Description |
|---|---|---|
| `orders.geojson` | GeoJSON FeatureCollection | Historical delivery orders. Each feature is a point (delivery location) with properties: `date`, `product`, `product_type`, `plant_name`, `volume_tons`, `asp`, `delivery_fee`, `total_asp` |
| `plants.geojson` | GeoJSON FeatureCollection | Plant locations with properties: `id`, `name`, `owner` (`owned` or `competitor`), `geology`, `products` (array) |
| `isochrones.geojson` | GeoJSON FeatureCollection | Pre-computed drive-time polygons. Each feature has a `minutes` property (15, 30, or 45) and a unified polygon geometry covering all owned plants |
| `drivetime_heatmap.png` | RGBA PNG (480×380) | Competitive advantage raster. Green = owned plant closer; red = competitor closer. Covers the bounding box defined in `map.js` |

---

## Technology

- **[Leaflet.js](https://leafletjs.com/) 1.9.4** — map rendering
- **[CARTO Light](https://carto.com/basemaps/)** — basemap tiles
- **[Mapbox Geocoding API v5](https://docs.mapbox.com/api/search/geocoding/)** — address search
- **[OSRM](http://project-osrm.org/)** — open-source routing engine (public demo server)
- **[Barlow Condensed + DM Mono](https://fonts.google.com/)** — typography
- Vanilla JS / HTML / CSS — no framework or build tooling

---

## License

Private — all rights reserved.
