/**
 * delivery-mode.js
 * AggsData.com — Market Intel Mode
 *
 * Depends on:  config.js   (globals: DELIVERY_CONFIG, Z, GEOLOGY_LABELS,
 *                            PRODUCER_COLORS, getProductColor, geologyKey,
 *                            drawGeologyPath)
 *              map.js       (globals: AggsMarker — optional, used if present)
 *              Leaflet      (global: L)
 *
 * Architecture:
 *  - All intel layers live in a dedicated L.layerGroup (intelLayerGroup)
 *  - Click interaction drops a pin + radius circle into intelClickLayer
 *  - Results render in a fixed right-side sidebar (#intel-sidebar)
 *  - Intel legend is created/destroyed here; index.html is pure glue
 *  - No monkey-patching of map.js globals; ProducersLayer.show/hide() handles that
 *
 * Public API (window.DeliveryMode):
 *   activate(mapInstance)  → Promise<void>
 *   deactivate()
 *   isActive()             → boolean
 */

'use strict';

const DeliveryMode = (() => {

  // ─── Config (from config.js) ──────────────────────────────────────────────

  const CFG = DELIVERY_CONFIG;

  // ─── State ────────────────────────────────────────────────────────────────

  let _map            = null;
  let _active         = false;
  let _activationId   = 0;      // incremented each activate(); guards against race conditions
  let _deliveryData   = null;
  let _plantData      = null;
  let _intelGroup     = null;   // L.layerGroup — delivery dots + plant markers
  let _clickGroup     = null;   // L.layerGroup — pin + radius circle (cleared each click)
  let _legendControl  = null;   // Leaflet control — intel product legend
  let _sidebar        = null;
  let _currentLatLng  = null;
  let _currentRadius  = CFG.deliveryOrders.defaultRadiusMi;
  let _currentProduct = 'all';

  // ─── Math / Formatting ────────────────────────────────────────────────────

  function distanceMi(lat1, lng1, lat2, lng2) {
    const R    = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
        * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
  }

  const miToM   = mi  => mi * 1609.344;
  const fmt$    = n   => n == null ? '—' : '$' + n.toFixed(2);
  const fmtQty  = (n, u) => n == null ? '—'
    : n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + '\u00a0' + (u || 'tons');
  const fmtDate = str => {
    if (!str) return '—';
    const d = new Date(str);
    return isNaN(d) ? str : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  // ─── Data Loading ─────────────────────────────────────────────────────────

  async function loadData() {
    if (_deliveryData && _plantData) return;
    const [dr, pr] = await Promise.all([
      fetch(CFG.deliveryOrders.url),
      fetch(CFG.plants.url),
    ]);
    if (!dr.ok) throw new Error(`Delivery orders fetch failed: ${dr.status} ${dr.statusText}`);
    if (!pr.ok) throw new Error(`Plant locations fetch failed: ${pr.status} ${pr.statusText}`);
    _deliveryData = await dr.json();
    _plantData    = await pr.json();
  }

  // ─── Delivery dot layer ───────────────────────────────────────────────────

  function buildDeliveryLayer(data) {
    const rdr = L.canvas({ padding: 0.5, pane: 'intelPane' });
    return L.geoJSON(data, {
      pointToLayer(feature, latlng) {
        const p = feature.properties;
        return L.circleMarker(latlng, {
          pane:        'intelPane',
          renderer:    rdr,
          radius:      5,
          fillColor:   getProductColor(p.product),  // ← from config.js
          color:       'rgba(0,0,0,0.35)',
          weight:      0.8,
          fillOpacity: 0.75,
        });
      },
      onEachFeature(feature, layer) {
        const p = feature.properties;
        layer.bindTooltip(
          `<strong>${p.product || 'Delivery'}</strong><br>` +
          `ASP: ${fmt$(p.asp)}/ton \u00a0·\u00a0 ${fmtQty(p.quantity, p.quantity_unit)}<br>` +
          `Source: ${p.source_plant || '—'} \u00a0·\u00a0 ${fmtDate(p.delivery_date)}`,
          { className: 'agg-tooltip', sticky: true }
        );
      },
    });
  }

  // ─── Plant marker layer ───────────────────────────────────────────────────

  function buildPlantLayer(data) {
    const useAggsMarker = typeof AggsMarker !== 'undefined';
    const rdr           = L.canvas({ padding: 0.5, pane: 'intelPane' });

    return L.geoJSON(data, {
      pointToLayer(feature, latlng) {
        const p     = feature.properties;
        const geo   = geologyKey(p.geology);   // ← from config.js (single implementation)
        const color = p.is_competitor
          ? '#e41a1c'
          : (PRODUCER_COLORS[p.operator] || '#2a7fc1');

        if (useAggsMarker) {
          return new AggsMarker([latlng.lat, latlng.lng], {
            pane:        'intelPane',
            renderer:    rdr,
            radius:      10,
            fillColor:   color,
            fillOpacity: 0.9,
            geology:     geo,
            selected:    false,
            stroke:      false,
          });
          // AggsMarker._drawAggsMarker calls drawGeologyPath from config.js ↑
        }
        return L.circleMarker(latlng, {
          pane:        'intelPane',
          renderer:    rdr,
          radius:      10,
          fillColor:   color,
          color:       'rgba(0,0,0,0.4)',
          weight:      0.8,
          fillOpacity: 0.9,
        });
      },
      onEachFeature(feature, layer) {
        const p     = feature.properties;
        const label = p.is_competitor ? '⚠ Competitor' : '✦ Own Plant';
        layer.bindTooltip(
          `<strong>${p.name || 'Plant'}</strong><br>` +
          `<em>${label}</em>${p.operator ? ' · ' + p.operator : ''}<br>` +
          `Geology: ${p.geology || '—'}<br>` +
          `Est. Production: ${p.est_production_tpy ? p.est_production_tpy.toLocaleString() + ' TPY' : '—'}<br>` +
          `Products: ${p.products || '—'}`,
          { className: 'agg-tooltip plant-tooltip', sticky: true }
        );
      },
    });
  }

  // ─── Price estimation ─────────────────────────────────────────────────────

  function median(arr) {
    if (!arr.length) return null;
    const s   = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function iqrFilter(arr) {
    if (arr.length < 4) return arr;
    const s   = [...arr].sort((a, b) => a - b);
    const q1  = s[Math.floor(s.length * 0.25)];
    const q3  = s[Math.floor(s.length * 0.75)];
    const iqr = q3 - q1;
    const f   = CFG.deliveryOrders.outlierIqrFactor;
    return arr.filter(v => v >= q1 - f * iqr && v <= q3 + f * iqr);
  }

  function estimatePrice(clickLat, clickLng, productFilter, radiusMi) {
    if (!_deliveryData) {
      return { medianAsp: null, low: null, high: null, orders: [], competitors: [], sampleSize: 0 };
    }

    const nearby = _deliveryData.features.filter(f => {
      const [lng, lat] = f.geometry.coordinates;
      const dist = distanceMi(clickLat, clickLng, lat, lng);
      f._dist = dist;
      if (dist > radiusMi) return false;
      if (productFilter && productFilter !== 'all') {
        return (f.properties.product || '').toLowerCase().includes(productFilter.toLowerCase());
      }
      return true;
    });

    const asps     = nearby.map(f => f.properties.asp).filter(v => v != null && v > 0);
    const filtered = iqrFilter(asps);
    const med      = median(filtered);
    const band     = CFG.priceRange.pctBand;

    // Store _dist on competitor features here so renderSidebarResults doesn't
    // have to recalculate it (bug fix: previously called distanceMi twice).
    const competitors = (_plantData?.features || []).filter(f => {
      if (!f.properties.is_competitor) return false;
      const [lng, lat] = f.geometry.coordinates;
      const dist = distanceMi(clickLat, clickLng, lat, lng);
      f._dist = dist;
      return dist <= CFG.plants.competitorRadiusMi;
    });

    return {
      medianAsp:  med,
      low:        med != null ? med * (1 - band) : null,
      high:       med != null ? med * (1 + band) : null,
      orders:     nearby.sort((a, b) => a._dist - b._dist).slice(0, 12),
      competitors: competitors.sort((a, b) => a._dist - b._dist),
      sampleSize: filtered.length,
    };
  }

  function getProductList() {
    if (!_deliveryData) return [];
    return [...new Set(_deliveryData.features.map(f => f.properties.product).filter(Boolean))].sort();
  }

  // ─── Click marker + radius circle ────────────────────────────────────────

  function placeClickGraphics(latlng, radiusMi) {
    _clickGroup.clearLayers();

    L.circle(latlng, {
      pane:        'intelPane',
      radius:      miToM(radiusMi),
      color:       '#4a9eda',
      weight:      1.5,
      dashArray:   '6 5',
      fillColor:   '#4a9eda',
      fillOpacity: 0.07,
      interactive: false,
    }).addTo(_clickGroup);

    L.circleMarker(latlng, {
      pane:        'intelPane',
      radius:      7,
      fillColor:   '#ffffff',
      color:       '#4a9eda',
      weight:      2.5,
      fillOpacity: 1,
      interactive: false,
    }).addTo(_clickGroup);
  }

  // ─── Intel legend (owned by this module) ─────────────────────────────────

  function buildIntelLegend() {
    const ctrl = L.control({ position: 'bottomright' });
    ctrl.onAdd = () => {
      const el = L.DomUtil.create('div', 'intel-legend');
      el.innerHTML =
        '<div class="intel-legend-title">Product Type</div>' +
        '<div class="intel-legend-row"><div class="legend-dot" style="background:#e8a44a;border-color:#e8a44a"></div>Limestone / Dense Grade</div>' +
        '<div class="intel-legend-row"><div class="legend-dot" style="background:#7a6fa0;border-color:#7a6fa0"></div>Granite / Hard Rock</div>' +
        '<div class="intel-legend-row"><div class="legend-dot" style="background:#6baa75;border-color:#6baa75"></div>Sand &amp; Gravel</div>' +
        '<div class="intel-legend-row"><div class="legend-dot" style="background:#5b9cba;border-color:#5b9cba"></div>Recycled (RCA/RAP)</div>' +
        '<div class="intel-legend-row"><div class="legend-dot" style="background:#c26060;border-color:#c26060"></div>Basalt / Quartzite</div>' +
        '<div style="height:1px;background:rgba(255,255,255,0.1);margin:8px 0"></div>' +
        '<div class="intel-legend-row"><span style="color:#2a7fc1;font-size:11px;width:14px;text-align:center">▲</span>Own Plant</div>' +
        '<div class="intel-legend-row"><span style="color:#e41a1c;font-size:11px;width:14px;text-align:center">▲</span>Competitor Plant</div>';
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      return el;
    };
    return ctrl;
  }

  // ─── Sidebar ──────────────────────────────────────────────────────────────

  function createSidebar() {
    const el = document.createElement('div');
    el.id = 'intel-sidebar';
    el.innerHTML = `
      <div class="isb-header">
        <span class="isb-title">Market Intel</span>
        <button class="isb-close" id="isb-close-btn" title="Close">✕</button>
      </div>
      <div class="isb-body" id="isb-body"></div>
    `;
    document.body.appendChild(el);
    document.getElementById('isb-close-btn').addEventListener('click', closeSidebar);
    renderSidebarEmpty();
    return el;
  }

  function openSidebar()  { _sidebar?.classList.add('isb-open'); }
  function closeSidebar() {
    _sidebar?.classList.remove('isb-open');
    _clickGroup?.clearLayers();
    _currentLatLng = null;
  }

  function renderSidebarEmpty() {
    const body = document.getElementById('isb-body');
    if (!body) return;
    body.innerHTML = `
      <div class="isb-empty">
        <div class="isb-empty-icon">📍</div>
        <div class="isb-empty-text">Click anywhere on the map to estimate a delivered price.</div>
      </div>
    `;
  }

  function renderSidebarResults(latlng, radiusMi, productFilter) {
    const body = document.getElementById('isb-body');
    if (!body) return;

    const { medianAsp, low, high, orders, competitors, sampleSize } =
      estimatePrice(latlng.lat, latlng.lng, productFilter, radiusMi);

    const noData   = medianAsp == null;
    const coordStr = `${latlng.lat.toFixed(4)}°N, ${Math.abs(latlng.lng).toFixed(4)}°W`;
    const products = getProductList();

    const radiusOpts = [5, 10, 15, 25, 35, 50, 75, 100]
      .map(r => `<option value="${r}" ${r === radiusMi ? 'selected' : ''}>${r} mi</option>`)
      .join('');

    const productOpts = products
      .map(prod => `<option value="${prod}" ${productFilter === prod ? 'selected' : ''}>${prod}</option>`)
      .join('');

    const priceBlock = noData
      ? `<div class="isb-no-data">
           No delivery records within <strong>${radiusMi} mi</strong>
           ${productFilter !== 'all' ? `for <em>${productFilter}</em>` : ''}.
           <br>Try expanding the radius or changing the product filter.
         </div>`
      : `<div class="isb-price-block">
           <div class="isb-price-label">Estimated Delivered Price</div>
           <div class="isb-price-range">
             <span class="isb-price-val">${fmt$(low)}</span>
             <span class="isb-price-sep">–</span>
             <span class="isb-price-val">${fmt$(high)}</span>
             <span class="isb-price-unit">/ton</span>
           </div>
           <div class="isb-price-meta">
             Median <strong>${fmt$(medianAsp)}/ton</strong>
             &nbsp;·&nbsp; <strong>${sampleSize}</strong> order${sampleSize !== 1 ? 's' : ''} in sample
           </div>
         </div>`;

    const orderRows = orders.length
      ? orders.map(f => {
          const p = f.properties;
          return `<tr>
            <td><span class="isb-dot" style="background:${getProductColor(p.product)}"></span>${p.product || '—'}</td>
            <td class="isb-num">${fmt$(p.asp)}</td>
            <td class="isb-num">${fmtQty(p.quantity, p.quantity_unit)}</td>
            <td>${p.source_plant || '—'}</td>
            <td class="isb-num">${f._dist != null ? f._dist.toFixed(1) + ' mi' : '—'}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="5" class="isb-table-empty">No orders in range.</td></tr>`;

    // _dist is now pre-computed in estimatePrice (no second distanceMi call)
    const compRows = competitors.length
      ? competitors.map(f => {
          const p = f.properties;
          return `<tr>
            <td>${p.name || '—'}</td>
            <td>${p.operator || '—'}</td>
            <td>${p.geology || '—'}</td>
            <td class="isb-num">${f._dist.toFixed(1)} mi</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="4" class="isb-table-empty">None within ${CFG.plants.competitorRadiusMi} mi.</td></tr>`;

    body.innerHTML = `
      <div class="isb-coord">${coordStr}</div>

      ${priceBlock}

      <div class="isb-filters">
        <div class="isb-filter-row">
          <label class="isb-filter-label" for="isb-radius">Radius</label>
          <select class="isb-select" id="isb-radius">${radiusOpts}</select>
        </div>
        <div class="isb-filter-row">
          <label class="isb-filter-label" for="isb-product">Product</label>
          <select class="isb-select" id="isb-product">
            <option value="all" ${productFilter === 'all' ? 'selected' : ''}>All Products</option>
            ${productOpts}
          </select>
        </div>
      </div>

      <div class="isb-section">
        <div class="isb-section-title">
          Nearby Orders
          <span class="isb-section-sub">within ${radiusMi} mi · closest 12</span>
        </div>
        <div class="isb-table-wrap">
          <table class="isb-table">
            <thead><tr>
              <th>Product</th><th>ASP</th><th>Quantity</th><th>Plant</th><th>Dist</th>
            </tr></thead>
            <tbody>${orderRows}</tbody>
          </table>
        </div>
      </div>

      <div class="isb-section">
        <div class="isb-section-title">
          Nearby Competitors
          <span class="isb-section-sub">within ${CFG.plants.competitorRadiusMi} mi</span>
        </div>
        <div class="isb-table-wrap">
          <table class="isb-table">
            <thead><tr>
              <th>Plant</th><th>Operator</th><th>Geology</th><th>Dist</th>
            </tr></thead>
            <tbody>${compRows}</tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('isb-radius').addEventListener('change', function() {
      _currentRadius = parseInt(this.value, 10);
      placeClickGraphics(_currentLatLng, _currentRadius);
      renderSidebarResults(_currentLatLng, _currentRadius, _currentProduct);
    });

    document.getElementById('isb-product').addEventListener('change', function() {
      _currentProduct = this.value;
      renderSidebarResults(_currentLatLng, _currentRadius, _currentProduct);
    });
  }

  // ─── Map click handler ────────────────────────────────────────────────────

  function onMapClick(e) {
    if (!_active) return;
    _currentLatLng = e.latlng;
    placeClickGraphics(e.latlng, _currentRadius);
    openSidebar();
    renderSidebarResults(e.latlng, _currentRadius, _currentProduct);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async function activate(mapInstance) {
    if (_active) return;
    _map    = mapInstance;
    _active = true;

    // Stamp this activation attempt. If deactivate() is called while we are
    // awaiting data, the stamp will have been incremented and we bail out
    // before registering any event listeners or touching the map.
    const myId = ++_activationId;

    const btn = document.getElementById('mode-btn-intel');
    btn?.classList.add('loading');

    if (!_map.getPane('intelPane')) {
      _map.createPane('intelPane');
      _map.getPane('intelPane').style.zIndex = Z.intelPane;
    }

    try {
      await loadData();
    } catch (err) {
      console.error('[DeliveryMode] Data load failed:', err);
      if (myId === _activationId) {
        alert('Could not load Market Intel data.\n\n' + err.message);
        _active = false;
      }
      btn?.classList.remove('loading');
      return;
    }

    if (myId !== _activationId || !_active) {
      btn?.classList.remove('loading');
      console.log('[DeliveryMode] Activation aborted (deactivated during data load).');
      return;
    }

    _intelGroup = L.layerGroup().addTo(_map);
    _clickGroup = L.layerGroup().addTo(_map);

    buildDeliveryLayer(_deliveryData).addTo(_intelGroup);
    buildPlantLayer(_plantData).addTo(_intelGroup);

    if (!_sidebar) _sidebar = createSidebar();
    else renderSidebarEmpty();

    // Legend is owned by this module — add it here, remove in deactivate()
    _legendControl = buildIntelLegend();
    _legendControl.addTo(_map);

    openSidebar();

    _map.on('click', onMapClick);
    _map.getContainer().classList.add('intel-cursor');

    btn?.classList.remove('loading');
    console.log('[DeliveryMode] Activated.');
  }

  function deactivate() {
    if (!_active || !_map) return;
    _active = false;
    _activationId++;

    _map.off('click', onMapClick);
    _map.getContainer().classList.remove('intel-cursor');

    if (_intelGroup)    { _map.removeLayer(_intelGroup); _intelGroup = null; }
    if (_clickGroup)    { _map.removeLayer(_clickGroup); _clickGroup = null; }
    if (_legendControl) { _map.removeControl(_legendControl); _legendControl = null; }

    closeSidebar();
    _currentLatLng  = null;
    _currentRadius  = CFG.deliveryOrders.defaultRadiusMi;
    _currentProduct = 'all';

    console.log('[DeliveryMode] Deactivated.');
  }

  function isActive() { return _active; }

  return { activate, deactivate, isActive };

})();

window.DeliveryMode = DeliveryMode;
