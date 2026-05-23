/* ═══════════════════════════════════════════════════════
   AggsData — Delivered Price Estimator
   map.js — Leaflet map, data loading, kriging estimation
   ═══════════════════════════════════════════════════════ */

// ── Config ─────────────────────────────────────────────
const CONFIG = {
  center:      [47.55, -122.10],
  zoom:        10,
  minZoom:     7,
  maxZoom:     17,
  defaultRadius: 5,           // miles
  priceRange:  0.05,          // ±5 %
  maxOrdersInTable: 30,
  recentWeight:   2.0,        // extra weight multiplier for orders < 1 yr old
  semivariogramRange: 30,     // miles — kriging correlation range
  nugget: 0.10,               // kriging nugget (relative noise fraction)
};

// ── State ──────────────────────────────────────────────
let state = {
  ordersData:  null,
  plantsData:  null,
  radius:      CONFIG.defaultRadius,
  productType: 'all',
  dateFrom:    '2020-01-01',
  dateTo:      '2024-12-31',
  clickMarker: null,
  radiusCircle: null,
  orderDots:   [],
};

// ── Map init ───────────────────────────────────────────
const map = L.map('map', {
  center:  CONFIG.center,
  zoom:    CONFIG.zoom,
  minZoom: CONFIG.minZoom,
  maxZoom: CONFIG.maxZoom,
  zoomControl: true,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap',
  maxZoom: 19,
}).addTo(map);

// ── Marker icon factories ──────────────────────────────
function plantIcon(owner) {
  const color = owner === 'owned' ? '#e8a020' : '#e05070';
  const size  = owner === 'owned' ? 16 : 13;
  return L.divIcon({
    className: '',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
      <polygon points="8,1 15,15 1,15" fill="${color}" stroke="#12151a" stroke-width="1.5"/>
    </svg>`,
    iconSize:   [size, size],
    iconAnchor: [size/2, size/2],
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

function orderDotIcon(weight) {
  // Opacity scaled by kriging weight (0.3–1.0)
  const op = Math.max(0.3, Math.min(1.0, 0.3 + weight * 0.7)).toFixed(2);
  return L.divIcon({
    className: '',
    html: `<svg width="8" height="8" viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg">
      <circle cx="4" cy="4" r="3" fill="#4cb87a" fill-opacity="${op}" stroke="#12151a" stroke-width="0.8"/>
    </svg>`,
    iconSize:   [8, 8],
    iconAnchor: [4, 4],
  });
}

// ── Haversine distance (miles) ─────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2
          + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Simple kriging weight using spherical semivariogram ─
// Returns a weight 0–1; closer & newer → higher weight
function krigingWeight(dist_miles, daysSince, totalDays) {
  const h = dist_miles;
  const a = CONFIG.semivariogramRange;
  const nug = CONFIG.nugget;

  // Spherical model: γ(h)
  let gamma;
  if (h <= 0) {
    gamma = 0;
  } else if (h >= a) {
    gamma = 1;
  } else {
    const r = h / a;
    gamma = nug + (1 - nug) * (1.5*r - 0.5*r**3);
  }

  // Spatial weight = 1 - γ(h)
  const spatialW = Math.max(0, 1 - gamma);

  // Temporal decay: exponential, half-life ≈ 2 years
  const halfLife = 730; // days
  const timeW = Math.exp(-Math.LN2 * daysSince / halfLife);

  // Boost very recent orders
  const recentBoost = daysSince < 365 ? CONFIG.recentWeight : 1.0;

  return spatialW * timeW * recentBoost;
}

// ── Main estimation function ───────────────────────────
function estimatePrice(clickLat, clickLon, orders, radiusMiles) {
  const now = new Date();
  const results = [];

  orders.forEach(f => {
    const p   = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const dist = haversine(clickLat, clickLon, lat, lon);
    if (dist > radiusMiles) return;

    // Date filters
    if (p.date < state.dateFrom || p.date > state.dateTo) return;

    // Product type filter
    if (state.productType !== 'all' && p.product_type !== state.productType) return;

    const orderDate  = new Date(p.date);
    const daysSince  = (now - orderDate) / 86400000;
    const totalDays  = (now - new Date('2020-01-01')) / 86400000;
    const w = krigingWeight(dist, daysSince, totalDays);

    results.push({ p, dist, w, lat, lon });
  });

  if (results.length === 0) return null;

  // Normalise weights
  const wSum = results.reduce((s, r) => s + r.w, 0);
  results.forEach(r => r.normW = r.w / wSum);

  // Weighted mean
  const estimate = results.reduce((s, r) => s + r.p.total_asp * r.normW, 0);

  // Sort by weight desc for table
  results.sort((a, b) => b.w - a.w);

  return { estimate, results, wSum };
}

// ── Format currency ────────────────────────────────────
const fmt = v => '$' + v.toFixed(2);

// ── Render sidebar results ─────────────────────────────
function renderResults(clickLat, clickLon) {
  if (!state.ordersData) return;

  const result = estimatePrice(clickLat, clickLon, state.ordersData.features, state.radius);

  const panel = document.getElementById('results-panel');
  panel.style.display = 'block';
  document.getElementById('click-hint').style.display = 'none';

  if (!result || result.results.length === 0) {
    document.getElementById('est-value').textContent = 'N/A';
    document.getElementById('est-low').textContent   = '—';
    document.getElementById('est-high').textContent  = '—';
    document.getElementById('est-orders-used').textContent = 'No orders in radius';
    document.getElementById('est-radius').textContent = '';
    document.getElementById('orders-tbody').innerHTML = '';
    document.getElementById('orders-count-badge').textContent = '0';
    renderCompetitors(clickLat, clickLon);
    return;
  }

  const { estimate, results } = result;
  const lo = estimate * (1 - CONFIG.priceRange);
  const hi = estimate * (1 + CONFIG.priceRange);

  document.getElementById('est-value').textContent = fmt(estimate);
  document.getElementById('est-low').textContent   = fmt(lo);
  document.getElementById('est-high').textContent  = fmt(hi);
  document.getElementById('est-orders-used').textContent =
    `${results.length} order${results.length !== 1 ? 's' : ''} used`;
  document.getElementById('est-radius').textContent = `${state.radius} mi radius`;
  document.getElementById('orders-count-badge').textContent = results.length;

  // Table
  const tbody = document.getElementById('orders-tbody');
  tbody.innerHTML = '';
  const display = results.slice(0, CONFIG.maxOrdersInTable);
  display.forEach(r => {
    const tr = document.createElement('tr');
    const ptype = { concrete_agg:'Conc', asphalt_agg:'Asph', base:'Base' }[r.p.product_type] || r.p.product_type;
    tr.innerHTML = `
      <td>${r.p.date}</td>
      <td title="${r.p.product}">${r.p.product.substring(0,10)}</td>
      <td>${r.p.volume_tons.toLocaleString()}</td>
      <td>${fmt(r.p.asp)}</td>
      <td>${fmt(r.p.delivery_fee)}</td>
      <td><strong>${fmt(r.p.total_asp)}</strong></td>
    `;
    tbody.appendChild(tr);
  });

  // Draw order dots on map
  clearOrderDots();
  display.forEach(r => {
    const dot = L.marker([r.lat, r.lon], { icon: orderDotIcon(r.normW) })
      .bindPopup(`
        <div class="popup-title">${r.p.product}</div>
        <div class="popup-row"><span class="popup-key">Date</span><span class="popup-val">${r.p.date}</span></div>
        <div class="popup-row"><span class="popup-key">Total ASP</span><span class="popup-val">${fmt(r.p.total_asp)}</span></div>
        <div class="popup-row"><span class="popup-key">Volume</span><span class="popup-val">${r.p.volume_tons.toLocaleString()} T</span></div>
        <div class="popup-row"><span class="popup-key">Plant</span><span class="popup-val">${r.p.plant_name}</span></div>
        <div class="popup-row"><span class="popup-key">Distance</span><span class="popup-val">${r.dist.toFixed(1)} mi</span></div>
        <div class="popup-row"><span class="popup-key">Krig. Weight</span><span class="popup-val">${(r.normW*100).toFixed(1)}%</span></div>
      `)
      .addTo(map);
    state.orderDots.push(dot);
  });

  renderCompetitors(clickLat, clickLon);
}

function clearOrderDots() {
  state.orderDots.forEach(d => map.removeLayer(d));
  state.orderDots = [];
}

// ── Render nearby plants (owned + competitors) ─────────
function renderCompetitors(clickLat, clickLon) {
  const container = document.getElementById('competitors-list');
  container.innerHTML = '';
  if (!state.plantsData) return;

  const plants = state.plantsData.features.map(f => {
    const [lon, lat] = f.geometry.coordinates;
    return { ...f.properties, lat, lon,
      dist: haversine(clickLat, clickLon, lat, lon) };
  })
  .filter(p => p.dist <= state.radius * 3) // show within 3x radius
  .sort((a, b) => a.dist - b.dist);

  if (plants.length === 0) {
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

// ── Map click handler ──────────────────────────────────
map.on('click', e => {
  const { lat, lng } = e.latlng;

  // Clear previous
  if (state.clickMarker)  map.removeLayer(state.clickMarker);
  if (state.radiusCircle) map.removeLayer(state.radiusCircle);

  // Radius circle (miles → meters)
  const radiusMeters = state.radius * 1609.34;
  state.radiusCircle = L.circle([lat, lng], {
    radius:      radiusMeters,
    color:       'rgba(232,160,32,0.7)',
    weight:      1.5,
    fillColor:   'rgba(232,160,32,0.07)',
    fillOpacity: 1,
    dashArray:   '5,5',
  }).addTo(map);

  state.clickMarker = L.marker([lat, lng], { icon: clickIcon() }).addTo(map);

  document.getElementById('map-overlay-hint').classList.add('hidden');
  renderResults(lat, lng);
});

// ── Clear button ───────────────────────────────────────
document.getElementById('clear-btn').addEventListener('click', () => {
  if (state.clickMarker)  map.removeLayer(state.clickMarker);
  if (state.radiusCircle) map.removeLayer(state.radiusCircle);
  state.clickMarker  = null;
  state.radiusCircle = null;
  clearOrderDots();
  document.getElementById('results-panel').style.display = 'none';
  document.getElementById('click-hint').style.display = 'block';
  document.getElementById('map-overlay-hint').classList.remove('hidden');
});

// ── Control: radius toggle ─────────────────────────────
document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.radius = parseFloat(btn.dataset.val);
    rerunEstimate();
  });
});

// ── Control: product type ──────────────────────────────
document.getElementById('product-type-filter').addEventListener('change', e => {
  state.productType = e.target.value;
  rerunEstimate();
});

// ── Control: date range ────────────────────────────────
document.getElementById('date-from').addEventListener('change', e => {
  state.dateFrom = e.target.value;
  rerunEstimate();
});
document.getElementById('date-to').addEventListener('change', e => {
  state.dateTo = e.target.value;
  rerunEstimate();
});

// Re-run estimate if click already placed
function rerunEstimate() {
  if (!state.clickMarker) return;
  const { lat, lng } = state.clickMarker.getLatLng();

  // Update radius circle
  if (state.radiusCircle) map.removeLayer(state.radiusCircle);
  state.radiusCircle = L.circle([lat, lng], {
    radius:      state.radius * 1609.34,
    color:       'rgba(232,160,32,0.7)',
    weight:      1.5,
    fillColor:   'rgba(232,160,32,0.07)',
    fillOpacity: 1,
    dashArray:   '5,5',
  }).addTo(map);

  renderResults(lat, lng);
}

// ── Load GeoJSON data & draw static plant markers ──────
async function loadData() {
  try {
    const [plantsRes, ordersRes] = await Promise.all([
      fetch('plants.geojson'),
      fetch('orders.geojson'),
    ]);
    state.plantsData = await plantsRes.json();
    state.ordersData = await ordersRes.json();

    // Draw plant markers
    state.plantsData.features.forEach(f => {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      const marker = L.marker([lat, lon], { icon: plantIcon(p.owner) });

      const prodList = p.products.length
        ? p.products.map(pr => `<div class="popup-row" style="margin-bottom:2px;"><span class="popup-val">${pr}</span></div>`).join('')
        : '<span class="popup-key">No product data</span>';

      marker.bindPopup(`
        <div class="popup-title">${p.name}</div>
        <div class="popup-row">
          <span class="popup-key">Owner</span>
          <span class="popup-val">${p.owner === 'owned' ? 'Owned' : 'Competitor'}</span>
        </div>
        <div class="popup-row">
          <span class="popup-key">Geology</span>
          <span class="popup-val">${p.geology}</span>
        </div>
        ${p.products.length ? '<div class="popup-key" style="margin-top:6px;margin-bottom:3px;">Products</div>' + prodList : ''}
      `);

      marker.addTo(map);
    });

  } catch (err) {
    console.error('Failed to load GeoJSON:', err);
  }
}

loadData();
