#!/usr/bin/env python3
"""
Regenerate simulated AggsData order data + sync plant product lists.

Reads:  products.json (catalog), plants.geojson (coords/geology/owner)
Writes: plants.geojson (products list synced to geology), orders.geojson

Model
-----
- Products are gated by plant geology (a plant only sells products whose
  validGeology includes the plant's geology).
- Order delivery points cluster near their source plant (exponential haul
  distance, capped), so density and delivery cost fall off with distance.
- Base (FOB) price = product basePrice x (1+annualTrend)^(years since baseYear)
  x per-plant factor x noise  -> prices rise over time.
- Delivery fee = distance x haul rate ($/ton-mile) x noise.
- Volume is skewed-random (lognormal): many mid orders, a few very large.
- Dates span 2020-01-01 .. 2026-03-31 (uniform).
"""
import json, math, random
from datetime import date, timedelta

random.seed(42)

N_ORDERS    = 800
START       = date(2020, 1, 1)
END         = date(2026, 3, 31)
HAUL_RATE   = 0.45          # $/ton-mile (straight-line)
HAUL_MEAN   = 6.0           # mean haul distance (mi) for the exponential
HAUL_MAX    = 30.0          # cap (mi)
SPAN_DAYS   = (END - START).days

with open("products.json", encoding="utf-8") as f:
    catalog = json.load(f)
with open("plants.geojson", encoding="utf-8") as f:
    plants_fc = json.load(f)

PRODUCTS   = catalog["products"]
BASE_YEAR  = catalog["priceModel"]["baseYear"]
TREND      = catalog["priceModel"]["annualTrend"]
PROD_BY_CODE = {p["code"]: p for p in PRODUCTS}

# ── 1. Sync every plant's product list to its geology; collect OWNED plants
#       as the order-generation pool (we only have our own sales orders).
plants = []
for feat in plants_fc["features"]:
    props = feat["properties"]
    geo   = props["geology"]
    valid = [p for p in PRODUCTS if geo in p["validGeology"]]
    props["products"] = [p["label"] for p in valid]   # sync ALL plants (incl. competitors)
    if props.get("owner") != "owned":
        continue                                        # orders come from owned plants only
    lon, lat = feat["geometry"]["coordinates"]
    plants.append({
        "id":   props["id"],
        "name": props["name"],
        "geology": geo,
        "lat": lat, "lon": lon,
        "valid": valid,
        # small persistent per-plant price character (+/-3%)
        "factor": random.uniform(0.97, 1.03),
    })

with open("plants.geojson", "w", encoding="utf-8") as f:
    json.dump(plants_fc, f, indent=2, ensure_ascii=False)
    f.write("\n")

# ── 2. Generate orders ────────────────────────────────────────────────────
def haversine(lat1, lon1, lat2, lon2):
    R = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl   = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))

def offset(lat, lon, dist_mi, bearing_deg):
    """Approximate lat/lon a given distance & bearing from a point."""
    dlat = (dist_mi / 69.0) * math.cos(math.radians(bearing_deg))
    dlon = (dist_mi / (69.0 * math.cos(math.radians(lat)))) * math.sin(math.radians(bearing_deg))
    return lat + dlat, lon + dlon

features = []
for i in range(N_ORDERS):
    plant = random.choice(plants)
    prod  = random.choice(plant["valid"])

    # delivery point: cluster near the plant
    dist = min(random.expovariate(1.0 / HAUL_MEAN), HAUL_MAX)
    brng = random.uniform(0, 360)
    dlat, dlon = offset(plant["lat"], plant["lon"], dist, brng)
    real_dist = haversine(plant["lat"], plant["lon"], dlat, dlon)

    # date
    d = START + timedelta(days=random.randint(0, SPAN_DAYS))
    years = (d - date(BASE_YEAR, 1, 1)).days / 365.25

    # base (FOB) price: trend up over time + plant character + noise
    asp = (prod["basePrice"]
           * (1 + TREND) ** years
           * plant["factor"]
           * random.gauss(1.0, 0.05))
    asp = round(max(asp, 1.0), 2)

    # delivery fee scales with distance
    delivery = round(real_dist * HAUL_RATE * random.gauss(1.0, 0.08), 2)
    delivery = max(delivery, 0.0)
    total = round(asp + delivery, 2)

    # skewed volume (lognormal): many mid, a few large
    vol = int(min(max(random.lognormvariate(math.log(1200), 0.8), 100), 8000))

    features.append({
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(dlon, 5), round(dlat, 5)]},
        "properties": {
            "order_id":     f"ORD-{i+1:04d}",
            "plant_id":     plant["id"],
            "plant_name":   plant["name"],
            "date":         d.isoformat(),
            "volume_tons":  vol,
            "asp":          asp,
            "delivery_fee": delivery,
            "total_asp":    total,
            "product":      prod["label"],
            "product_type": prod["category"],
            "geology":      plant["geology"],
            "dist_from_plant": round(real_dist, 2),
        },
    })

# sort by date for tidy output
features.sort(key=lambda f: f["properties"]["date"])
for i, feat in enumerate(features):
    feat["properties"]["order_id"] = f"ORD-{i+1:04d}"

orders_fc = {"type": "FeatureCollection", "features": features}
with open("orders.geojson", "w", encoding="utf-8") as f:
    json.dump(orders_fc, f, indent=2, ensure_ascii=False)
    f.write("\n")

# ── 3. Report ─────────────────────────────────────────────────────────────
from collections import Counter
cat = Counter(f["properties"]["product_type"] for f in features)
prod_ct = Counter(f["properties"]["product"] for f in features)
yr = Counter(f["properties"]["date"][:4] for f in features)
print(f"orders: {len(features)}  date {features[0]['properties']['date']} .. {features[-1]['properties']['date']}")
print("by category:", dict(cat))
print("by year:", dict(sorted(yr.items())))
print("products:", dict(sorted(prod_ct.items(), key=lambda x: -x[1])))
# mean price by year to confirm upward trend
by_year = {}
for f in features:
    y = f["properties"]["date"][:4]
    by_year.setdefault(y, []).append(f["properties"]["total_asp"])
print("mean total_asp by year:",
      {y: round(sum(v)/len(v), 2) for y, v in sorted(by_year.items())})
