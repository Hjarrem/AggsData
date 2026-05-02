/**
 * delivery-mode.js
 * AggsData.com — Market Intel Mode
 *
 * Manages the "Market Intel" map mode which overlays:
 *   1. Aggregate delivery order points (product, qty, ASP, time, source)
 *   2. Aggregate plant locations (geology, production, products)
 *   3. A click-to-estimate delivered price tool
 *
 * Dependencies: Leaflet (already loaded by aggsdata), turf.js (see index-patch.html)
 */

'use strict';

const DeliveryMode = (() => {

  // ─── Config ───────────────────────────────────────────────────────────────

  const CONFIG = {
    deliveryOrders: {
      url: 'data/delivery-orders.geojson',   // adjust path as needed
      searchRadiusMi: 25,                    // default radius for price estimate
      outlierIqrFactor: 1.5,                 // IQR fence for outlier removal
    },
    plants: {
      url: 'data/aggregate-plants.geojson',
      competitorRadiusMi: 35,
    },
    priceRange: {
      pctBand: 0.10,   // ±10% display band around median estimated price
    },
  };

  // ─── State ────────────────────────────────────────────────────────────────

  let _map = null;
  let _deliveryLayer = null;
  let _plantLayer = null;
  let _selectionMarker = null;
  let _active = false;
  let _deliveryData = null;  // cached GeoJSON FeatureCollection
  let _plantData = null;

  // ─── Unit Helpers ─────────────────────────────────────────────────────────

  /**
   * Haversine distance in miles between two [lat, lng] pairs.
   */
  function distanceMi(lat1, lng1, lat2, lng2) {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
        * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function iqrFilter(arr) {
    if (arr.length < 4) return arr;
    const s = [...arr].sort((a, b) => a - b);
    const q1 = s[Math.floor(s.length * 0.25)];
    const q3 = s[Math.floor(s.length * 0.75)];
    const iqr = q3 - q1;
    const lo = q1 - CONFIG.deliveryOrders.outlierIqrFactor * iqr;
    const hi = q3 + CONFIG.deliveryOrders.outlierIqrFactor * iqr;
    return arr.filter(v => v >= lo && v <= hi);
  }

  function fmt$(n) {
    return n == null ? '—' : '$' + n.toFixed(2);
  }

  function fmtQty(n, unit) {
    if (n == null) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + (unit || 'tons');
  }

  function fmtDate(str) {
    if (!str) return '—';
    const d = new Date(str);
    return isNaN(d) ? str : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // ─── Data Loading ─────────────────────────────────────────────────────────

  async function loadData() {
    if (_deliveryData && _plantData) return; // already cached

    const [deliveryResp, plantResp] = await Promise.all([
      fetch(CONFIG.deliveryOrders.url),
      fetch(CONFIG.plants.url),
    ]);

    if (!deliveryResp.ok) throw new Error(`Failed to load delivery orders: ${deliveryResp.statusText}`);
    if (!plantResp.ok)   throw new Error(`Failed to load plant locations: ${plantResp.statusText}`);

    _deliveryData = await deliveryResp.json();
    _plantData    = await plantResp.json();
  }

  // ─── Delivery Orders Layer ────────────────────────────────────────────────

  /**
   * Delivery order GeoJSON feature properties expected:
   *   product        {string}  e.g. "Crushed Limestone #57"
   *   quantity       {number}  tons (or unit below)
   *   quantity_unit  {string}  default "tons"
   *   asp            {number}  average selling price $/ton delivered
   *   delivery_date  {string}  ISO date
   *   source_plant   {string}  plant name / ID
   *   customer       {string}  optional, anonymized
   *   haul_dist_mi   {number}  optional
   */
  function productColor(product) {
    const p = (product || '').toLowerCase();
    if (p.includes('limestone') || p.includes('calcite')) return '#e8a44a';
    if (p.includes('granite') || p.includes('hard rock') || p.includes('trap')) return '#7a6fa0';
    if (p.includes('sand') || p.includes('gravel')) return '#6baa75';
    if (p.includes('recycled') || p.includes('rca') || p.includes('rap')) return '#5b9cba';
    if (p.includes('basalt') || p.includes('quartzite')) return '#c26060';
    return '#888';
  }

  function buildDeliveryLayer(data) {
    return L.geoJSON(data, {
      pointToLayer(feature, latlng) {
        const p = feature.properties;
        const color = productColor(p.product);
        return L.circleMarker(latlng, {
          radius: 5,
          fillColor: color,
          color: '#fff',
          weight: 1,
          fillOpacity: 0.82,
          className: 'delivery-point',
        });
      },
      onEachFeature(feature, layer) {
        const p = feature.properties;
        layer.bindTooltip(
          `<strong>${p.product || 'Delivery'}</strong><br>
           ASP: ${fmt$(p.asp)}/ton<br>
           Qty: ${fmtQty(p.quantity, p.quantity_unit)}<br>
           Source: ${p.source_plant || '—'}`,
          { className: 'agg-tooltip', sticky: true }
        );
      },
    });
  }

  // ─── Plant Layer ──────────────────────────────────────────────────────────

  /**
   * Plant GeoJSON feature properties expected:
   *   name               {string}
   *   operator           {string}
   *   geology            {string}  e.g. "Limestone", "Granite"
   *   est_production_tpy {number}  estimated tons/year
   *   products           {string}  comma-separated product list
   *   active             {boolean}
   *   is_competitor      {boolean} flag for competitor distinction
   */
  function buildPlantLayer(data) {
    return L.geoJSON(data, {
      pointToLayer(feature, latlng) {
        const p = feature.properties;
        const color = p.is_competitor ? '#e05555' : '#2a7fc1';
        const icon = L.divIcon({
          className: '',
          html: `<div class="plant-marker ${p.is_competitor ? 'competitor' : 'own'}" 
                      style="border-color:${color}" 
                      title="${p.name || ''}">
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="${color}">
                     <polygon points="12,2 22,22 2,22"/>
                   </svg>
                 </div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        return L.marker(latlng, { icon });
      },
      onEachFeature(feature, layer) {
        const p = feature.properties;
        layer.bindTooltip(
          `<strong>${p.name || 'Plant'}</strong><br>
           ${p.operator ? `<em>${p.operator}</em><br>` : ''}
           Geology: ${p.geology || '—'}<br>
           Est. Production: ${p.est_production_tpy ? p.est_production_tpy.toLocaleString() + ' TPY' : '—'}<br>
           Products: ${p.products || '—'}`,
          { className: 'agg-tooltip plant-tooltip', sticky: true }
        );
      },
    });
  }

  // ─── Price Estimator Core ─────────────────────────────────────────────────

  /**
   * Given a clicked lat/lng and optional product filter, returns:
   *   { medianAsp, low, high, orders, competitors, sampleSize }
   */
  function estimateDeliveredPrice(clickLat, clickLng, productFilter, radiusMi) {
    if (!_deliveryData) return null;
    const radius = radiusMi || CONFIG.deliveryOrders.searchRadiusMi;

    // Filter deliveries within radius
    const nearby = _deliveryData.features.filter(f => {
      const [lng, lat] = f.geometry.coordinates;
      const dist = distanceMi(clickLat, clickLng, lat, lng);
      f._dist = dist; // cache for display
      if (dist > radius) return false;
      if (productFilter && productFilter !== 'all') {
        return (f.properties.product || '').toLowerCase()
          .includes(productFilter.toLowerCase());
      }
      return true;
    });

    if (!nearby.length) return { medianAsp: null, low: null, high: null, orders: [], competitors: [], sampleSize: 0 };

    const asps = nearby.map(f => f.properties.asp).filter(v => v != null && v > 0);
    const filtered = iqrFilter(asps);
    const med = median(filtered);

    const band = CONFIG.priceRange.pctBand;

    // Nearby competitors
    const compRadius = CONFIG.plants.competitorRadiusMi;
    const competitors = (_plantData?.features || []).filter(f => {
      if (!f.properties.is_competitor) return false;
      const [lng, lat] = f.geometry.coordinates;
      return distanceMi(clickLat, clickLng, lat, lng) <= compRadius;
    });

    return {
      medianAsp: med,
      low:  med != null ? med * (1 - band) : null,
      high: med != null ? med * (1 + band) : null,
      orders: nearby.sort((a, b) => a._dist - b._dist).slice(0, 10),
      competitors,
      sampleSize: filtered.length,
    };
  }

  // ─── Popup HTML Builder ───────────────────────────────────────────────────

  function buildPopupHTML(result, clickLat, clickLng, productFilter, radiusMi) {
    const { medianAsp, low, high, orders, competitors, sampleSize } = result;

    const coordStr = `${clickLat.toFixed(4)}°N, ${Math.abs(clickLng).toFixed(4)}°W`;
    const noData = medianAsp == null;

    // Order rows
    const orderRows = orders.map(f => {
      const p = f.properties;
      return `<tr>
        <td>${p.product || '—'}</td>
        <td>${fmt$(p.asp)}</td>
        <td>${fmtQty(p.quantity, p.quantity_unit)}</td>
        <td>${p.source_plant || '—'}</td>
        <td>${fmtDate(p.delivery_date)}</td>
        <td>${f._dist != null ? f._dist.toFixed(1) + ' mi' : '—'}</td>
      </tr>`;
    }).join('');

    // Competitor rows
    const compRows = competitors.length
      ? competitors.map(f => {
          const p = f.properties;
          const [lng, lat] = f.geometry.coordinates;
          const dist = distanceMi(clickLat, clickLng, lat, lng);
          return `<tr>
            <td>${p.name || '—'}</td>
            <td>${p.operator || '—'}</td>
            <td>${p.geology || '—'}</td>
            <td>${p.products || '—'}</td>
            <td>${dist.toFixed(1)} mi</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="5" class="popup-empty">No competitors found within ${CONFIG.plants.competitorRadiusMi} mi</td></tr>`;

    return `
      <div class="price-popup">
        <div class="popup-header">
          <div class="popup-title">Delivered Price Estimate</div>
          <div class="popup-coord">${coordStr}</div>
        </div>

        ${noData
          ? `<div class="popup-no-data">
               No delivery records found within <strong>${radiusMi || CONFIG.deliveryOrders.searchRadiusMi} mi</strong>
               ${productFilter && productFilter !== 'all' ? ` for <em>${productFilter}</em>` : ''}.
               <br>Try expanding the radius or changing the product filter.
             </div>`
          : `<div class="popup-price-block">
               <div class="price-label">Estimated Delivered Price</div>
               <div class="price-range">
                 <span class="price-low">${fmt$(low)}</span>
                 <span class="price-sep">–</span>
                 <span class="price-high">${fmt$(high)}</span>
                 <span class="price-unit">/ton</span>
               </div>
               <div class="price-meta">
                 Median: <strong>${fmt$(medianAsp)}/ton</strong> &nbsp;·&nbsp;
                 Based on <strong>${sampleSize}</strong> order${sampleSize !== 1 ? 's' : ''}
                 ${productFilter && productFilter !== 'all' ? ` · Product: <em>${productFilter}</em>` : ''}
               </div>
             </div>`
        }

        <div class="popup-section">
          <div class="popup-section-title">
            Nearby Delivery Orders 
            <span class="popup-section-sub">(within ${radiusMi || CONFIG.deliveryOrders.searchRadiusMi} mi, closest 10)</span>
          </div>
          ${orders.length
            ? `<div class="popup-table-wrap">
                 <table class="popup-table">
                   <thead>
                     <tr>
                       <th>Product</th>
                       <th>ASP</th>
                       <th>Quantity</th>
                       <th>Source Plant</th>
                       <th>Date</th>
                       <th>Distance</th>
                     </tr>
                   </thead>
                   <tbody>${orderRows}</tbody>
                 </table>
               </div>`
            : `<div class="popup-empty">No orders in range.</div>`
          }
        </div>

        <div class="popup-section">
          <div class="popup-section-title">
            Nearby Competitors
            <span class="popup-section-sub">(within ${CONFIG.plants.competitorRadiusMi} mi)</span>
          </div>
          <div class="popup-table-wrap">
            <table class="popup-table">
              <thead>
                <tr>
                  <th>Plant</th>
                  <th>Operator</th>
                  <th>Geology</th>
                  <th>Products</th>
                  <th>Distance</th>
                </tr>
              </thead>
              <tbody>${compRows}</tbody>
            </table>
          </div>
        </div>

        <div class="popup-footer">
          <label class="popup-ctrl-label">Radius</label>
          <select class="popup-radius-select" data-lat="${clickLat}" data-lng="${clickLng}" data-product="${productFilter || 'all'}">
            ${[10, 25, 50, 75, 100].map(r =>
              `<option value="${r}" ${r === (radiusMi || CONFIG.deliveryOrders.searchRadiusMi) ? 'selected' : ''}>${r} mi</option>`
            ).join('')}
          </select>
          <label class="popup-ctrl-label" style="margin-left:12px">Product</label>
          <select class="popup-product-select" data-lat="${clickLat}" data-lng="${clickLng}" data-radius="${radiusMi || CONFIG.deliveryOrders.searchRadiusMi}">
            <option value="all" ${!productFilter || productFilter === 'all' ? 'selected' : ''}>All Products</option>
            ${getProductList().map(prod =>
              `<option value="${prod}" ${productFilter === prod ? 'selected' : ''}>${prod}</option>`
            ).join('')}
          </select>
        </div>
      </div>
    `;
  }

  function getProductList() {
    if (!_deliveryData) return [];
    const products = new Set(
      _deliveryData.features
        .map(f => f.properties.product)
        .filter(Boolean)
    );
    return [...products].sort();
  }

  // ─── Popup Lifecycle ──────────────────────────────────────────────────────

  function openPricePopup(latlng, productFilter, radiusMi) {
    const result = estimateDeliveredPrice(latlng.lat, latlng.lng, productFilter, radiusMi);
    const html = buildPopupHTML(result, latlng.lat, latlng.lng, productFilter, radiusMi);

    // Remove existing selection marker
    if (_selectionMarker) _map.removeLayer(_selectionMarker);

    _selectionMarker = L.popup({
      maxWidth: 720,
      minWidth: 400,
      className: 'price-estimator-popup',
      closeButton: true,
      autoClose: false,
      closeOnClick: false,
    })
      .setLatLng(latlng)
      .setContent(html)
      .openOn(_map);

    // Wire up the dropdowns inside the popup (re-query after DOM paint)
    setTimeout(() => {
      const radiusSelect = document.querySelector('.popup-radius-select');
      const productSelect = document.querySelector('.popup-product-select');

      if (radiusSelect) {
        radiusSelect.addEventListener('change', e => {
          const newRadius = parseInt(e.target.value);
          const newProduct = e.target.dataset.product;
          openPricePopup(latlng, newProduct, newRadius);
        });
      }
      if (productSelect) {
        productSelect.addEventListener('change', e => {
          const newProduct = e.target.value;
          const newRadius = parseInt(e.target.dataset.radius);
          openPricePopup(latlng, newProduct, newRadius);
        });
      }
    }, 80);
  }

  // ─── Map Click Handler ────────────────────────────────────────────────────

  function onMapClick(e) {
    if (!_active) return;
    openPricePopup(e.latlng, 'all', CONFIG.deliveryOrders.searchRadiusMi);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * activate(map)
   *   Call once when switching INTO Market Intel mode.
   *   Loads data on first call (cached thereafter), adds layers, wires click.
   */
  async function activate(map) {
    if (_active) return;
    _map = map;
    _active = true;

    // Show loading state
    const toggle = document.getElementById('mode-toggle-intel');
    if (toggle) toggle.classList.add('loading');

    try {
      await loadData();
    } catch (err) {
      console.error('[DeliveryMode] Data load failed:', err);
      alert('Could not load Market Intel data. Check console for details.');
      _active = false;
      if (toggle) toggle.classList.remove('loading');
      return;
    }

    _deliveryLayer = buildDeliveryLayer(_deliveryData).addTo(_map);
    _plantLayer    = buildPlantLayer(_plantData).addTo(_map);
    _map.on('click', onMapClick);

    // Update cursor
    _map.getContainer().classList.add('intel-cursor');

    if (toggle) toggle.classList.remove('loading');
    console.log('[DeliveryMode] Activated.');
  }

  /**
   * deactivate()
   *   Call when switching OUT of Market Intel mode.
   *   Removes layers and cleans up click handler.
   */
  function deactivate() {
    if (!_active || !_map) return;
    _active = false;

    if (_deliveryLayer) { _map.removeLayer(_deliveryLayer); _deliveryLayer = null; }
    if (_plantLayer)    { _map.removeLayer(_plantLayer);    _plantLayer    = null; }
    if (_selectionMarker) { _map.removeLayer(_selectionMarker); _selectionMarker = null; }

    _map.off('click', onMapClick);
    _map.getContainer().classList.remove('intel-cursor');

    console.log('[DeliveryMode] Deactivated.');
  }

  function isActive() { return _active; }

  return { activate, deactivate, isActive };

})();

// Expose globally for the mode toggle wiring in index.html
window.DeliveryMode = DeliveryMode;
