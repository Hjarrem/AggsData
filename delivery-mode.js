/**
 * delivery-mode.js
 * AggsData.com — Market Intel Mode
 */

'use strict';

const DeliveryMode = (() => {

  // ─── Config ───────────────────────────────────────────────────────────────

  const CONFIG = {
    deliveryOrders: {
      url: 'delivery-orders.sample.geojson',
      searchRadiusMi: 25,
      outlierIqrFactor: 1.5,
    },
    plants: {
      url: 'aggregate-plants.sample.geojson',
      competitorRadiusMi: 35,
    },
    priceRange: {
      pctBand: 0.10,
    },
  };

  // ─── State ────────────────────────────────────────────────────────────────

  let _map           = null;
  let _deliveryLayer = null;
  let _plantLayer    = null;
  let _activePopup   = null;
  let _active        = false;
  let _deliveryData  = null;
  let _plantData     = null;
  let _origUpdateFn  = null;  // for label suppression

  // ─── Helpers ──────────────────────────────────────────────────────────────

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
    return arr.filter(v =>
      v >= q1 - CONFIG.deliveryOrders.outlierIqrFactor * iqr &&
      v <= q3 + CONFIG.deliveryOrders.outlierIqrFactor * iqr
    );
  }

  const fmt$   = n => n == null ? '—' : '$' + n.toFixed(2);
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
    if (!dr.ok) throw new Error(`Delivery orders: ${dr.statusText}`);
    if (!pr.ok) throw new Error(`Plant locations: ${pr.statusText}`);
    _deliveryData = await dr.json();
    _plantData    = await pr.json();
  }

  // ─── Delivery Layer ───────────────────────────────────────────────────────

  function productColor(product) {
    const p = (product || '').toLowerCase();
    if (p.includes('limestone') || p.includes('calcite') || p.includes('dense grade') || p.includes('dga') || p.includes('ag lime') || p.includes('screening')) return '#e8a44a';
    if (p.includes('granite') || p.includes('hard rock') || p.includes('trap') || p.includes('ballast') || p.includes('rip rap')) return '#7a6fa0';
    if (p.includes('sand') || p.includes('gravel')) return '#6baa75';
    if (p.includes('recycled') || p.includes('rca') || p.includes('rap')) return '#5b9cba';
    if (p.includes('basalt') || p.includes('quartzite')) return '#c26060';
    return '#aaa';
  }

  function buildDeliveryLayer(data) {
    const renderer = L.canvas({ padding: 0.5, pane: 'intelPane' });
    return L.geoJSON(data, {
      pointToLayer(feature, latlng) {
        const p = feature.properties;
        return L.circleMarker(latlng, {
          renderer,
          pane:        'intelPane',
          radius:      5,
          fillColor:   productColor(p.product),
          color:       'rgba(0,0,0,0.4)',
          weight:      0.8,
          fillOpacity: 0.85,
        });
      },
      onEachFeature(feature, layer) {
        const p = feature.properties;
        layer.bindTooltip(
          `<strong>${p.product || 'Delivery'}</strong><br>
           ASP: ${fmt$(p.asp)}/ton &nbsp;·&nbsp; ${fmtQty(p.quantity, p.quantity_unit)}<br>
           Source: ${p.source_plant || '—'} &nbsp;·&nbsp; ${fmtDate(p.delivery_date)}`,
          { className: 'agg-tooltip', sticky: true }
        );
      },
    });
  }

  // ─── Plant Layer — uses same AggsMarker canvas renderer as producers mode ─

  function geologyKey(geologyStr) {
    const g = (geologyStr || '').toLowerCase();
    if (g.includes('sand') || g.includes('gravel'))                      return 'sand_gravel';
    if (g.includes('granite') || g.includes('basalt') || g.includes('trap') ||
        g.includes('quartzite') || g.includes('hard'))                   return 'hard_rock';
    return 'limestone';
  }

  function buildPlantLayer(data) {
    const useAggsMarker = typeof AggsMarker !== 'undefined';
    const renderer      = L.canvas({ padding: 0.5, pane: 'intelPane' });

    return L.geoJSON(data, {
      pointToLayer(feature, latlng) {
        const p     = feature.properties;
        const geo   = geologyKey(p.geology);
        const color = p.is_competitor
          ? '#e41a1c'
          : (window.PRODUCER_COLORS && PRODUCER_COLORS[p.operator]) || '#2a7fc1';

        if (useAggsMarker) {
          return new AggsMarker([latlng.lat, latlng.lng], {
            renderer,
            pane:        'intelPane',
            radius:      10,
            fillColor:   color,
            fillOpacity: 0.9,
            geology:     geo,
            selected:    false,
            stroke:      false,
          });
        }
        return L.circleMarker(latlng, {
          pane: 'intelPane',
          radius: 10, fillColor: color,
          color: 'rgba(0,0,0,0.4)', weight: 0.8, fillOpacity: 0.9,
        });
      },
      onEachFeature(feature, layer) {
        const p     = feature.properties;
        const label = p.is_competitor ? '⚠ Competitor' : '✦ Own Plant';
        layer.bindTooltip(
          `<strong>${p.name || 'Plant'}</strong><br>
           <em>${label}</em>${p.operator ? ' · ' + p.operator : ''}<br>
           Geology: ${p.geology || '—'}<br>
           Est. Production: ${p.est_production_tpy ? p.est_production_tpy.toLocaleString() + ' TPY' : '—'}<br>
           Products: ${p.products || '—'}`,
          { className: 'agg-tooltip plant-tooltip', sticky: true }
        );
      },
    });
  }

  // ─── Price Estimator ──────────────────────────────────────────────────────

  function estimateDeliveredPrice(clickLat, clickLng, productFilter, radiusMi) {
    if (!_deliveryData) return { medianAsp: null, low: null, high: null, orders: [], competitors: [], sampleSize: 0 };
    const radius = radiusMi || CONFIG.deliveryOrders.searchRadiusMi;

    const nearby = _deliveryData.features.filter(f => {
      const [lng, lat] = f.geometry.coordinates;
      const dist = distanceMi(clickLat, clickLng, lat, lng);
      f._dist = dist;
      if (dist > radius) return false;
      if (productFilter && productFilter !== 'all') {
        return (f.properties.product || '').toLowerCase()
          .includes(productFilter.toLowerCase());
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
      orders:     nearby.sort((a, b) => a._dist - b._dist).slice(0, 10),
      competitors,
      sampleSize: filtered.length,
    };
  }

  function getProductList() {
    if (!_deliveryData) return [];
    return [...new Set(_deliveryData.features.map(f => f.properties.product).filter(Boolean))].sort();
  }

  // ─── Popup HTML ───────────────────────────────────────────────────────────

  function buildPopupHTML(result, clickLat, clickLng, productFilter, radiusMi) {
    const { medianAsp, low, high, orders, competitors, sampleSize } = result;
    const coordStr = `${clickLat.toFixed(4)}°N,\u00a0${Math.abs(clickLng).toFixed(4)}°W`;
    const noData   = medianAsp == null;
    const radius   = radiusMi  || CONFIG.deliveryOrders.searchRadiusMi;
    const product  = productFilter || 'all';

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
      : `<tr><td colspan="5" class="popup-empty">No competitors within ${CONFIG.plants.competitorRadiusMi} mi</td></tr>`;

    const radiusOptions  = [10, 25, 50, 75, 100].map(r =>
      `<option value="${r}" ${r === radius ? 'selected' : ''}>${r} mi</option>`
    ).join('');
    const productOptions = getProductList().map(prod =>
      `<option value="${prod}" ${product === prod ? 'selected' : ''}>${prod}</option>`
    ).join('');

    return `
      <div class="price-popup">
        <div class="popup-header">
          <div class="popup-title">Delivered Price Estimate</div>
          <div class="popup-coord">${coordStr}</div>
        </div>

        ${noData
          ? `<div class="popup-no-data">
               No delivery records found within <strong>${radius}\u00a0mi</strong>
               ${product !== 'all' ? ` for <em>${product}</em>` : ''}.
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
                 ${product !== 'all' ? ` · <em>${product}</em>` : ''}
               </div>
             </div>`
        }

        <div class="popup-section">
          <div class="popup-section-title">
            Nearby Delivery Orders
            <span class="popup-section-sub">(within ${radius} mi, closest 10)</span>
          </div>
          ${orders.length
            ? `<div class="popup-table-wrap">
                 <table class="popup-table">
                   <thead><tr>
                     <th>Product</th><th>ASP</th><th>Quantity</th>
                     <th>Source Plant</th><th>Date</th><th>Distance</th>
                   </tr></thead>
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
              <thead><tr>
                <th>Plant</th><th>Operator</th><th>Geology</th><th>Products</th><th>Distance</th>
              </tr></thead>
              <tbody>${compRows}</tbody>
            </table>
          </div>
        </div>

        <div class="popup-footer">
          <label class="popup-ctrl-label" for="intel-radius-select">Radius</label>
          <select id="intel-radius-select">${radiusOptions}</select>
          <label class="popup-ctrl-label" for="intel-product-select" style="margin-left:12px">Product</label>
          <select id="intel-product-select">
            <option value="all" ${product === 'all' ? 'selected' : ''}>All Products</option>
            ${productOptions}
          </select>
        </div>
      </div>
    `;
  }

  // ─── Popup Lifecycle ──────────────────────────────────────────────────────
  //
  // FIX: use unique element IDs, wire listeners via requestAnimationFrame,
  // capture current latlng in JS closure (not data-* attributes which go stale).

  function openPricePopup(latlng, productFilter, radiusMi) {
    // Close existing popup cleanly
    if (_activePopup) {
      _map.closePopup(_activePopup);
      _activePopup = null;
    }

    const result = estimateDeliveredPrice(latlng.lat, latlng.lng, productFilter, radiusMi);
    const html   = buildPopupHTML(result, latlng.lat, latlng.lng, productFilter, radiusMi);

    _activePopup = L.popup({
      maxWidth:     720,
      minWidth:     400,
      className:    'price-estimator-popup',
      closeButton:  true,
      autoClose:    false,
      closeOnClick: false,
    })
      .setLatLng(latlng)
      .setContent(html)
      .openOn(_map);

    // Wire dropdown listeners after Leaflet injects the content into DOM
    requestAnimationFrame(() => {
      const radiusSel  = document.getElementById('intel-radius-select');
      const productSel = document.getElementById('intel-product-select');

      if (radiusSel) {
        radiusSel.addEventListener('change', function () {
          const newRadius  = parseInt(this.value);
          const newProduct = productSel ? productSel.value : (productFilter || 'all');
          openPricePopup(latlng, newProduct, newRadius);
        });
      }
      if (productSel) {
        productSel.addEventListener('change', function () {
          const newProduct = this.value;
          const newRadius  = radiusSel ? parseInt(radiusSel.value) : (radiusMi || CONFIG.deliveryOrders.searchRadiusMi);
          openPricePopup(latlng, newProduct, newRadius);
        });
      }
    });
  }

  // ─── Map Click Handler ────────────────────────────────────────────────────

  function onMapClick(e) {
    if (!_active) return;
    if (window.selectMode && window.selectMode !== null) return;
    openPricePopup(e.latlng, 'all', CONFIG.deliveryOrders.searchRadiusMi);
  }

  // ─── Label Suppression ────────────────────────────────────────────────────
  // map.js fires updateMarkersAndLabels() on every moveend/zoomend.
  // We monkey-patch the global while intel mode is active so labels
  // are cleared and not re-drawn. Restored on deactivate.

  function suppressLabels() {
    if (typeof window.updateMarkersAndLabels === 'function' && !_origUpdateFn) {
      _origUpdateFn = window.updateMarkersAndLabels;
      window.updateMarkersAndLabels = function () {
        if (window.labelMarkers) {
          window.labelMarkers.forEach(m => m.remove());
          window.labelMarkers = [];
        }
      };
      window.updateMarkersAndLabels(); // clear any current labels immediately
    }
  }

  function restoreLabels() {
    if (_origUpdateFn) {
      window.updateMarkersAndLabels = _origUpdateFn;
      _origUpdateFn = null;
      window.updateMarkersAndLabels(); // repaint labels for current viewport
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async function activate(map) {
    if (_active) return;
    _map    = map;
    _active = true;

    const btn = document.getElementById('mode-btn-intel');
    if (btn) btn.classList.add('loading');

    // Create a dedicated pane for intel layers so hiding the producers
    // overlayPane doesn't affect intel markers (and vice-versa).
    if (!map.getPane('intelPane')) {
      map.createPane('intelPane');
      map.getPane('intelPane').style.zIndex = 450; // between overlayPane(400) and shadowPane(500)
    }

    try {
      await loadData();
    } catch (err) {
      console.error('[DeliveryMode]', err);
      alert('Could not load Market Intel data. Check console for details.');
      _active = false;
      if (btn) btn.classList.remove('loading');
      return;
    }

    _deliveryLayer = buildDeliveryLayer(_deliveryData).addTo(_map);
    _plantLayer    = buildPlantLayer(_plantData).addTo(_map);
    _map.on('click', onMapClick);
    _map.getContainer().classList.add('intel-cursor');
    suppressLabels();

    if (btn) btn.classList.remove('loading');
    console.log('[DeliveryMode] Activated.');
  }

  function deactivate() {
    if (!_active || !_map) return;
    _active = false;

    if (_activePopup)   { _map.closePopup(_activePopup);    _activePopup   = null; }
    if (_deliveryLayer) { _map.removeLayer(_deliveryLayer); _deliveryLayer = null; }
    if (_plantLayer)    { _map.removeLayer(_plantLayer);    _plantLayer    = null; }

    _map.off('click', onMapClick);
    _map.getContainer().classList.remove('intel-cursor');
    restoreLabels();

    console.log('[DeliveryMode] Deactivated.');
  }

  function isActive() { return _active; }

  return { activate, deactivate, isActive };

})();

window.DeliveryMode = DeliveryMode;
