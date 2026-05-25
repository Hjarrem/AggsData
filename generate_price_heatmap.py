#!/usr/bin/env python3
"""
Regenerate price_heatmap.png from orders.geojson.

Field: base ASP only (no delivery fee), escalated to "today" at 3%/yr.
Interpolation: Gaussian kernel (bandwidth 8 mi). Per-pixel alpha fades
with data density; cells with no nearby orders are transparent.
Colour: diverging green (low) -> cream (median) -> red (high), matching
the legend ramp in style.css (.heatmap-ramp.price-ramp).

Bounds must match CONFIG.heatmapBounds in map.js.
"""
import json, math
from datetime import date
import numpy as np
from PIL import Image

# ── Config (keep in sync with map.js) ─────────────────────────────────────
BOUNDS   = {"south": 47.05, "north": 48.00, "west": -122.70, "east": -121.50}
W, H     = 480, 380
BANDWIDTH_MI = 8.0
MIN_WEIGHT   = 0.05
MAX_ALPHA    = 185         # 0-255
ESCALATION   = 0.03        # 3%/yr, matches CONFIG.escalationPct
TODAY        = date(2026, 5, 24)

# Diverging ramp stops (match .heatmap-ramp.price-ramp)
STOP_POS = [0.0, 0.25, 0.5, 0.75, 1.0]
STOP_RGB = np.array([
    [ 30, 160,  90],   # low  (green)
    [130, 210, 140],
    [245, 245, 220],   # median (cream)
    [240, 150,  60],
    [205,  40,  40],   # high (red)
], dtype=float)

# ── Load orders, escalate base ASP to today ───────────────────────────────
orders = json.load(open("orders.geojson", encoding="utf-8"))
lats, lons, vals = [], [], []
for f in orders["features"]:
    p = f["properties"]
    lon, lat = f["geometry"]["coordinates"]
    days = (TODAY - date.fromisoformat(p["date"])).days
    esc  = p["asp"] * (1 + ESCALATION) ** (days / 365.0)
    lats.append(lat); lons.append(lon); vals.append(esc)
lats = np.array(lats); lons = np.array(lons); vals = np.array(vals)

p05, med, p95 = np.percentile(vals, [5, 50, 95])
print(f"escalated base ASP: P05=${p05:.2f}  median=${med:.2f}  P95=${p95:.2f}  (n={len(vals)})")

# ── Grid (pixel centres -> lat/lon) ───────────────────────────────────────
xs = BOUNDS["west"]  + (np.arange(W) + 0.5) / W * (BOUNDS["east"]  - BOUNDS["west"])
ys = BOUNDS["north"] - (np.arange(H) + 0.5) / H * (BOUNDS["north"] - BOUNDS["south"])
LON, LAT = np.meshgrid(xs, ys)                       # (H, W)

mean_lat = math.radians((BOUNDS["north"] + BOUNDS["south"]) / 2)
mi_per_deg_lat = 69.0
mi_per_deg_lon = 69.0 * math.cos(mean_lat)

# ── Gaussian-weighted interpolation (accumulate over orders) ──────────────
wsum = np.zeros((H, W)); vsum = np.zeros((H, W))
inv2bw2 = 1.0 / (2 * BANDWIDTH_MI ** 2)
for lat_o, lon_o, v_o in zip(lats, lons, vals):
    dx = (LON - lon_o) * mi_per_deg_lon
    dy = (LAT - lat_o) * mi_per_deg_lat
    w  = np.exp(-(dx*dx + dy*dy) * inv2bw2)
    wsum += w
    vsum += w * v_o

mask  = wsum > MIN_WEIGHT
value = np.where(mask, vsum / np.maximum(wsum, 1e-9), med)

# ── Value -> colour (piecewise around the median) ─────────────────────────
t = np.where(
    value <= med,
    0.5 * (value - p05) / max(med - p05, 1e-9),
    0.5 + 0.5 * (value - med) / max(p95 - med, 1e-9),
)
t = np.clip(t, 0.0, 1.0)

rgb = np.zeros((H, W, 3), dtype=float)
for c in range(3):
    rgb[..., c] = np.interp(t.ravel(), STOP_POS, STOP_RGB[:, c]).reshape(H, W)

# ── Alpha: fade with data density, transparent where no data ──────────────
wref  = np.percentile(wsum[mask], 70) if mask.any() else 1.0
alpha = np.clip(wsum / max(wref, 1e-9), 0, 1) ** 0.8 * MAX_ALPHA
alpha[~mask] = 0

rgba = np.dstack([rgb, alpha]).astype(np.uint8)
Image.fromarray(rgba, mode="RGBA").save("price_heatmap.png")
print(f"wrote price_heatmap.png ({W}x{H})")
