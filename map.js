/* ═══════════════════════════════════════════════════════
   AggsData — Delivered Price Estimator
   map.js — Leaflet map, data loading, kriging estimation
   ═══════════════════════════════════════════════════════ */

// ── Config ─────────────────────────────────────────────
const CONFIG = {
  center:             [47.55, -122.10],
  zoom:               10,
  minZoom:            7,
  maxZoom:            17,
  defaultRadius:      5,
  priceRange:         0.05,
  maxOrdersInTable:   30,
  recentWeight:       2.0,
  semivariogramRange: 30,
  nugget:             0.10,
};

// ── State ──────────────────────────────────────────────
let state = {
  ordersData:      null,
  plantsData:      null,
  radius:          CONFIG.defaultRadius,
  productType:     'all',
  dateFrom:        '2020-01-01',
  dateTo:          '2024-12-31',
  clickMarker:     null,
  radiusCircle:    null,
  allOrdersLayer:  null,   // GeoJSON layer — always visible
  hitOrdersLayer:  null,   // highlighted subset after click
};

// ── Map init ───────────────────────────────────────────
const canvasRenderer = L.canvas({ padding: 0.5 });

const map = L.map('map', {
  center:      CONFIG.center,
  zoom:        CONFIG.zoom,
  minZoom:     CONFIG.minZoom,
  maxZoom:     CONFIG.maxZoom,
  zoomControl: true,
  renderer:    canvasRenderer,
});

// CartoDB Positron — clean, minimal, light
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OpenStreetMap © CARTO',
  subdomains:  'abcd',
  maxZoom:     19,
}).addTo(map);

// ── Geology → shape SVG paths ──────────────────────────
// All rendered as divIcon SVG so they're crisp and shapeable
function plantIcon(geology, owner) {
  const owned = owner === 'owned';
  const fill   = owned ? '#e8a020' : '#e05070';
  const stroke = owned ? '#7a4800' : '#7a1530';
  const size   = owned ? 20 : 16;

  let shape;
  if (geology === 'Sand & Gravel') {
    // Triangle pointing up
    shape = `<polygon points="10,2 19,18 1,18"
               fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`;
  } else if (geology === 'Hard Rock') {
    // Square (rotated 0°)
    shape = `<rect x="2" y="2" width="16" height="16" rx="1"
               fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  } else {
    // Diamond (Limestone) — rotated square
    shape = `<polygon points="10,1 19,10 10,19 1,10"
               fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`;
  }

  return L.divIcon({
    className: '',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 20 20"
               xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
             ${shape}
           </svg>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function clickIcon() {
  return L.divIcon({
    className: '',
    html: `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
             <circle cx="9" cy="9" r="7" fill="none" stroke="#e8a020" stroke-width="2"/>
             <circle cx="9" cy="9" r="3" fill="#ffffff"/>
           </svg>`,
    iconSize:   [18, 18],
    iconAnchor: [9, 9],
  });
}

// ── Haversine distance (miles) ─────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Spherical semivariogram kriging weight ─────────────
function krigingWeight(dist_miles, daysSince) {
  const h   = dist_miles;
  const a   = CONFIG.semivariogramRange;
  const nug = CONFIG.nugget;

  let gamma;
  if (h <= 0)    gamma = 0;
  else if (h >= a) gamma = 1;
  else { const r = h / a; gamma = nug + (1 - nug) * (1.5 * r - 0.5 * r ** 3); }

  const spatialW    = Math.max(0, 1 - gamma);
  const timeW       = Math.exp(-Math.LN2 * daysSince / 730);
  const recentBoost = daysSince < 365 ? CONFIG.recentWeight : 1.0;
  return spatialW * timeW * recentBoost;
}

// ── Estimation ─────────────────────────────────────────
function estimatePrice(clickLat, clickLon, orders, radiusMiles) {
  const now     = new Date();
  const results = [];

  orders.forEach(f => {
    const p         = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const dist      = haversine(clickLat, clickLon, lat, lon);
    if (dist > radiusMiles) return;
    if (p.date < state.dateFrom || p.date > state.dateTo) return;
    if (state.productType !== 'all' && p.product_type !== state.productType) return;

    const daysSince = (now - new Date(p.date)) / 86400000;
    const w         = krigingWeight(dist, daysSince);
    results.push({ p, dist, w, lat, lon });
  });

  if (!results.length) return null;

  const wSum = results.reduce((s, r) => s + r.w, 0);
  results.forEach(r => r.normW = r.w / wSum);
  const estimate = results.reduce((s, r) => s + r.p.total_asp * r.normW, 0);
  results.sort((a, b) => b.w - a.w);
  return { estimate, results };
}

// ── Format currency ────────────────────────────────────
const fmt = v => '$' + v.toFixed(2);

// ── Always-on order dots (canvas-rendered) ─────────────
function buildAllOrdersLayer(features) {
  return L.geoJSON({ type: 'FeatureCollection', features }, {
    renderer: canvasRenderer,
    pointToLayer(f, latlng) {
      return L.circleMarker(latlng, {
        radius:      4,
        fillColor:   '#4cb87a',
        fillOpacity: 0.55,
        color:       '#1a3d2b',
        weight:      0.8,
      });
    },
    onEachFeature(f, layer) {
      const p = f.properties;
      layer.bindTooltip(
        `<strong>${p.product}</strong><br>${p.date}<br>Total ASP: ${fmt(p.total_asp)}`,
        { sticky: true, className: 'order-tooltip' }
      );
    },
  });
}

// Highlighted subset after a click
function buildHitLayer(results) {
  return L.geoJSON({
    type: 'FeatureCollection',
    features: results.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { ...r.p, normW: r.normW, dist: r.dist },
    })),
  }, {
    renderer: canvasRenderer,
    pointToLayer(f, latlng) {
      const p  = f.properties;
      const op = Math.max(0.4, Math.min(1.0, 0.4 + p.normW * 0.6));
      return L.circleMarker(latlng, {
        radius:      5,
        fillColor:   '#e8a020',
        fillOpacity: op,
        color:       '#7a4800',
        weight:      1,
      });
    },
    onEachFeature(f, layer) {
      const p = f.properties;
      layer.bindPopup(`
        <div class="popup-title">${p.product}</div>
        <div class="popup-row"><span class="popup-key">Date</span><span class="popup-val">${p.date}</span></div>
        <div class="popup-row"><span class="popup-key">Total ASP</span><span class="popup-val">${fmt(p.total_asp)}</span></div>
        <div class="popup-row"><span class="popup-key">Volume</span><span class="popup-val">${p.volume_tons.toLocaleString()} T</span></div>
        <div class="popup-row"><span class="popup-key">Plant</span><span class="popup-val">${p.plant_name}</span></div>
        <div class="popup-row"><span class="popup-key">Distance</span><span class="popup-val">${p.dist.toFixed(1)} mi</span></div>
        <div class="popup-row"><span class="popup-key">Krig. Weight</span><span class="popup-val">${(p.normW * 100).toFixed(1)}%</span></div>
      `);
    },
  });
}

// ── Render sidebar results ─────────────────────────────
function renderResults(clickLat, clickLon) {
  if (!state.ordersData) return;

  const result = estimatePrice(clickLat, clickLon, state.ordersData.features, state.radius);
  document.getElementById('results-panel').style.display = 'block';
  document.getElementById('click-hint').style.display    = 'none';

  // Remove previous hit layer
  if (state.hitOrdersLayer) { map.removeLayer(state.hitOrdersLayer); state.hitOrdersLayer = null; }

  if (!result) {
    document.getElementById('est-value').textContent          = 'N/A';
    document.getElementById('est-low').textContent            = '—';
    document.getElementById('est-high').textContent           = '—';
    document.getElementById('est-orders-used').textContent    = 'No orders in radius';
    document.getElementById('est-radius').textContent         = '';
    document.getElementById('orders-tbody').innerHTML         = '';
    document.getElementById('orders-count-badge').textContent = '0';
    renderCompetitors(clickLat, clickLon);
    return;
  }

  const { estimate, results } = result;
  const lo = estimate * (1 - CONFIG.priceRange);
  const hi = estimate * (1 + CONFIG.priceRange);

  document.getElementById('est-value').textContent          = fmt(estimate);
  document.getElementById('est-low').textContent            = fmt(lo);
  document.getElementById('est-high').textContent           = fmt(hi);
  document.getElementById('est-orders-used').textContent    = `${results.length} order${results.length !== 1 ? 's' : ''} used`;
  document.getElementById('est-radius').textContent         = `${state.radius} mi radius`;
  document.getElementById('orders-count-badge').textContent = results.length;

  // Table
  const tbody   = document.getElementById('orders-tbody');
  tbody.innerHTML = '';
  results.slice(0, CONFIG.maxOrdersInTable).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.p.date}</td>
      <td title="${r.p.product}">${r.p.product.substring(0, 10)}</td>
      <td>${r.p.volume_tons.toLocaleString()}</td>
      <td>${fmt(r.p.asp)}</td>
      <td>${fmt(r.p.delivery_fee)}</td>
      <td><strong>${fmt(r.p.total_asp)}</strong></td>
    `;
    tbody.appendChild(tr);
  });

  // Draw highlighted hit layer on top of base dots
  state.hitOrdersLayer = buildHitLayer(results).addTo(map);

  renderCompetitors(clickLat, clickLon);
}

// ── Nearby plants sidebar ──────────────────────────────
function renderCompetitors(clickLat, clickLon) {
  const container = document.getElementById('competitors-list');
  container.innerHTML = '';
  if (!state.plantsData) return;

  const plants = state.plantsData.features
    .map(f => {
      const [lon, lat] = f.geometry.coordinates;
      return { ...f.properties, lat, lon, dist: haversine(clickLat, clickLon, lat, lon) };
    })
    .filter(p => p.dist <= state.radius * 3)
    .sort((a, b) => a.dist - b.dist);

  if (!plants.length) {
    container.innerHTML = '<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);">No plants within range</div>';
    return;
  }

  plants.forEach(p => {
    const row = document.createElement('div');
    row.className = 'competitor-row' + (p.owner === 'owned' ? ' owned-row' : '');
    row.innerHTML = `
      <div>
        <div class="competitor-name">${p.name}</div>
        <div class="competitor-geo">${p.geology} · ${p.owner === 'owned' ? 'Owned' : 'Competitor'}</div>
      </div>
      <div class="competitor-dist">${p.dist.toFixed(1)} mi</div>
    `;
    container.appendChild(row);
  });
}

// ── Radius circle helper ───────────────────────────────
function drawRadiusCircle(lat, lng) {
  if (state.radiusCircle) map.removeLayer(state.radiusCircle);
  state.radiusCircle = L.circle([lat, lng], {
    radius:      state.radius * 1609.34,
    color:       'rgba(232,160,32,0.7)',
    weight:      1.5,
    fillColor:   'rgba(232,160,32,0.07)',
    fillOpacity: 1,
    dashArray:   '5,5',
    renderer:    canvasRenderer,
  }).addTo(map);
}

// ── Map click ──────────────────────────────────────────
map.on('click', e => {
  const { lat, lng } = e.latlng;
  if (state.clickMarker) map.removeLayer(state.clickMarker);
  drawRadiusCircle(lat, lng);
  state.clickMarker = L.marker([lat, lng], { icon: clickIcon() }).addTo(map);
  document.getElementById('map-overlay-hint').classList.add('hidden');
  renderResults(lat, lng);
});

// ── Clear button ───────────────────────────────────────
document.getElementById('clear-btn').addEventListener('click', () => {
  if (state.clickMarker)   map.removeLayer(state.clickMarker);
  if (state.radiusCircle)  map.removeLayer(state.radiusCircle);
  if (state.hitOrdersLayer){ map.removeLayer(state.hitOrdersLayer); state.hitOrdersLayer = null; }
  state.clickMarker  = null;
  state.radiusCircle = null;
  document.getElementById('results-panel').style.display = 'none';
  document.getElementById('click-hint').style.display    = 'block';
  document.getElementById('map-overlay-hint').classList.remove('hidden');
});

// ── Controls ───────────────────────────────────────────
document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.radius = parseFloat(btn.dataset.val);
    rerunEstimate();
  });
});

document.getElementById('product-type-filter').addEventListener('change', e => {
  state.productType = e.target.value;
  rerunEstimate();
});

document.getElementById('date-from').addEventListener('change', e => {
  state.dateFrom = e.target.value;
  rerunEstimate();
});

document.getElementById('date-to').addEventListener('change', e => {
  state.dateTo = e.target.value;
  rerunEstimate();
});

function rerunEstimate() {
  if (!state.clickMarker) return;
  const { lat, lng } = state.clickMarker.getLatLng();
  drawRadiusCircle(lat, lng);
  renderResults(lat, lng);
}

// ── Load data ──────────────────────────────────────────
async function loadData() {
  try {
    const [plantsRes, ordersRes] = await Promise.all([
      fetch('plants.geojson'),
      fetch('orders.geojson'),
    ]);
    state.plantsData = await plantsRes.json();
    state.ordersData = await ordersRes.json();

    // Draw all order dots (canvas — very fast)
    state.allOrdersLayer = buildAllOrdersLayer(state.ordersData.features).addTo(map);

    // Draw plant markers (divIcon SVG shapes)
    state.plantsData.features.forEach(f => {
      const p          = f.properties;
      const [lon, lat] = f.geometry.coordinates;

      const prodList = p.products.length
        ? p.products.map(pr => `<div class="popup-row"><span class="popup-val">${pr}</span></div>`).join('')
        : '<span class="popup-key">No product data</span>';

      L.marker([lat, lon], { icon: plantIcon(p.geology, p.owner), zIndexOffset: 1000 })
        .bindPopup(`
          <div class="popup-title">${p.name}</div>
          <div class="popup-row"><span class="popup-key">Owner</span><span class="popup-val">${p.owner === 'owned' ? 'Owned' : 'Competitor'}</span></div>
          <div class="popup-row"><span class="popup-key">Geology</span><span class="popup-val">${p.geology}</span></div>
          ${p.products.length ? '<div class="popup-key" style="margin-top:6px;margin-bottom:3px;">Products</div>' + prodList : ''}
        `)
        .addTo(map);
    });

  } catch (err) {
    console.error('Failed to load GeoJSON:', err);
  }
}

loadData();
