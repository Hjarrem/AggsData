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
  truckOverheadMinutes: 10,
  driveTimeColors:      ['#00bcd4', '#ff7043', '#ab47bc', '#43a047', '#fb8c00', '#1e88e5'],
  volumeRefTons:        200,    // Hill-function half-saturation: orders at this tonnage get 50% weight on the way up
  volumeCap:            2000,   // tonnage above which the large-order discount kicks in; weight falls beyond this point
  escalationPct:        3.0,    // Annual price escalation % applied to historical prices before averaging
  enableAddressSearch:  true,
  mapboxToken:          pk.eyJ1Ijoicm9ja3JlcG9ydG5qIiwiYSI6ImNtcGp3NGZlbjE3eHoycHBzNWQycWtsejAifQ.zmQ6C-dqiEW4WjdaHmV6-w,   // replace with your pk.* token from mapbox.com
  enablePriceHeatmap:   false,   // Base ASP heatmap overlay — set true to expose the toggle in the legend
  // Isochrone ring styles (filled polygons rendered 45→30→15 so inner rings paint over outer)
  isochroneStyle: {
    45: { fillColor: '#6366f1', color: '#4338ca', fillOpacity: 0.08, weight: 1.2, opacity: 0.50 },
    30: { fillColor: '#0ea5e9', color: '#0369a1', fillOpacity: 0.10, weight: 1.4, opacity: 0.55 },
    15: { fillColor: '#f59e0b', color: '#b45309', fillOpacity: 0.13, weight: 1.6, opacity: 0.60 },
  },
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
  driveTimeLayerGroup:  null,
  isochroneLayer:       null,
  showIsochrones:       false,
  heatmapLayer:         null,
  showHeatmap:          false,
  priceHeatmapLayer:    null,
  showPriceHeatmap:     false,
  plantLabelLayer:      null,
  orderLabelLayer:      null,
  escalationPct:        CONFIG.escalationPct,
  hitLayerMap:          {},      // orderId → { lat, lon } for table-row hover → map highlight
  highlightMarker:     null,
  plantHighlightMarker:    null,
  driveTimeHighlightMarker: null,
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
function krigingWeight(dist_miles, daysSince, rangeMiles) {
  const h = dist_miles, a = rangeMiles ?? CONFIG.semivariogramRange, nug = CONFIG.nugget;
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
  // Build plant-name → coords lookup so we can report distance to source plant
  const plantCoords = {};
  if (state.plantsData) {
    state.plantsData.features.forEach(f => {
      const [plon, plat] = f.geometry.coordinates;
      plantCoords[f.properties.name] = { lat: plat, lon: plon };
    });
  }

  const now = new Date(), results = [];
  orders.forEach(f => {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const dist = haversine(clickLat, clickLon, lat, lon);  // click → order delivery point
    if (dist > radiusMiles)                                          return;
    if (p.date < state.dateFrom || p.date > state.dateTo)           return;
    if (state.productType !== 'all' && p.product_type !== state.productType) return;
    if (state.product     !== 'all' && p.product      !== state.product)     return;
    const daysSince = (now - new Date(p.date)) / 86400000;
    const spatialTimeW = krigingWeight(dist, daysSince, radiusMiles);
    // Hill function: large orders approach weight 1; small orders discounted
    const vol    = p.volume_tons > 0 ? p.volume_tons : 1;
    const volEff = Math.min(vol, CONFIG.volumeCap);   // cap large orders before applying Hill fn
    const volW   = volEff / (vol + CONFIG.volumeRefTons);
    const w    = spatialTimeW * volW;
    // Escalate historical price forward to today's equivalent
    const escalationRate   = (state.escalationPct ?? CONFIG.escalationPct) / 100;
    const escalationFactor = Math.pow(1 + escalationRate, daysSince / 365);
    const adjustedAsp      = p.total_asp * escalationFactor;
    const pc   = plantCoords[p.plant_name];
    const distToPlant = pc ? haversine(clickLat, clickLon, pc.lat, pc.lon) : null;
    results.push({ p, dist, distToPlant, w, lat, lon, adjustedAsp, escalationFactor });
  });
  if (!results.length) return null;
  results.forEach((r, i) => { r._id = i; });  // stable per-result ID for hover linking
  const wSum = results.reduce((s, r) => s + r.w, 0);
  results.forEach(r => r.normW = r.w / wSum);
  const estimate = results.reduce((s, r) => s + r.adjustedAsp * r.normW, 0);
  results.sort((a, b) => b.w - a.w);
  return { estimate, results };
}

const fmt = v => '$' + v.toFixed(2);

// ── Sort helpers ───────────────────────────────────────
function sortResults(results) {
  const col = state.sortCol, dir = state.sortDir === 'asc' ? 1 : -1;
  return [...results].sort((a, b) => {
    let va, vb;
    if      (col === 'dist')        { va = a.dist;                        vb = b.dist; }
    else if (col === 'distToPlant') { va = a.distToPlant ?? Infinity;     vb = b.distToPlant ?? Infinity; }
    else                            { va = a.p[col];                      vb = b.p[col]; }
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

// ── Isochrone layer ────────────────────────────────────
function buildIsochroneLayer(features) {
  // Render largest ring first so smaller rings paint over the center
  const ordered = [...features].sort((a, b) => b.properties.minutes - a.properties.minutes);
  const group   = L.layerGroup();
  ordered.forEach(f => {
    const style = CONFIG.isochroneStyle[f.properties.minutes] ?? {};
    L.geoJSON(f, {
      style: () => ({
        fillColor:   style.fillColor,
        fillOpacity: style.fillOpacity,
        color:       style.color,
        weight:      style.weight,
        opacity:     style.opacity,
      }),
      onEachFeature(feat, layer) {
        layer.bindTooltip(
          `${feat.properties.minutes}-min delivery zone`,
          { sticky: true, className: 'order-tooltip' }
        );
      },
    }).addTo(group);
  });
  return group;
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
  // Rebuild lookup table so table-row hover can find map coords by order _id
  state.hitLayerMap = {};
  results.forEach(r => { state.hitLayerMap[r._id] = { lat: r.lat, lon: r.lon }; });

  return L.geoJSON({
    type: 'FeatureCollection',
    features: results.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { ...r.p, normW: r.normW, dist: r.dist, _id: r._id },
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
    tr.dataset.orderId = r._id;
    tr.innerHTML = `
      <td>${r.p.date}</td>
      <td>${r.p.product}</td>
      <td>${r.p.plant_name}</td>
      <td>${r.distToPlant != null ? r.distToPlant.toFixed(1) + ' mi' : '—'}</td>
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

// ── Table-row → map highlight ──────────────────────────
function clearHighlight() {
  if (state.highlightMarker) {
    map.removeLayer(state.highlightMarker);
    state.highlightMarker = null;
  }
}

function highlightOrder(orderId) {
  clearHighlight();
  const pos = state.hitLayerMap[orderId];
  if (!pos) return;
  state.highlightMarker = L.circleMarker([pos.lat, pos.lon], {
    radius: 9, fillColor: 'rgba(255,255,255,0.85)', fillOpacity: 1,
    color: '#e8a020', weight: 2.5, renderer: canvasRenderer,
  }).addTo(map);
}

// ── Render sidebar ─────────────────────────────────────
function renderResults(clickLat, clickLon) {
  if (!state.ordersData) return;
  const result = estimatePrice(clickLat, clickLon, state.ordersData.features, state.radius);

  document.getElementById('results-panel').style.display = 'block';
  document.getElementById('click-hint').style.display    = 'none';

  if (state.hitOrdersLayer) { map.removeLayer(state.hitOrdersLayer); state.hitOrdersLayer = null; }

  if (!result) {
    document.getElementById('est-value').textContent = 'N/A';
    document.getElementById('est-range').textContent = '';
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

  document.getElementById('est-value').textContent = fmt(estimate);
  document.getElementById('est-range').textContent = `(${fmt(lo)} – ${fmt(hi)})`;
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

// ── Plant tooltip ──────────────────────────────────────
function showPlantTooltip(row, plant) {
  // Highlight ring on the map
  if (state.plantHighlightMarker) map.removeLayer(state.plantHighlightMarker);
  const ringColor = plant.owner === 'owned' ? '#e8a020' : '#e05070';
  state.plantHighlightMarker = L.circleMarker([plant.lat, plant.lon], {
    radius: 15, fillOpacity: 0, color: ringColor, weight: 2.5,
    renderer: canvasRenderer,
  }).addTo(map);

  const tip    = document.getElementById('plant-tooltip');
  const owned  = plant.owner === 'owned';
  const label  = owned ? 'Owned' : 'Competitor';

  document.getElementById('pt-name').textContent  = plant.name;
  document.getElementById('pt-name').className     = owned ? 'owned' : '';
  document.getElementById('pt-badge').textContent  = label;
  document.getElementById('pt-badge').className    = owned ? 'owned' : 'competitor';
  document.getElementById('pt-geo').textContent    = plant.geology;
  document.getElementById('pt-products').innerHTML =
    plant.products.map(pr => `<span class="product-chip">${pr}</span>`).join('');

  // Show off-screen first to measure height, then position
  tip.style.display = 'block';
  const tipH    = tip.offsetHeight;
  const sidebar = document.getElementById('sidebar');
  const left    = sidebar.getBoundingClientRect().right + 12;
  const rowRect = row.getBoundingClientRect();
  const top     = Math.min(rowRect.top, window.innerHeight - tipH - 10);
  tip.style.left = left + 'px';
  tip.style.top  = Math.max(10, top) + 'px';
}

function hidePlantTooltip() {
  document.getElementById('plant-tooltip').style.display = 'none';
  if (state.plantHighlightMarker) {
    map.removeLayer(state.plantHighlightMarker);
    state.plantHighlightMarker = null;
  }
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
    container.innerHTML = '<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);padding:6px 0;">No plants within range</div>';
    return;
  }

  plants.forEach(plant => {
    const row = document.createElement('div');
    row.className = 'competitor-row' + (plant.owner === 'owned' ? ' owned-row' : '');
    row.innerHTML = `
      <span class="competitor-name">${plant.name}</span>
      <span class="competitor-dist">${plant.dist.toFixed(1)} mi</span>
    `;
    row.addEventListener('mouseenter', () => showPlantTooltip(row, plant));
    row.addEventListener('mouseleave', hidePlantTooltip);
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
  if (state.driveTimeHighlightMarker) {
    map.removeLayer(state.driveTimeHighlightMarker);
    state.driveTimeHighlightMarker = null;
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

  // Read user-configurable parameters from the sidebar inputs
  const plantCount   = Math.max(1, Math.min(6, parseInt(document.getElementById('dt-plant-count').value)  || 3));
  const overheadMins = Math.max(0,             parseInt(document.getElementById('dt-overhead-min').value) || 0);

  const plants = state.plantsData.features
    .map(f => {
      const [lon, lat] = f.geometry.coordinates;
      return { ...f.properties, lat, lon, dist: haversine(clickLat, clickLon, lat, lon) };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, plantCount);

  state.driveTimeLayerGroup = L.layerGroup().addTo(map);
  const overheadSecs = overheadMins * 60;
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

      const coords   = route.geometry.coordinates.map(([ln, lt]) => [lt, ln]);
      const polyline = L.polyline(coords, { color, weight: 4, opacity: 0.85, lineJoin: 'round' })
        .addTo(state.driveTimeLayerGroup);

      L.circleMarker([plant.lat, plant.lon], {
        radius: 7, fillColor: color, fillOpacity: 1, color: '#fff', weight: 2,
      })
        .bindTooltip(plant.name, { permanent: false })
        .addTo(state.driveTimeLayerGroup);

      routeData.push({ plant, color, oneWaySecs, roadDistMi, roundTripSecs, polyline });
    } catch {
      routeData.push({ plant, color, error: 'Route unavailable' });
    }
  }

  loadingEl.style.display = 'none';
  btn.disabled       = false;
  btn.textContent    = '✕ Clear';
  btn.dataset.active = 'true';

  routeData.forEach((r, i) => {
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

      // Hover: highlight this route, dim the others
      row.addEventListener('mouseenter', () => {
        routeData.forEach((rd, j) => {
          if (!rd.polyline) return;
          rd.polyline.setStyle(j === i
            ? { weight: 7, opacity: 1 }
            : { weight: 4, opacity: 0.15 });
        });
        if (state.driveTimeHighlightMarker) map.removeLayer(state.driveTimeHighlightMarker);
        state.driveTimeHighlightMarker = L.circleMarker([r.plant.lat, r.plant.lon], {
          radius: 13, fillOpacity: 0, color: r.color, weight: 3,
          renderer: canvasRenderer,
        }).addTo(map);
      });

      row.addEventListener('mouseleave', () => {
        routeData.forEach(rd => {
          if (rd.polyline) rd.polyline.setStyle({ weight: 4, opacity: 0.85 });
        });
        if (state.driveTimeHighlightMarker) {
          map.removeLayer(state.driveTimeHighlightMarker);
          state.driveTimeHighlightMarker = null;
        }
      });
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
  const el = document.getElementById('search-results');
  if (el) el.innerHTML = '';
}

async function geocodeAddress() {
  const input = document.getElementById('address-search');
  const query = input.value.trim();
  if (query.length < 3) { closeSearchResults(); return; }

  const center = map.getCenter();
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
    + `?access_token=${CONFIG.mapboxToken}`
    + `&country=US`
    + `&proximity=${center.lng.toFixed(4)},${center.lat.toFixed(4)}`
    + `&limit=6`
    + `&types=address,place,locality,neighborhood,postcode,poi`;

  const resEl = document.getElementById('search-results');
  resEl.innerHTML = '<div class="search-no-results">Searching…</div>';

  try {
    const data = await (await fetch(url)).json();
    resEl.innerHTML = '';
    const features = data.features ?? [];
    if (!features.length) {
      resEl.innerHTML = '<div class="search-no-results">No results found</div>';
      return;
    }
    features.forEach(f => {
      const [lng, lat] = f.center;
      const label      = f.place_name;
      const item       = document.createElement('div');
      item.className   = 'search-result-item';
      item.textContent = label.length > 60 ? label.slice(0, 57) + '…' : label;
      item.title       = label;
      item.addEventListener('click', e => {
        L.DomEvent.stopPropagation(e);
        // Show just the first two components (street + city) in the input
        input.value = label.split(',').slice(0, 2).join(',').trim();
        closeSearchResults();
        map.panTo([lat, lng]);
        selectLocation(lat, lng);
      });
      resEl.appendChild(item);
    });
  } catch {
    resEl.innerHTML = '<div class="search-no-results">Search unavailable</div>';
  }
}

if (CONFIG.enableAddressSearch) {
  let _searchTimer = null;
  const searchInput = document.getElementById('address-search');

  // Real-time suggestions — fire 300 ms after the user stops typing
  searchInput.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    if (searchInput.value.trim().length < 3) { closeSearchResults(); return; }
    _searchTimer = setTimeout(geocodeAddress, 300);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { clearTimeout(_searchTimer); geocodeAddress(); }
    if (e.key === 'Escape') { closeSearchResults(); }
  });

  document.getElementById('address-search-btn').addEventListener('click', () => {
    clearTimeout(_searchTimer);
    geocodeAddress();
  });

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
  const header = ['Date', 'Product', 'Plant', 'Dist. to Plant (mi)', 'Dist. to Point (mi)', 'Volume (T)', 'Base ASP', 'Delivery', 'Total ASP', 'Latitude', 'Longitude'];
  const rows   = sorted.map(r => [
    r.p.date,
    `"${r.p.product}"`,
    `"${r.p.plant_name}"`,
    r.distToPlant != null ? r.distToPlant.toFixed(2) : '',
    r.dist.toFixed(2),
    r.p.volume_tons,
    r.p.asp.toFixed(2),
    r.p.delivery_fee.toFixed(2),
    r.p.total_asp.toFixed(2),
    r.lat.toFixed(6),
    r.lon.toFixed(6),
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

// ── Sidebar collapse ───────────────────────────────────
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  const btn = document.getElementById('sidebar-toggle');
  btn.innerHTML   = collapsed ? '&#9654;' : '&#9664;';
  btn.title       = collapsed ? 'Show sidebar' : 'Hide sidebar';
  // Let the CSS transition finish before Leaflet reflows the map
  setTimeout(() => { map.invalidateSize(); updateMapLabels(); }, 260);
});

// ── Price heatmap toggle ────────────────────────────────
document.getElementById('price-heatmap-toggle-btn').addEventListener('click', () => {
  state.showPriceHeatmap = !state.showPriceHeatmap;
  const btn  = document.getElementById('price-heatmap-toggle-btn');
  const rows = document.getElementById('price-heatmap-legend-rows');
  if (state.showPriceHeatmap) {
    if (state.priceHeatmapLayer) state.priceHeatmapLayer.addTo(map);
    btn.textContent = 'ON';
    btn.classList.add('iso-on');
    rows.classList.remove('iso-hidden');
  } else {
    if (state.priceHeatmapLayer) map.removeLayer(state.priceHeatmapLayer);
    btn.textContent = 'OFF';
    btn.classList.remove('iso-on');
    rows.classList.add('iso-hidden');
  }
});

// ── Heatmap toggle ─────────────────────────────────────
document.getElementById('heatmap-toggle-btn').addEventListener('click', () => {
  state.showHeatmap = !state.showHeatmap;
  const btn  = document.getElementById('heatmap-toggle-btn');
  const rows = document.getElementById('heatmap-legend-rows');
  if (state.showHeatmap) {
    if (state.heatmapLayer) state.heatmapLayer.addTo(map);
    btn.textContent = 'ON';
    btn.classList.add('iso-on');
    rows.classList.remove('iso-hidden');
  } else {
    if (state.heatmapLayer) map.removeLayer(state.heatmapLayer);
    btn.textContent = 'OFF';
    btn.classList.remove('iso-on');
    rows.classList.add('iso-hidden');
  }
});

// ── Isochrone toggle ───────────────────────────────────
document.getElementById('iso-toggle-btn').addEventListener('click', () => {
  state.showIsochrones = !state.showIsochrones;
  const btn  = document.getElementById('iso-toggle-btn');
  const rows = document.getElementById('iso-legend-rows');
  if (state.showIsochrones) {
    if (state.isochroneLayer) state.isochroneLayer.addTo(map);
    btn.textContent = 'ON';
    btn.classList.add('iso-on');
    rows.classList.remove('iso-hidden');
  } else {
    if (state.isochroneLayer) map.removeLayer(state.isochroneLayer);
    btn.textContent = 'OFF';
    btn.classList.remove('iso-on');
    rows.classList.add('iso-hidden');
  }
});

// ── Map labels ─────────────────────────────────────────
function buildPlantLabelLayer(plantsData) {
  const group = L.layerGroup();
  plantsData.features.forEach(f => {
    const [lon, lat] = f.geometry.coordinates;
    L.marker([lat, lon], {
      icon: L.divIcon({
        className:  '',   // empty → no outer styling; Leaflet won't render a visible box
        html:       `<span class="plant-label">${f.properties.name}</span>`,
        iconSize:   [0, 0],
        iconAnchor: [0, 0],
      }),
      interactive:   false,
      zIndexOffset:  2000,
    }).addTo(group);
  });
  return group;
}

function updateOrderLabels() {
  if (state.orderLabelLayer) { map.removeLayer(state.orderLabelLayer); state.orderLabelLayer = null; }
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  if (!collapsed || map.getZoom() < 14 || !state.ordersData) return;

  const bounds = map.getBounds();
  const group  = L.layerGroup();
  state.ordersData.features.forEach(f => {
    const [lon, lat] = f.geometry.coordinates;
    if (!bounds.contains([lat, lon])) return;
    const p = f.properties;
    L.marker([lat, lon], {
      icon: L.divIcon({
        className:  '',   // empty → invisible outer wrapper
        html:       `<div class="order-label">` +
                      `<div class="ol-product">${p.product}</div>` +
                      `<div class="ol-meta">${p.volume_tons.toLocaleString()} T &middot; ${fmt(p.total_asp)}/T</div>` +
                    `</div>`,
        iconSize:   [0, 0],
        iconAnchor: [0, 0],
      }),
      interactive:  false,
      zIndexOffset: 500,
    }).addTo(group);
  });
  state.orderLabelLayer = group.addTo(map);
}

function updateMapLabels() {
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  const zoom      = map.getZoom();

  // Plant labels — zoom 11+
  if (state.plantLabelLayer) {
    if (collapsed && zoom >= 11) {
      if (!map.hasLayer(state.plantLabelLayer)) state.plantLabelLayer.addTo(map);
    } else {
      if (map.hasLayer(state.plantLabelLayer)) map.removeLayer(state.plantLabelLayer);
    }
  }

  // Order labels — zoom 14+ (rebuilt per bounds)
  updateOrderLabels();
}

map.on('zoomend moveend', updateMapLabels);

// ── Orders table row → map highlight ──────────────────
;(function () {
  const tbody = document.getElementById('orders-tbody');
  let lastHighlightedRow = null;

  tbody.addEventListener('mouseover', e => {
    const tr = e.target.closest('tr[data-order-id]');
    if (!tr || tr === lastHighlightedRow) return;
    if (lastHighlightedRow) lastHighlightedRow.classList.remove('row-highlight');
    lastHighlightedRow = tr;
    tr.classList.add('row-highlight');
    highlightOrder(tr.dataset.orderId);
  });

  tbody.addEventListener('mouseout', e => {
    const tr = e.target.closest('tr[data-order-id]');
    if (tr && !tr.contains(e.relatedTarget)) {
      tr.classList.remove('row-highlight');
      lastHighlightedRow = null;
      clearHighlight();
    }
  });
})();

// ── Load data ──────────────────────────────────────────
async function loadData() {
  try {
    const [plantsRes, ordersRes, isoRes] = await Promise.all([
      fetch('plants.geojson'),
      fetch('orders.geojson'),
      fetch('isochrones.geojson'),
    ]);
    state.plantsData = await plantsRes.json();
    state.ordersData = await ordersRes.json();
    const isoData    = await isoRes.json();

    // Price heatmap raster — controlled by CONFIG.enablePriceHeatmap
    const hmBounds = [[47.05, -122.70], [48.00, -121.50]];
    if (CONFIG.enablePriceHeatmap) {
      state.priceHeatmapLayer = L.imageOverlay('price_heatmap.png', hmBounds, {
        opacity: 1, interactive: false, zIndex: 148,
      });
      if (state.showPriceHeatmap) state.priceHeatmapLayer.addTo(map);
    } else {
      document.getElementById('price-heatmap-section').style.display = 'none';
    }

    // Drive-time heatmap raster — hidden by default
    state.heatmapLayer = L.imageOverlay('drivetime_heatmap.png', hmBounds, {
      opacity: 1,          // per-pixel alpha lives inside the PNG itself
      interactive: false,
      zIndex: 150,         // below order dots (z≈200) and plants (z≈1000+)
    });
    if (state.showHeatmap) state.heatmapLayer.addTo(map);

    // Build isochrone layer but don't add to map yet — hidden by default
    state.isochroneLayer = buildIsochroneLayer(isoData.features);
    if (state.showIsochrones) state.isochroneLayer.addTo(map);

    populateProductFilter(state.ordersData.features);

    state.allOrdersLayer  = buildAllOrdersLayer(state.ordersData.features).addTo(map);
    state.plantLabelLayer = buildPlantLabelLayer(state.plantsData);

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
