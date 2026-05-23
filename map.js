/* ═══════════════════════════════════════════════════════
   AggsData — Delivered Price Estimator
   map.js
   ═══════════════════════════════════════════════════════ */

const CONFIG = {
  center:               [47.55, -122.10],
  zoom:                 10,
  minZoom:              7,
  maxZoom:              17,
  defaultRadius:        5,
  priceRange:           0.05,
  maxOrdersInTable:     50,
  recentWeight:         2.0,
  semivariogramRange:   30,
  nugget:               0.10,
  truckOverheadMinutes: 5,
  driveTimeColors:      ['#00bcd4', '#ff7043', '#ab47bc'],
  enableAddressSearch:  false,   // Nominatim geocoder — re-enable when a better API key is available
};

let state = {
  ordersData:          null,
  plantsData:          null,
  radius:              CONFIG.defaultRadius,
  productType:         'all',
  product:             'all',
  dateFrom:            '2020-01-01',
  dateTo:              '2024-12-31',
  clickMarker:         null,
  radiusCircle:        null,
  allOrdersLayer:      null,
  hitOrdersLayer:      null,
  driveTimeLayerGroup: null,
  sortCol:             'dist',
  sortDir:             'asc',
  lastResults:         null,
  lastClick:           null,
};

// ── Map ────────────────────────────────────────────────
const canvasRenderer = L.canvas({ padding: 0.5 });

const map = L.map('map', {
  center:      CONFIG.center,
  zoom:        CONFIG.zoom,
  minZoom:     CONFIG.minZoom,
  maxZoom:     CONFIG.maxZoom,
  zoomControl: true,
  renderer:    canvasRenderer,
  attributionControl: false
});

L.control.attribution({
  position: 'topright'
}).addTo(map)

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OpenStreetMap © CARTO',
  subdomains:  'abcd',
  maxZoom:     19,
}).addTo(map);

// ── Plant icons ────────────────────────────────────────
function plantIcon(geology, owner) {
  const owned  = owner === 'owned';
  const fill   = owned ? '#e8a020' : '#e05070';
  const stroke = owned ? '#7a4800' : '#7a1530';
  const size   = owned ? 20 : 16;

  let shape;
  if (geology === 'Sand & Gravel') {
    shape = `<polygon points="10,2 19,18 1,18" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`;
  } else if (geology === 'Hard Rock') {
    shape = `<rect x="2" y="2" width="16" height="16" rx="1" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  } else {
    shape = `<polygon points="10,1 19,10 10,19 1,10" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`;
  }

  return L.divIcon({
    className: '',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">${shape}</svg>`,
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

// ── Haversine ──────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Kriging weight ─────────────────────────────────────
function krigingWeight(dist_miles, daysSince) {
  const h = dist_miles, a = CONFIG.semivariogramRange, nug = CONFIG.nugget;
  let gamma;
  if      (h <= 0) gamma = 0;
  else if (h >= a) gamma = 1;
  else { const r = h / a; gamma = nug + (1 - nug) * (1.5 * r - 0.5 * r ** 3); }
  const spatialW    = Math.max(0, 1 - gamma);
  const timeW       = Math.exp(-Math.LN2 * daysSince / 730);
  const recentBoost = daysSince < 365 ? CONFIG.recentWeight : 1.0;
  return spatialW * timeW * recentBoost;
}

// ── Estimation ─────────────────────────────────────────
function estimatePrice(clickLat, clickLon, orders, radiusMiles) {
  const now = new Date(), results = [];
  orders.forEach(f => {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const dist = haversine(clickLat, clickLon, lat, lon);
    if (dist > radiusMiles)                                          return;
    if (p.date < state.dateFrom || p.date > state.dateTo)           return;
    if (state.productType !== 'all' && p.product_type !== state.productType) return;
    if (state.product     !== 'all' && p.product      !== state.product)     return;
    const daysSince = (now - new Date(p.date)) / 86400000;
    const w = krigingWeight(dist, daysSince);
    results.push({ p, dist, w, lat, lon });
  });
  if (!results.length) return null;
  const wSum = results.reduce((s, r) => s + r.w, 0);
  results.forEach(r => r.normW = r.w / wSum);
  const estimate = results.reduce((s, r) => s + r.p.total_asp * r.normW, 0);
  results.sort((a, b) => b.w - a.w);
  return { estimate, results };
}

const fmt = v => '$' + v.toFixed(2);

// ── Sort helpers ───────────────────────────────────────
function sortResults(results) {
  const col = state.sortCol, dir = state.sortDir === 'asc' ? 1 : -1;
  return [...results].sort((a, b) => {
    let va = col === 'dist' ? a.dist : a.p[col];
    let vb = col === 'dist' ? b.dist : b.p[col];
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
}

function updateSortHeaders() {
  document.querySelectorAll('#orders-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    const icon = th.querySelector('.sort-icon');
    icon.textContent = '⇅';
    if (th.dataset.col === state.sortCol) {
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      icon.textContent = state.sortDir === 'asc' ? '↑' : '↓';
    }
  });
}

// ── Populate product dropdown ──────────────────────────
let productsByType = {};

function buildProductMap(features) {
  const map = {};
  features.forEach(f => {
    const { product, product_type } = f.properties;
    if (!map.all) map.all = new Set();
    map.all.add(product);
    if (product_type) {
      if (!map[product_type]) map[product_type] = new Set();
      map[product_type].add(product);
    }
  });
  Object.keys(map).forEach(k => { map[k] = [...map[k]].sort(); });
  return map;
}

function filterProductDropdown(type) {
  const sel      = document.getElementById('product-filter');
  const products = productsByType[type] ?? productsByType.all ?? [];
  sel.innerHTML  = '<option value="all">All Products</option>';
  products.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    sel.appendChild(opt);
  });
  sel.value    = 'all';
  state.product = 'all';
}

function populateProductFilter(features) {
  productsByType = buildProductMap(features);
  filterProductDropdown('all');
}

// ── Always-on order layer ──────────────────────────────
function buildAllOrdersLayer(features) {
  return L.geoJSON({ type: 'FeatureCollection', features }, {
    renderer: canvasRenderer,
    pointToLayer(f, latlng) {
      return L.circleMarker(latlng, {
        radius: 4, fillColor: '#4cb87a', fillOpacity: 0.55,
        color: '#1a3d2b', weight: 0.8,
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

// ── Highlighted hit layer ──────────────────────────────
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
      const op = Math.max(0.4, Math.min(1.0, 0.4 + f.properties.normW * 0.6));
      return L.circleMarker(latlng, {
        radius: 5, fillColor: '#e8a020', fillOpacity: op,
        color: '#7a4800', weight: 1,
      });
    },
    onEachFeature(f, layer) {
      const p = f.properties;
      layer.bindPopup(`
        <div class="popup-title">${p.product}</div>
        <div class="popup-row"><span class="popup-key">Date</span><span class="popup-val">${p.date}</span></div>
        <div class="popup-row"><span class="popup-key">Plant</span><span class="popup-val">${p.plant_name}</span></div>
        <div class="popup-row"><span class="popup-key">Distance</span><span class="popup-val">${p.dist.toFixed(1)} mi</span></div>
        <div class="popup-row"><span class="popup-key">Total ASP</span><span class="popup-val">${fmt(p.total_asp)}</span></div>
        <div class="popup-row"><span class="popup-key">Volume</span><span class="popup-val">${p.volume_tons.toLocaleString()} T</span></div>
        <div class="popup-row"><span class="popup-key">Krig. Weight</span><span class="popup-val">${(p.normW * 100).toFixed(1)}%</span></div>
      `);
    },
  });
}

// ── Render table from sorted results ───────────────────
function renderTable(results) {
  const sorted = sortResults(results);
  const tbody  = document.getElementById('orders-tbody');
  tbody.innerHTML = '';
  sorted.slice(0, CONFIG.maxOrdersInTable).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.p.date}</td>
      <td>${r.p.product}</td>
      <td>${r.p.plant_name}</td>
      <td>${r.dist.toFixed(1)} mi</td>
      <td>${r.p.volume_tons.toLocaleString()}</td>
      <td>${fmt(r.p.asp)}</td>
      <td>${fmt(r.p.delivery_fee)}</td>
      <td><strong>${fmt(r.p.total_asp)}</strong></td>
    `;
    tbody.appendChild(tr);
  });
  updateSortHeaders();
}

// ── Render sidebar ─────────────────────────────────────
function renderResults(clickLat, clickLon) {
  if (!state.ordersData) return;
  const result = estimatePrice(clickLat, clickLon, state.ordersData.features, state.radius);

  document.getElementById('results-panel').style.display = 'block';
  document.getElementById('click-hint').style.display    = 'none';

  if (state.hitOrdersLayer) { map.removeLayer(state.hitOrdersLayer); state.hitOrdersLayer = null; }

  if (!result) {
    document.getElementById('est-value').textContent          = 'N/A';
    document.getElementById('est-low').textContent            = '—';
    document.getElementById('est-high').textContent           = '—';
    document.getElementById('est-orders-used').textContent    = 'No orders in radius';
    document.getElementById('est-radius').textContent         = '';
    document.getElementById('orders-drawer').classList.remove('visible');
    state.lastResults = null;
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

  state.lastResults = results;
  renderTable(results);

  const drawer       = document.getElementById('orders-drawer');
  const isNewlyShown = !drawer.classList.contains('visible');
  drawer.classList.add('visible');
  if (isNewlyShown) {
    document.getElementById('orders-table-container').style.maxHeight = '240px';
    document.getElementById('orders-collapse-btn').textContent        = '▼';
  }
  document.getElementById('orders-count-badge').textContent = results.length;

  state.hitOrdersLayer = buildHitLayer(results).addTo(map);
  renderCompetitors(clickLat, clickLon);
}

// ── Nearby plants ──────────────────────────────────────
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
    const chips = p.products.length
      ? `<div class="competitor-products">${p.products.map(pr => `<span class="product-chip">${pr}</span>`).join('')}</div>`
      : '';
    row.innerHTML = `
      <div class="competitor-info">
        <div class="competitor-name">${p.name}</div>
        <div class="competitor-geo">${p.geology} · ${p.owner === 'owned' ? 'Owned' : 'Competitor'}</div>
        ${chips}
      </div>
      <div class="competitor-dist">${p.dist.toFixed(1)} mi</div>
    `;
    container.appendChild(row);
  });
}

// ── Radius circle ──────────────────────────────────────
function drawRadiusCircle(lat, lng) {
  if (state.radiusCircle) map.removeLayer(state.radiusCircle);
  state.radiusCircle = L.circle([lat, lng], {
    radius: state.radius * 1609.34,
    color: 'rgba(232,160,32,0.7)', weight: 1.5,
    fillColor: 'rgba(232,160,32,0.07)', fillOpacity: 1,
    dashArray: '5,5', renderer: canvasRenderer,
  }).addTo(map);
}

// ── Drive time analysis ─────────────────────────────────
function formatDuration(seconds) {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function clearDriveTimeRoutes() {
  if (state.driveTimeLayerGroup) {
    map.removeLayer(state.driveTimeLayerGroup);
    state.driveTimeLayerGroup = null;
  }
  document.getElementById('drivetime-results').innerHTML = '';
  document.getElementById('drivetime-loading').style.display = 'none';
  const btn = document.getElementById('drivetime-btn');
  btn.textContent = '▶ Run';
  btn.disabled = false;
  delete btn.dataset.active;
}

async function runDriveTimeAnalysis(clickLat, clickLon) {
  clearDriveTimeRoutes();

  const resultsEl = document.getElementById('drivetime-results');
  const loadingEl = document.getElementById('drivetime-loading');
  const btn       = document.getElementById('drivetime-btn');

  loadingEl.style.display = 'block';
  btn.disabled    = true;
  btn.textContent = '…';

  const plants = state.plantsData.features
    .map(f => {
      const [lon, lat] = f.geometry.coordinates;
      return { ...f.properties, lat, lon, dist: haversine(clickLat, clickLon, lat, lon) };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3);

  state.driveTimeLayerGroup = L.layerGroup().addTo(map);
  const overheadSecs = CONFIG.truckOverheadMinutes * 60;
  const routeData    = [];

  for (let i = 0; i < plants.length; i++) {
    const plant = plants[i];
    const color = CONFIG.driveTimeColors[i];
    try {
      // Uses the OSRM public demo server — swap base URL for self-hosted or paid routing API in production
      const url  = `https://router.project-osrm.org/route/v1/driving/${plant.lon},${plant.lat};${clickLon},${clickLat}?overview=full&geometries=geojson`;
      const resp = await fetch(url);
      const data = await resp.json();

      if (data.code !== 'Ok' || !data.routes.length) {
        routeData.push({ plant, color, error: 'No route found' });
        continue;
      }

      const route         = data.routes[0];
      const oneWaySecs    = route.duration;
      const roadDistMi    = route.distance / 1609.34;
      const roundTripSecs = oneWaySecs * 2 + overheadSecs;

      const coords = route.geometry.coordinates.map(([ln, lt]) => [lt, ln]);
      L.polyline(coords, { color, weight: 4, opacity: 0.85, lineJoin: 'round' })
        .addTo(state.driveTimeLayerGroup);

      L.circleMarker([plant.lat, plant.lon], {
        radius: 7, fillColor: color, fillOpacity: 1, color: '#fff', weight: 2,
      })
        .bindTooltip(plant.name, { permanent: false })
        .addTo(state.driveTimeLayerGroup);

      routeData.push({ plant, color, oneWaySecs, roadDistMi, roundTripSecs });
    } catch {
      routeData.push({ plant, color, error: 'Route unavailable' });
    }
  }

  loadingEl.style.display = 'none';
  btn.disabled       = false;
  btn.textContent    = '✕ Clear';
  btn.dataset.active = 'true';

  routeData.forEach(r => {
    const row = document.createElement('div');
    row.className = 'drivetime-row';
    row.style.borderLeftColor = r.color;
    if (r.error) {
      row.innerHTML = `
        <div>
          <div class="competitor-name">${r.plant.name}</div>
          <div class="competitor-geo">${r.plant.geology} &middot; ${r.plant.owner === 'owned' ? 'Owned' : 'Competitor'}</div>
        </div>
        <div class="drivetime-times"><span class="drivetime-error">${r.error}</span></div>`;
    } else {
      row.innerHTML = `
        <div>
          <div class="competitor-name">${r.plant.name}</div>
          <div class="competitor-geo">${r.plant.geology} &middot; ${r.plant.owner === 'owned' ? 'Owned' : 'Competitor'}</div>
          <div class="drivetime-road-dist">${r.roadDistMi.toFixed(1)} mi by road</div>
        </div>
        <div class="drivetime-times">
          <div class="drivetime-oneway">one-way ${formatDuration(r.oneWaySecs)}</div>
          <div class="drivetime-roundtrip">&#8635; ${formatDuration(r.roundTripSecs)} round trip</div>
        </div>`;
    }
    resultsEl.appendChild(row);
  });
}

// ── Select location (shared by map click + address search) ─
function selectLocation(lat, lng) {
  state.lastClick = { lat, lng };
  clearDriveTimeRoutes();
  if (state.clickMarker) map.removeLayer(state.clickMarker);
  drawRadiusCircle(lat, lng);
  state.clickMarker = L.marker([lat, lng], { icon: clickIcon() }).addTo(map);
  document.getElementById('map-overlay-hint').classList.add('hidden');
  renderResults(lat, lng);
}

// ── Map click ──────────────────────────────────────────
map.on('click', e => {
  selectLocation(e.latlng.lat, e.latlng.lng);
});

// ── Clear ──────────────────────────────────────────────
document.getElementById('clear-btn').addEventListener('click', () => {
  if (state.clickMarker)   map.removeLayer(state.clickMarker);
  if (state.radiusCircle)  map.removeLayer(state.radiusCircle);
  if (state.hitOrdersLayer){ map.removeLayer(state.hitOrdersLayer); state.hitOrdersLayer = null; }
  clearDriveTimeRoutes();
  state.clickMarker = state.radiusCircle = state.lastClick = state.lastResults = null;
  document.getElementById('results-panel').style.display = 'none';
  document.getElementById('orders-drawer').classList.remove('visible');
  document.getElementById('click-hint').style.display    = 'block';
  document.getElementById('map-overlay-hint').classList.remove('hidden');
});

document.getElementById('drivetime-btn').addEventListener('click', () => {
  const btn = document.getElementById('drivetime-btn');
  if (btn.dataset.active === 'true') {
    clearDriveTimeRoutes();
  } else if (state.lastClick) {
    runDriveTimeAnalysis(state.lastClick.lat, state.lastClick.lng);
  }
});

// ── Address search ──────────────────────────────────────
const SearchCtrl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const wrap = L.DomUtil.create('div', 'search-control');
    L.DomEvent.disableClickPropagation(wrap);
    L.DomEvent.disableScrollPropagation(wrap);
    wrap.innerHTML = `
      <div class="search-input-wrap">
        <input id="address-search" type="text" placeholder="Search address…" autocomplete="off" spellcheck="false" />
        <button id="address-search-btn" title="Search">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2.2"/>
            <line x1="13" y1="13" x2="19" y2="19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div id="search-results"></div>
    `;
    return wrap;
  },
});
if (CONFIG.enableAddressSearch) new SearchCtrl().addTo(map);

function closeSearchResults() {
  document.getElementById('search-results').innerHTML = '';
}

async function geocodeAddress() {
  const input  = document.getElementById('address-search');
  const query  = input.value.trim();
  if (!query) return;
  const b      = map.getBounds();
  const vbox   = `${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
  const url    = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&viewbox=${vbox}&bounded=0&countrycodes=us`;
  const resEl  = document.getElementById('search-results');
  resEl.innerHTML = '<div class="search-no-results">Searching…</div>';
  try {
    const data = await (await fetch(url, { headers: { 'Accept-Language': 'en-US,en' } })).json();
    resEl.innerHTML = '';
    if (!data.length) {
      resEl.innerHTML = '<div class="search-no-results">No results found</div>';
      return;
    }
    data.forEach(r => {
      const item       = document.createElement('div');
      item.className   = 'search-result-item';
      item.textContent = r.display_name.length > 58 ? r.display_name.slice(0, 55) + '…' : r.display_name;
      item.title       = r.display_name;
      item.addEventListener('click', e => {
        L.DomEvent.stopPropagation(e);
        const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
        input.value = r.display_name.split(',').slice(0, 2).join(', ').trim();
        closeSearchResults();
        map.setView([lat, lng], Math.max(map.getZoom(), 13));
        selectLocation(lat, lng);
      });
      resEl.appendChild(item);
    });
  } catch {
    document.getElementById('search-results').innerHTML = '<div class="search-no-results">Search unavailable</div>';
  }
}

if (CONFIG.enableAddressSearch) {
  document.getElementById('address-search').addEventListener('keydown', e => {
    if (e.key === 'Enter')  geocodeAddress();
    if (e.key === 'Escape') closeSearchResults();
  });
  document.getElementById('address-search-btn').addEventListener('click', geocodeAddress);
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-control')) closeSearchResults();
  });
}

// ── Sort click ─────────────────────────────────────────
document.querySelectorAll('#orders-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    if (state.sortCol === th.dataset.col) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortCol = th.dataset.col;
      state.sortDir = 'asc';
    }
    if (state.lastResults) renderTable(state.lastResults);
  });
});

// ── Controls ───────────────────────────────────────────
function rerunEstimate() {
  if (!state.lastClick) return;
  drawRadiusCircle(state.lastClick.lat, state.lastClick.lng);
  renderResults(state.lastClick.lat, state.lastClick.lng);
}

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
  filterProductDropdown(e.target.value);
  rerunEstimate();
});

document.getElementById('product-filter').addEventListener('change', e => {
  state.product = e.target.value;
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

// ── Reset parameters ───────────────────────────────────
document.getElementById('reset-params-btn').addEventListener('click', () => {
  state.radius = CONFIG.defaultRadius;
  document.querySelectorAll('.toggle-btn').forEach(b => {
    b.classList.toggle('active', parseFloat(b.dataset.val) === CONFIG.defaultRadius);
  });
  state.productType = 'all';
  document.getElementById('product-type-filter').value = 'all';
  filterProductDropdown('all');
  state.dateFrom = '2020-01-01';
  state.dateTo   = '2024-12-31';
  document.getElementById('date-from').value = '2020-01-01';
  document.getElementById('date-to').value   = '2024-12-31';
  rerunEstimate();
});

// ── Orders panel — collapse / download ────────────────
document.getElementById('orders-collapse-btn').addEventListener('click', () => {
  const container = document.getElementById('orders-table-container');
  const btn       = document.getElementById('orders-collapse-btn');
  const expanded  = container.style.maxHeight !== '0px';
  container.style.maxHeight = expanded ? '0px' : '240px';
  btn.textContent = expanded ? '▲' : '▼';
});

document.getElementById('download-orders-btn').addEventListener('click', () => {
  if (!state.lastResults) return;
  const sorted = sortResults(state.lastResults);
  const header = ['Date', 'Product', 'Plant', 'Distance (mi)', 'Volume (T)', 'ASP', 'Delivery', 'Total ASP'];
  const rows   = sorted.map(r => [
    r.p.date,
    `"${r.p.product}"`,
    `"${r.p.plant_name}"`,
    r.dist.toFixed(2),
    r.p.volume_tons,
    r.p.asp.toFixed(2),
    r.p.delivery_fee.toFixed(2),
    r.p.total_asp.toFixed(2),
  ]);
  const csv  = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `nearby-orders-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ── Load data ──────────────────────────────────────────
async function loadData() {
  try {
    const [plantsRes, ordersRes] = await Promise.all([
      fetch('plants.geojson'),
      fetch('orders.geojson'),
    ]);
    state.plantsData = await plantsRes.json();
    state.ordersData = await ordersRes.json();

    populateProductFilter(state.ordersData.features);

    state.allOrdersLayer = buildAllOrdersLayer(state.ordersData.features).addTo(map);

    state.plantsData.features.forEach(f => {
      const p = f.properties;
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
