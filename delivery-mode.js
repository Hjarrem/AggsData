/**
 * delivery-mode.js
 * AggsData.com — Market Intel Mode
 *
 * Architecture:
 *  - All intel layers live in a dedicated L.layerGroup (intelLayerGroup)
 *  - Click interaction drops a pin + radius circle into intelClickLayer
 *  - Results render in a fixed right-side sidebar (#intel-sidebar), not a popup
 *  - No monkey-patching of map.js globals; ProducersLayer.show/hide() handles that
 */

'use strict';

const DeliveryMode = (() => {

  // ─── Config ───────────────────────────────────────────────────────────────

  const CONFIG = {
    deliveryOrders: {
      url:              'delivery-orders.geojson',
      defaultRadiusMi:  15,
      outlierIqrFactor: 1.5,
    },
    plants: {
      url:               'aggregate-plants.geojson',
      competitorRadiusMi: 35,
    },
    priceRange: {
      pctBand: 0.10,
    },
  };

  // ─── State ────────────────────────────────────────────────────────────────

  let _map            = null;
  let _active         = false;
  let _deliveryData   = null;
  let _plantData      = null;
  let _intelGroup     = null;   // L.layerGroup for delivery dots + plant markers
  let _clickGroup     = null;   // L.layerGroup for the pin + radius circle (cleared each click)
  let _currentLatLng  = null;
  let _currentRadius  = CONFIG.deliveryOrders.defaultRadiusMi;
  let _currentProduct = 'all';
  let _sidebar        = null;

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

  // miles → meters for L.circle radius
  const miToM = mi => mi * 1609.344;

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
    return arr.filter(v =>
      v >= q1 - CONFIG.deliveryOrders.outlierIqrFactor * iqr &&
      v <= q3 + CONFIG.deliveryOrders.outlierIqrFactor * iqr
    );
  }

  const fmt$   = n  => n == null ? '—' : '$' + n.toFixed(2);
  const fmtQty = (n, u) => n == null ? '—'
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
      fetch(CONFIG.deliveryOrders.url),
      fetch(CONFIG.plants.url),
    ]);
    if (!dr.ok) throw new Error(`Delivery orders fetch failed: ${dr.status} ${dr.statusText}`);
    if (!pr.ok) throw new Error(`Plant locations fetch failed: ${pr.status} ${pr.statusText}`);
    _deliveryData = await dr.json();
    _plantData    = await pr.json();
  }

  // ─── Product color (matches legend) ───────────────────────────────────────

  function productColor(product) {
    const p = (product || '').toLowerCase();
    if (p.includes('limestone') || p.includes('calcite') || p.includes('dense grade') ||
        p.includes('dga') || p.includes('ag lime') || p.includes('screening')) return '#e8a44a';
    if (p.includes('granite') || p.includes('hard rock') || p.includes('trap') ||
        p.includes('ballast') || p.includes('rip rap'))                          return '#7a6fa0';
    if (p.includes('sand') || p.includes('gravel'))                              return '#6baa75';
    if (p.includes('recycled') || p.includes('rca') || p.includes('rap'))        return '#5b9cba';
    if (p.includes('basalt') || p.includes('quartzite'))                         return '#c26060';
    return '#aaa';
  }

  // ─── Delivery dot layer ───────────────────────────────────────────────────

  function buildDeliveryLayer(data) {
    return L.geoJSON(data, {
      pointToLayer(feature, latlng) {
        const p = feature.properties;
        return L.circleMarker(latlng, {
          radius:      5,
          fillColor:   productColor(p.product),
          color:       'rgba(0,0,0,0.35)',
          weight:      0.8,
          fillOpacity: 0.75,
        });
      },
      onEachFeature(feature, layer) {
        const p = feature.properties;
        layer.bindTooltip(
          `<strong>${p.product || 'Delivery'}</strong><br>` +
          `ASP: ${fmt$(p.asp)}/ton &nbsp;·&nbsp; ${fmtQty(p.quantity, p.quantity_unit)}<br>` +
          `Source: ${p.source_plant || '—'} &nbsp;·&nbsp; ${fmtDate(p.delivery_date)}`,
          { className: 'agg-tooltip', sticky: true }
        );
      },
    });
  }

  // ─── Plant marker layer ───────────────────────────────────────────────────

  function geologyKey(geologyStr) {
    const g = (geologyStr || '').toLowerCase();
    if (g.includes('sand') || g.includes('gravel'))                                          return 'sand_gravel';
    if (g.includes('granite') || g.includes('basalt') || g.includes('trap') ||
        g.includes('quartzite') || g.includes('hard'))                                       return 'hard_rock';
    return 'limestone';
  }

  function buildPlantLayer(data) {
    const useAggsMarker = typeof AggsMarker !== 'undefined';

    return L.geoJSON(data, {
      pointToLayer(feature, latlng) {
        const p     = feature.properties;
        const geo   = geologyKey(p.geology);
        const color = p.is_competitor
          ? '#e41a1c'
          : (window.PRODUCER_COLORS && PRODUCER_COLORS[p.operator]) || '#2a7fc1';

        if (useAggsMarker) {
          return new AggsMarker([latlng.lat, latlng.lng], {
            radius:      10,
            fillColor:   color,
            fillOpacity: 0.9,
            geology:     geo,
            selected:    false,
            stroke:      false,
          });
        }
        return L.circleMarker(latlng, {
          radius: 10, fillColor: color,
          color: 'rgba(0,0,0,0.4)', weight: 0.8, fillOpacity: 0.9,
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
    const band     = CONFIG.priceRange.pctBand;

    const competitors = (_plantData?.features || []).filter(f => {
      if (!f.properties.is_competitor) return false;
      const [lng, lat] = f.geometry.coordinates;
      return distanceMi(clickLat, clickLng, lat, lng) <= CONFIG.plants.competitorRadiusMi;
    });

    return {
      medianAsp:  med,
      low:        med != null ? med * (1 - band) : null,
      high:       med != null ? med * (1 + band) : null,
      orders:     nearby.sort((a, b) => a._dist - b._dist).slice(0, 12),
      competitors,
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

    // Radius circle — semi-transparent fill, dashed stroke
    L.circle(latlng, {
      radius:      miToM(radiusMi),
      color:       '#4a9eda',
      weight:      1.5,
      dashArray:   '6 5',
      fillColor:   '#4a9eda',
      fillOpacity: 0.07,
      interactive: false,
    }).addTo(_clickGroup);

    // Pin marker
    L.circleMarker(latlng, {
      radius:      7,
      fillColor:   '#ffffff',
      color:       '#4a9eda',
      weight:      2.5,
      fillOpacity: 1,
      interactive: false,
    }).addTo(_clickGroup);
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
      <div class="isb-body" id="isb-body">
        <div class="isb-empty">
          <div class="isb-empty-icon">📍</div>
          <div class="isb-empty-text">Click anywhere on the map to estimate a delivered price.</div>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    document.getElementById('isb-close-btn').addEventListener('click', () => {
      closeSidebar();
    });

    return el;
  }

  function openSidebar() {
    if (_sidebar) _sidebar.classList.add('isb-open');
  }

  function closeSidebar() {
    if (_sidebar) _sidebar.classList.remove('isb-open');
    _clickGroup && _clickGroup.clearLayers();
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

    const result    = estimatePrice(latlng.lat, latlng.lng, productFilter, radiusMi);
    const { medianAsp, low, high, orders, competitors, sampleSize } = result;
    const noData    = medianAsp == null;
    const coordStr  = `${latlng.lat.toFixed(4)}°N, ${Math.abs(latlng.lng).toFixed(4)}°W`;
    const products  = getProductList();

    const radiusOpts = [5, 10, 15, 25, 35, 50, 75, 100].map(r =>
      `<option value="${r}" ${r === radiusMi ? 'selected' : ''}>${r} mi</option>`
    ).join('');

    const productOpts = products.map(prod =>
      `<option value="${prod}" ${productFilter === prod ? 'selected' : ''}>${prod}</option>`
    ).join('');

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
          const dotColor = productColor(p.product);
          return `<tr>
            <td><span class="isb-dot" style="background:${dotColor}"></span>${p.product || '—'}</td>
            <td class="isb-num">${fmt$(p.asp)}</td>
            <td class="isb-num">${fmtQty(p.quantity, p.quantity_unit)}</td>
            <td>${p.source_plant || '—'}</td>
            <td class="isb-num">${f._dist != null ? f._dist.toFixed(1) + ' mi' : '—'}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="5" class="isb-table-empty">No orders in range.</td></tr>`;

    const compRows = competitors.length
      ? competitors.map(f => {
          const p = f.properties;
          const [lng, lat] = f.geometry.coordinates;
          const dist = distanceMi(latlng.lat, latlng.lng, lat, lng);
          return `<tr>
            <td>${p.name || '—'}</td>
            <td>${p.operator || '—'}</td>
            <td>${p.geology || '—'}</td>
            <td class="isb-num">${dist.toFixed(1)} mi</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="4" class="isb-table-empty">None within ${CONFIG.plants.competitorRadiusMi} mi.</td></tr>`;

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
          <span class="isb-section-sub">within ${CONFIG.plants.competitorRadiusMi} mi</span>
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

    // Wire up filter controls — they update state and re-render
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

    const btn = document.getElementById('mode-btn-intel');
    if (btn) btn.classList.add('loading');

    // Dedicated pane for intel layers — sits above tile layer, below UI
    if (!_map.getPane('intelPane')) {
      _map.createPane('intelPane');
      _map.getPane('intelPane').style.zIndex = 450;
    }

    try {
      await loadData();
    } catch (err) {
      console.error('[DeliveryMode] Data load failed:', err);
      alert('Could not load Market Intel data.\n\n' + err.message);
      _active = false;
      if (btn) btn.classList.remove('loading');
      return;
    }

    // Layer groups
    _intelGroup = L.layerGroup().addTo(_map);
    _clickGroup = L.layerGroup().addTo(_map);

    buildDeliveryLayer(_deliveryData).addTo(_intelGroup);
    buildPlantLayer(_plantData).addTo(_intelGroup);

    // Sidebar
    if (!_sidebar) {
      _sidebar = createSidebar();
    }
    renderSidebarEmpty();
    openSidebar();

    _map.on('click', onMapClick);
    _map.getContainer().classList.add('intel-cursor');

    if (btn) btn.classList.remove('loading');
    console.log('[DeliveryMode] Activated.');
  }

  function deactivate() {
    if (!_active || !_map) return;
    _active = false;

    _map.off('click', onMapClick);
    _map.getContainer().classList.remove('intel-cursor');

    if (_intelGroup) { _map.removeLayer(_intelGroup); _intelGroup = null; }
    if (_clickGroup) { _map.removeLayer(_clickGroup); _clickGroup = null; }

    closeSidebar();
    _currentLatLng  = null;
    _currentRadius  = CONFIG.deliveryOrders.defaultRadiusMi;
    _currentProduct = 'all';

    console.log('[DeliveryMode] Deactivated.');
  }

  function isActive() { return _active; }

  return { activate, deactivate, isActive };

})();

window.DeliveryMode = DeliveryMode;
