// ============================================================
// map.js  —  AggsData.com Producers Mode
//
// Depends on:  config.js   (globals: FIELDS, SIC_TO_GEOLOGY, GEOLOGY_LABELS,
//                            PRODUCER_COLORS, OTHER_COLOR, SIZE_BUCKETS,
//                            INITIAL_VIEW, LABEL_MIN_ZOOM, LABEL_MIN_PROD,
//                            LABEL_LIMITS, MAX_SELECTION, Z,
//                            getGeology, getProducerColor, getBaseSize,
//                            formatTons, drawGeologyPath)
//              Leaflet      (global: L)
//
// Exposes:     window.map            — the Leaflet map instance
//              window.AggsMarker     — custom canvas marker class
//              window.ProducersLayer — show() / hide() API for index.html
// ============================================================

'use strict';

// ============================================================
// CANVAS RENDERER — custom shapes per geology type
// ============================================================

L.Canvas.include({
    _drawAggsMarker(layer) {
        if (!this._drawing || layer._empty()) return;

        const p     = layer._point;
        const ctx   = this._ctx;
        const size  = layer.options.radius || 5;
        const geo   = layer.options.geology;
        const color = layer.options.fillColor || '#999';

        ctx.globalAlpha = layer.options.fillOpacity || 0.85;
        ctx.fillStyle   = color;
        ctx.strokeStyle = layer.options.selected ? '#FFD700' : 'rgba(0,0,0,0.45)';
        ctx.lineWidth   = layer.options.selected ? 2.5 : 0.8;

        ctx.beginPath();
        drawGeologyPath(ctx, geo, p.x, p.y, size);  // ← shared, no duplication
        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha = 1;
    },
});

const AggsMarker = L.CircleMarker.extend({
    _updatePath() {
        this._renderer._drawAggsMarker(this);
    },
});

window.AggsMarker = AggsMarker;

// ============================================================
// MAP SETUP
// ============================================================

const map = L.map('map', { preferCanvas: true })
    .setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
}).addTo(map);

// Dedicated pane for all producer canvas markers — isolates from overlayPane
// so hiding it never affects Leaflet internals or intel layers.
map.createPane('producersPane');
map.getPane('producersPane').style.zIndex = Z.producersPane;

const renderer = L.canvas({ padding: 0.5, pane: 'producersPane' });

const producersLayerGroup = L.layerGroup().addTo(map);

map.createPane('labelsPane');
map.getPane('labelsPane').style.zIndex      = Z.labelsPane;
map.getPane('labelsPane').style.pointerEvents = 'none';

// ============================================================
// PUBLIC PRODUCERS LAYER API
// (called by the mode toggle in index.html — keeps index.html ignorant
//  of Leaflet internals and avoids fragile DOM polling)
// ============================================================

// Track selection-bar visibility across hide/show without touching the DOM
// element as a data store (fixes the _wasVisible antipattern).
let _selBarWasVisible = false;

window.ProducersLayer = {
    show() {
        const producersPane = map.getPane('producersPane');
        const labelsPane    = map.getPane('labelsPane');

        if (producersPane) {
            producersPane.style.opacity      = '1';
            producersPane.style.pointerEvents = '';
        }
        if (labelsPane) labelsPane.style.opacity = '1';

        // Only update if data has loaded; avoids a no-op pass on fast toggles.
        if (markerData.length) updateMarkersAndLabels();

        document.querySelector('.select-control')?.style.removeProperty('display');
        document.querySelector('.legend-container')?.style.removeProperty('display');

        const selBar = document.getElementById('selection-bar');
        if (selBar && _selBarWasVisible) selBar.classList.add('visible');
    },

    hide() {
        // opacity:0 + pointerEvents:none keeps the canvas renderer fully
        // in the DOM and wired — hit-testing works immediately on show().
        const producersPane = map.getPane('producersPane');
        const labelsPane    = map.getPane('labelsPane');

        if (producersPane) {
            producersPane.style.opacity      = '0';
            producersPane.style.pointerEvents = 'none';
        }
        if (labelsPane) labelsPane.style.opacity = '0';

        labelMarkers.forEach(m => m.remove());
        labelMarkers = [];

        const selBar = document.getElementById('selection-bar');
        if (selBar) {
            _selBarWasVisible = selBar.classList.contains('visible');
            selBar.classList.remove('visible');
        }

        document.querySelector('.select-control')?.style.setProperty('display', 'none');
        document.querySelector('.legend-container')?.style.setProperty('display', 'none');
    },
};

// ============================================================
// DATA FETCH & MARKER CREATION
// ============================================================

let markerData = [];

fetch('AggsData.geojson')
    .then(res => res.json())
    .then(geojson => initMarkers(geojson.features))
    .catch(err => console.error('Failed to load AggsData.geojson:', err));

function initMarkers(features) {
    console.log(`Loading ${features.length} features from AggsData.geojson`);

    for (const feature of features) {
        if (!feature.geometry?.coordinates) continue;

        const props      = feature.properties;
        const [lon, lat] = feature.geometry.coordinates;
        const name       = props[FIELDS.name];
        const producer   = props[FIELDS.producer];
        const operator   = props[FIELDS.operator];
        const sic        = props[FIELDS.sic];
        const canvass    = props[FIELDS.canvass];
        const production = props[FIELDS.production] || 0;
        const geology    = getGeology(props);
        const baseSize   = getBaseSize(production);
        const color      = getProducerColor(producer);

        const marker = new AggsMarker([lat, lon], {
            renderer,
            pane:        'producersPane',
            radius:      baseSize,
            fillColor:   color,
            fillOpacity: 0.85,
            geology,
            selected:    false,
            stroke:      false,
        });

        const geologyLabel = GEOLOGY_LABELS[geology] || geology;
        const operatorLine = (operator && operator !== producer)
            ? `<div><b>Operator:</b> ${operator}</div>` : '';

        marker.bindPopup(
            `<div class="popup-content">
                <strong>${name}</strong>
                <div><b>Producer:</b> ${producer}</div>
                ${operatorLine}
                <div><b>Geology:</b> ${geologyLabel}</div>
                <div><b>Type:</b> ${sic}</div>
                <div><b>Production:</b> ${formatTons(production)} tons/yr</div>
            </div>`,
            { maxWidth: 280 }
        );

        marker.addTo(producersLayerGroup);

        markerData.push({
            marker,
            name,
            producer,
            operator:   operator  || '',
            sic:        sic       || '',
            canvass:    canvass   || '',
            geology,
            production,
            lat,
            lon,
            baseSize,
        });
    }

    console.log(`Placed ${markerData.length} markers`);
    buildLegend();
    buildSelectionControl();
    updateMarkersAndLabels();
}

// ============================================================
// ZOOM-RESPONSIVE SIZING & LABELS
// ============================================================

let labelMarkers = [];

function updateMarkersAndLabels() {
    if (!markerData.length) return;

    const zoom   = map.getZoom();
    const scale  = Math.pow(1.2, zoom - INITIAL_VIEW.zoom);
    const bounds = map.getBounds();

    // Tally production for producers visible in the current viewport
    const viewTotals = {};
    for (const d of markerData) {
        if (bounds.contains([d.lat, d.lon])) {
            viewTotals[d.producer] = (viewTotals[d.producer] || 0) + d.production;
        }
    }

    // Top 15 producers by viewport production get their brand color
    const topSet = new Set(
        Object.keys(viewTotals)
            .sort((a, b) => viewTotals[b] - viewTotals[a])
            .slice(0, 15)
    );

    for (const d of markerData) {
        d.marker.setRadius(d.baseSize * scale);
        const color = (PRODUCER_COLORS[d.producer] && topSet.has(d.producer))
            ? PRODUCER_COLORS[d.producer]
            : OTHER_COLOR;
        d.marker.setStyle({ fillColor: color });
    }

    labelMarkers.forEach(m => m.remove());
    labelMarkers = [];

    if (zoom < LABEL_MIN_ZOOM) return;

    const maxLabels = zoom >= 10 ? LABEL_LIMITS.detailed : LABEL_LIMITS.default;

    markerData
        .filter(d => bounds.contains([d.lat, d.lon]) && d.production >= LABEL_MIN_PROD)
        .sort((a, b) => b.production - a.production)
        .slice(0, maxLabels)
        .forEach(d => {
            const lbl = L.marker([d.lat, d.lon], {
                pane:        'labelsPane',
                interactive: false,
                icon: L.divIcon({
                    className:  'marker-label',
                    html:       d.producer,
                    iconSize:   null,
                    iconAnchor: [-8, 6],
                }),
            }).addTo(map);
            labelMarkers.push(lbl);
        });
}

map.on('zoomend', updateMarkersAndLabels);
map.on('moveend', updateMarkersAndLabels);

// ============================================================
// SELECTION TOOL
// ============================================================

let selectMode      = null;
let selectedData    = [];
let rectStart       = null;
let rectLayer       = null;
let polyPoints      = [];
let polyLayer       = null;
let polyPreviewLine = null;

// Build the selection bar element once; show/hide via CSS class.
const selectionBar = document.createElement('div');
selectionBar.id = 'selection-bar';
document.body.appendChild(selectionBar);

function updateSelectionBar() {
    const count = selectedData.length;

    if (count === 0) {
        selectionBar.classList.remove('visible');
        selectionBar.innerHTML = '';
        return;
    }

    const overLimit = count > MAX_SELECTION;
    const countSpan = document.createElement('span');
    countSpan.id          = 'sel-count';
    countSpan.textContent = overLimit
        ? `⚠️ ${count} sites selected — max is ${MAX_SELECTION}. Refine your selection.`
        : `${count} site${count === 1 ? '' : 's'} selected`;

    selectionBar.innerHTML = '';
    selectionBar.appendChild(countSpan);

    if (!overLimit) {
        const dlBtn = document.createElement('button');
        dlBtn.textContent = '⬇ Download CSV';
        dlBtn.className   = 'sel-bar-btn download';
        dlBtn.addEventListener('click', downloadCSV);
        selectionBar.appendChild(dlBtn);
    }

    const clearBtn = document.createElement('button');
    clearBtn.textContent = '✕ Clear';
    clearBtn.className   = 'sel-bar-btn clear';
    clearBtn.addEventListener('click', clearSelection);
    selectionBar.appendChild(clearBtn);

    selectionBar.classList.add('visible');
}

function pointInPolygon(lat, lon, polygonLatLngs) {
    let inside = false;
    for (let i = 0, j = polygonLatLngs.length - 1; i < polygonLatLngs.length; j = i++) {
        const xi = polygonLatLngs[i].lng, yi = polygonLatLngs[i].lat;
        const xj = polygonLatLngs[j].lng, yj = polygonLatLngs[j].lat;
        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function applySelectionFromShape(latLngs) {
    clearSelectionHighlights();
    selectedData = [];

    for (const d of markerData) {
        if (pointInPolygon(d.lat, d.lon, latLngs)) {
            selectedData.push(d);
            d.marker.setStyle({ selected: true });
            d.marker.redraw();
        }
    }

    updateSelectionBar();
}

function clearSelectionHighlights() {
    for (const d of markerData) {
        if (d.marker.options.selected) {
            d.marker.setStyle({ selected: false });
            d.marker.redraw();
        }
    }
}

function clearSelection() {
    clearSelectionHighlights();
    selectedData = [];
    updateSelectionBar();
    clearDrawing();
}

function clearDrawing() {
    rectLayer?.remove();       rectLayer       = null;
    polyLayer?.remove();       polyLayer       = null;
    polyPreviewLine?.remove(); polyPreviewLine = null;
    rectStart  = null;
    polyPoints = [];
}

function startRectMode() {
    clearSelection();
    selectMode = 'rect';
    map.dragging.disable();
    map.getContainer().style.cursor = 'crosshair';
}

function startPolyMode() {
    clearSelection();
    selectMode = 'poly';
    polyPoints = [];
    map.getContainer().style.cursor = 'crosshair';
}

map.on('mousedown', e => {
    if (selectMode !== 'rect') return;
    rectStart = e.latlng;
    rectLayer?.remove();
    rectLayer = null;
});

map.on('mousemove', e => {
    if (selectMode === 'rect' && rectStart) {
        rectLayer?.remove();
        rectLayer = L.rectangle([rectStart, e.latlng], {
            color: '#2c7bb6', weight: 2, fillOpacity: 0.1, dashArray: '5,5',
        }).addTo(map);
    }
    if (selectMode === 'poly' && polyPoints.length > 0) {
        polyPreviewLine?.remove();
        polyPreviewLine = L.polyline([polyPoints[polyPoints.length - 1], e.latlng], {
            color: '#e67e22', weight: 1.5, dashArray: '3,4', opacity: 0.7,
        }).addTo(map);
    }
});

map.on('mouseup', e => {
    if (selectMode !== 'rect' || !rectStart) return;

    const bounds  = L.latLngBounds(rectStart, e.latlng);
    const corners = [
        L.latLng(bounds.getNorth(), bounds.getWest()),
        L.latLng(bounds.getNorth(), bounds.getEast()),
        L.latLng(bounds.getSouth(), bounds.getEast()),
        L.latLng(bounds.getSouth(), bounds.getWest()),
    ];
    applySelectionFromShape(corners);

    selectMode = null;
    rectStart  = null;
    map.dragging.enable();
    map.getContainer().style.cursor = '';
    setActiveButton(null);
});

map.on('click', e => {
    if (selectMode !== 'poly') return;

    polyPoints.push(e.latlng);
    polyLayer?.remove();

    if (polyPoints.length > 1) {
        polyLayer = L.polyline(polyPoints, {
            color: '#e67e22', weight: 2, dashArray: '5,5',
        }).addTo(map);
    }
});

map.on('dblclick', e => {
    if (selectMode !== 'poly' || polyPoints.length < 3) return;

    polyLayer?.remove();
    polyLayer = L.polygon(polyPoints, {
        color: '#e67e22', weight: 2, fillOpacity: 0.1,
    }).addTo(map);

    applySelectionFromShape(polyPoints);

    selectMode = null;
    polyPreviewLine?.remove();
    polyPreviewLine = null;
    map.getContainer().style.cursor = '';
    setActiveButton(null);
});

// ── CSV Export ────────────────────────────────────────────────────────────────

function csvEscape(val) {
    if (val == null) return '';
    const str = String(val);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadCSV() {
    const headers = ['Name', 'Producer', 'Operator', 'SIC Type', 'Geology', 'Production (tons)', 'Latitude', 'Longitude'];
    const rows    = selectedData.map(d => [
        csvEscape(d.name),
        csvEscape(d.producer),
        csvEscape(d.operator),
        csvEscape(d.sic),
        csvEscape(GEOLOGY_LABELS[d.geology] || d.geology),
        d.production,
        d.lat,
        d.lon,
    ].join(','));

    const csv  = [headers.join(','), ...rows].join('\n');
    const url  = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'aggs_selection.csv' });
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================
// SELECTION CONTROL BUTTON GROUP
// ============================================================

let activeSelectBtn = null;

function setActiveButton(btn) {
    activeSelectBtn?.classList.remove('active');
    activeSelectBtn = btn;
    btn?.classList.add('active');
}

function buildSelectionControl() {
    const ctrl = L.control({ position: 'topleft' });

    ctrl.onAdd = () => {
        const container = L.DomUtil.create('div', 'leaflet-bar select-control');

        const title = L.DomUtil.create('div', 'select-control-title', container);
        title.textContent = 'Select Sites';

        function makeBtn(html, className, title, onClick) {
            const btn = L.DomUtil.create('button', `select-control-btn ${className}`, container);
            btn.innerHTML = html;
            btn.title     = title;
            btn.addEventListener('click', e => { L.DomEvent.stopPropagation(e); onClick(btn); });
            return btn;
        }

        makeBtn('⬜ Rectangle', '', 'Click and drag to select sites', btn => {
            if (selectMode === 'rect') {
                selectMode = null;
                map.dragging.enable();
                map.getContainer().style.cursor = '';
                setActiveButton(null);
            } else {
                startRectMode();
                setActiveButton(btn);
            }
        });

        makeBtn('✏️ Polygon', '', 'Click to add vertices, double-click to close', btn => {
            if (selectMode === 'poly') {
                selectMode = null;
                map.getContainer().style.cursor = '';
                clearDrawing();
                setActiveButton(null);
            } else {
                startPolyMode();
                setActiveButton(btn);
            }
        });

        makeBtn('✕ Clear', 'danger', 'Clear selection', () => {
            clearSelection();
            setActiveButton(null);
        });

        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);

        return container;
    };

    ctrl.addTo(map);
}

// ============================================================
// LEGEND
// ============================================================

function makeSymbolCanvas(geology, color, size = 7) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 28;
    const ctx = canvas.getContext('2d');
    const cx = 14, cy = 14;

    ctx.fillStyle   = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth   = 0.8;
    ctx.beginPath();
    drawGeologyPath(ctx, geology, cx, cy, size);  // ← shared, no duplication
    ctx.fill();
    ctx.stroke();

    return canvas;
}

function legendRow(canvas, label) {
    const row = document.createElement('div');
    row.className = 'legend-item';
    const sym = document.createElement('span');
    sym.className = 'legend-symbol';
    sym.appendChild(canvas);
    const txt = document.createElement('span');
    txt.textContent = label;
    row.appendChild(sym);
    row.appendChild(txt);
    return row;
}

function makeSection(panel, heading) {
    const h = document.createElement('h4');
    h.textContent = heading;
    panel.appendChild(h);
    const sec = document.createElement('div');
    sec.className = 'legend-section';
    panel.appendChild(sec);
    return sec;
}

function buildLegend() {
    const legend = L.control({ position: 'topright' });

    legend.onAdd = () => {
        const container = L.DomUtil.create('div', 'legend-container');

        const btn = L.DomUtil.create('button', 'legend-toggle', container);
        btn.innerHTML = '☰ Legend';

        const panel = L.DomUtil.create('div', 'legend', container);
        panel.style.display = 'none';

        // Geology type
        const sec1 = makeSection(panel, 'Geology Type');
        [
            { geology: 'limestone',   label: 'Limestone'     },
            { geology: 'hard_rock',   label: 'Hard Rock'     },
            { geology: 'sand_gravel', label: 'Sand & Gravel' },
        ].forEach(g => sec1.appendChild(legendRow(makeSymbolCanvas(g.geology, '#666'), g.label)));

        // Annual production
        const sec2 = makeSection(panel, 'Annual Production');
        [
            { label: '< 100K tons',      size: SIZE_BUCKETS[0].size },
            { label: '100K – 250K tons', size: SIZE_BUCKETS[1].size },
            { label: '250K – 500K tons', size: SIZE_BUCKETS[2].size },
            { label: '500K – 1.5M tons', size: SIZE_BUCKETS[3].size },
            { label: '> 1.5M tons',      size: SIZE_BUCKETS[4].size },
        ].forEach(s => sec2.appendChild(legendRow(makeSymbolCanvas('limestone', '#666', s.size * 0.65), s.label)));

        // Top producers
        const sec3 = makeSection(panel, 'Top Producers');
        Object.entries(PRODUCER_COLORS).forEach(([name, color]) =>
            sec3.appendChild(legendRow(makeSymbolCanvas('limestone', color), name))
        );
        sec3.appendChild(legendRow(makeSymbolCanvas('limestone', OTHER_COLOR), 'All Other Producers'));

        btn.addEventListener('click', () => {
            const hidden = panel.style.display === 'none';
            panel.style.display = hidden ? 'block' : 'none';
            btn.innerHTML       = hidden ? '✕ Legend' : '☰ Legend';
        });

        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);

        return container;
    };

    legend.addTo(map);
}

console.log('map.js loaded — waiting for GeoJSON...');
