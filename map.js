// ============================================================
// CONFIGURATION
// ============================================================

// GeoJSON property names — update here if your data schema changes
const FIELDS = {
    name:       'CURRENT_MINE_NAME',
    producer:   'CURRENT_CONTROLLER_NAME',
    operator:   'CURRENT_OPERATOR_NAME',
    sic:        'PRIMARY_SIC',
    canvass:    'PRIMARY_CANVASS',
    production: 'Tons 2025',
    lat:        'LATITUDE',
    lon:        'LONGITUDE'
};

// Maps PRIMARY_SIC strings to internal geology keys (controls symbol shape)
const SIC_TO_GEOLOGY = {
    'Crushed, Broken Limestone NEC': 'limestone',
    'Crushed, Broken Marble':        'limestone',
    'Crushed, Broken Granite':       'hard_rock',
    'Crushed, Broken Basalt':        'hard_rock',
    'Crushed, Broken Traprock':      'hard_rock',
    'Crushed, Broken Quartzite':     'hard_rock',
    'Crushed, Broken Sandstone':     'hard_rock',
    'Crushed, Broken Slate':         'hard_rock',
    'Crushed, Broken Stone NEC':     'hard_rock',
    'Construction Sand and Gravel':  'sand_gravel'
};

// Top 15 producers by total production — one color per company
const PRODUCER_COLORS = {
    'Vulcan Materials Company':      '#e41a1c',
    'CRH PLC':                       '#377eb8',
    'Martin Marietta Materials Inc': '#4daf4a',
    'Heidelberg Materials AG':       '#984ea3',
    'Amrize Ltd':                    '#ff7f00',
    'Rogers Group Inc':              '#e6c619',
    'Cemex S A':                     '#a65628',
    'Carmeuse Holding SA':           '#f781bf',
    'Summit Materials LLC':          '#d95f02',
    'Knife River Corporation':       '#7570b3',
    'Specialty Granules LLC':        '#e7298a',
    'Charles S  Luck IV':            '#66a61e',
    'Arcosa, Inc':                   '#e6ab02',
    'Atlas Energy Solutions Inc':    '#a6761d',
    'Granite Construction Inc':      '#555555'
};
const OTHER_COLOR = '#bbbbbb';

// Symbol size buckets by annual production (tons)
const SIZE_BUCKETS = [
    { min: 0,        size: 2  },  // < 100K tons
    { min: 100000,   size: 4  },  // 100K - 250K
    { min: 250000,   size: 8 },  // 250K - 500K
    { min: 500000,   size: 12 },  // 500K - 1.5M
    { min: 1500000,  size: 16 }   // > 1.5M
];

// Map starting position and zoom
const INITIAL_VIEW = {
    center: [39.8283, -98.5795],
    zoom: 5
};

// Label settings
const LABEL_MIN_ZOOM = 9;
const LABEL_MIN_PROD = 100000;
const LABEL_LIMITS   = { default: 50, detailed: 100 };

// Selection settings
const MAX_SELECTION = 100;

// ============================================================
// HELPERS
// ============================================================

const GEOLOGY_LABELS = {
    limestone:   'Limestone',
    hard_rock:   'Hard Rock',
    sand_gravel: 'Sand & Gravel'
};

function getGeology(props) {
    return SIC_TO_GEOLOGY[props[FIELDS.sic]] || 'hard_rock';
}

function getProducerColor(name) {
    return PRODUCER_COLORS[name] || OTHER_COLOR;
}

function getBaseSize(production) {
    for (var i = SIZE_BUCKETS.length - 1; i >= 0; i--) {
        if (production >= SIZE_BUCKETS[i].min) {
            var lower = SIZE_BUCKETS[i];
            var upper = SIZE_BUCKETS[i + 1];
            if (!upper) return lower.size;
            var t = (production - lower.min) / (upper.min - lower.min);
            return lower.size + t * (upper.size - lower.size);
        }
    }
    return SIZE_BUCKETS[0].size;
}

function formatTons(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000)    return Math.round(num / 1000) + 'K';
    return num.toLocaleString();
}

// Point-in-polygon test (ray casting)
function pointInPolygon(lat, lon, polygonLatLngs) {
    var x = lon, y = lat;
    var inside = false;
    for (var i = 0, j = polygonLatLngs.length - 1; i < polygonLatLngs.length; j = i++) {
        var xi = polygonLatLngs[i].lng, yi = polygonLatLngs[i].lat;
        var xj = polygonLatLngs[j].lng, yj = polygonLatLngs[j].lat;
        var intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// ============================================================
// CANVAS RENDERER — custom shapes per geology type
// ============================================================

L.Canvas.include({
    _drawAggsMarker: function(layer) {
        if (!this._drawing || layer._empty()) return;

        var p     = layer._point;
        var ctx   = this._ctx;
        var size  = layer.options.radius || 5;
        var geo   = layer.options.geology;
        var color = layer.options.fillColor || '#999';

        ctx.globalAlpha = layer.options.fillOpacity || 0.85;
        ctx.fillStyle   = color;
        ctx.strokeStyle = layer.options.selected ? '#FFD700' : 'rgba(0,0,0,0.45)';
        ctx.lineWidth   = layer.options.selected ? 2.5 : 0.8;

        ctx.beginPath();

        if (geo === 'limestone') {
            ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        } else if (geo === 'hard_rock') {
            ctx.moveTo(p.x,        p.y - size);
            ctx.lineTo(p.x + size, p.y);
            ctx.lineTo(p.x,        p.y + size);
            ctx.lineTo(p.x - size, p.y);
            ctx.closePath();
        } else {
            ctx.moveTo(p.x,                p.y - size);
            ctx.lineTo(p.x + size * 0.866, p.y + size * 0.5);
            ctx.lineTo(p.x - size * 0.866, p.y + size * 0.5);
            ctx.closePath();
        }

        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
});

var AggsMarker = L.CircleMarker.extend({
    _updatePath: function() {
        this._renderer._drawAggsMarker(this);
    }
});

// ============================================================
// MAP SETUP
// ============================================================

var map = L.map('map', { preferCanvas: true })
    .setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18
}).addTo(map);

var renderer = L.canvas({ padding: 0.5 });

// Label pane — Leaflet transforms this automatically during pan
map.createPane('labelsPane');
map.getPane('labelsPane').style.pointerEvents = 'none';

// ============================================================
// DATA FETCH & MARKER CREATION
// ============================================================

var markerData = [];

fetch('AggsData.geojson')
    .then(function(res) { return res.json(); })
    .then(function(geojson) { initMarkers(geojson.features); })
    .catch(function(err) { console.error('Failed to load AggsData.geojson:', err); });

function initMarkers(features) {
    console.log('Loading ' + features.length + ' features from AggsData.geojson');

    features.forEach(function(feature) {
        if (!feature.geometry || !feature.geometry.coordinates) return;

        var props      = feature.properties;
        var coords     = feature.geometry.coordinates;
        var lon        = coords[0];
        var lat        = coords[1];

        var name       = props[FIELDS.name];
        var producer   = props[FIELDS.producer];
        var operator   = props[FIELDS.operator];
        var sic        = props[FIELDS.sic];
        var canvass    = props[FIELDS.canvass];
        var production = props[FIELDS.production] || 0;
        var geology    = getGeology(props);
        var baseSize   = getBaseSize(production);
        var color      = getProducerColor(producer);

        var marker = new AggsMarker([lat, lon], {
            renderer:    renderer,
            radius:      baseSize,
            fillColor:   color,
            fillOpacity: 0.85,
            geology:     geology,
            selected:    false,
            stroke:      false
        });

        var geologyLabel = GEOLOGY_LABELS[geology] || geology;
        var operatorLine = (operator && operator !== producer)
            ? '<div><b>Operator:</b> ' + operator + '</div>' : '';

        marker.bindPopup(
            '<div class="popup-content">' +
                '<strong>' + name + '</strong>' +
                '<div><b>Producer:</b> ' + producer + '</div>' +
                operatorLine +
                '<div><b>Geology:</b> ' + geologyLabel + '</div>' +
                '<div><b>Type:</b> ' + sic + '</div>' +
                '<div><b>Production:</b> ' + formatTons(production) + ' tons/yr</div>' +
            '</div>',
            { maxWidth: 280 }
        );

        marker.addTo(map);

        markerData.push({
            marker:     marker,
            name:       name,
            producer:   producer,
            operator:   operator  || '',
            sic:        sic       || '',
            canvass:    canvass   || '',
            geology:    geology,
            production: production,
            lat:        lat,
            lon:        lon,
            baseSize:   baseSize
        });
    });

    console.log('Placed ' + markerData.length + ' markers');
    buildLegend();
    buildSelectionControl();
    updateMarkersAndLabels();
}

// ============================================================
// ZOOM-RESPONSIVE SIZING & LABELS
// ============================================================

var labelMarkers = [];

function updateMarkersAndLabels() {
    if (!markerData.length) return;

    var zoom   = map.getZoom();
    var scale  = Math.pow(1.2, zoom - INITIAL_VIEW.zoom);
    var bounds = map.getBounds();

    // Find top 15 producers in current viewport by production volume
    var viewTotals = {};
    markerData.forEach(function(d) {
        if (bounds.contains([d.lat, d.lon])) {
            viewTotals[d.producer] = (viewTotals[d.producer] || 0) + d.production;
        }
    });

    var topInView = Object.keys(viewTotals)
        .sort(function(a, b) { return viewTotals[b] - viewTotals[a]; })
        .slice(0, 15);

    var topSet = {};
    topInView.forEach(function(name) { topSet[name] = true; });

    // Resize and recolor every marker
    markerData.forEach(function(d) {
        d.marker.setRadius(d.baseSize * scale);
        var color = (PRODUCER_COLORS[d.producer] && topSet[d.producer])
            ? PRODUCER_COLORS[d.producer]
            : OTHER_COLOR;
        d.marker.setStyle({ fillColor: color });
    });

    // Remove old label markers
    labelMarkers.forEach(function(m) { m.remove(); });
    labelMarkers = [];

    if (zoom < LABEL_MIN_ZOOM) return;

    var maxLabels = zoom >= 10 ? LABEL_LIMITS.detailed : LABEL_LIMITS.default;

    var visible = markerData.filter(function(d) {
        return bounds.contains([d.lat, d.lon]) && d.production >= LABEL_MIN_PROD;
    });
    visible.sort(function(a, b) { return b.production - a.production; });
    visible.slice(0, maxLabels).forEach(function(d) {
        var lbl = L.marker([d.lat, d.lon], {
            pane:        'labelsPane',
            interactive: false,
            icon: L.divIcon({
                className:  'marker-label',
                html:       d.producer,
                iconSize:   null,
                iconAnchor: [-8, 6]
            })
        }).addTo(map);
        labelMarkers.push(lbl);
    });
}

map.on('zoomend', updateMarkersAndLabels);
map.on('moveend', updateMarkersAndLabels);

// ============================================================
// SELECTION TOOL
// ============================================================

var selectMode      = null;   // null | 'rect' | 'poly'
var selectedData    = [];
var rectStart       = null;
var rectLayer       = null;
var polyPoints      = [];
var polyLayer       = null;
var polyPreviewLine = null;

// Status bar shown after a selection
var selectionBar = document.createElement('div');
selectionBar.id = 'selection-bar';
selectionBar.style.cssText =
    'display:none;position:fixed;bottom:20px;left:50%;transform:translateX(-50%);' +
    'background:white;border:2px solid rgba(0,0,0,0.2);border-radius:6px;' +
    'padding:10px 18px;box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
    'font-size:13px;font-family:inherit;z-index:1000;' +
    'display:none;align-items:center;gap:12px;';
document.body.appendChild(selectionBar);

function updateSelectionBar() {
    var count = selectedData.length;
    if (count === 0) {
        selectionBar.style.display = 'none';
        return;
    }

    var overLimit = count > MAX_SELECTION;
    selectionBar.style.display = 'flex';
    selectionBar.innerHTML =
        '<span id="sel-count">' +
            (overLimit
                ? '⚠️ ' + count + ' sites selected — max is ' + MAX_SELECTION + '. Refine your selection.'
                : count + ' site' + (count === 1 ? '' : 's') + ' selected') +
        '</span>';

    if (!overLimit) {
        var dlBtn = document.createElement('button');
        dlBtn.textContent = '⬇ Download CSV';
        dlBtn.style.cssText =
            'background:#2c7bb6;color:white;border:none;border-radius:4px;' +
            'padding:6px 12px;cursor:pointer;font-size:13px;font-weight:600;';
        dlBtn.addEventListener('click', downloadCSV);
        selectionBar.appendChild(dlBtn);
    }

    var clearBtn = document.createElement('button');
    clearBtn.textContent = '✕ Clear';
    clearBtn.style.cssText =
        'background:#e0e0e0;color:#333;border:none;border-radius:4px;' +
        'padding:6px 10px;cursor:pointer;font-size:13px;';
    clearBtn.addEventListener('click', clearSelection);
    selectionBar.appendChild(clearBtn);
}

function applySelectionFromShape(latLngs) {
    // latLngs is an array of L.LatLng forming a closed polygon
    clearSelectionHighlights();
    selectedData = [];

    markerData.forEach(function(d) {
        if (pointInPolygon(d.lat, d.lon, latLngs)) {
            selectedData.push(d);
            d.marker.setStyle({ selected: true });
            d.marker.redraw();
        }
    });

    updateSelectionBar();
}

function clearSelectionHighlights() {
    markerData.forEach(function(d) {
        if (d.marker.options.selected) {
            d.marker.setStyle({ selected: false });
            d.marker.redraw();
        }
    });
}

function clearSelection() {
    clearSelectionHighlights();
    selectedData = [];
    updateSelectionBar();
    clearDrawing();
}

function clearDrawing() {
    if (rectLayer)       { rectLayer.remove();       rectLayer = null; }
    if (polyLayer)       { polyLayer.remove();        polyLayer = null; }
    if (polyPreviewLine) { polyPreviewLine.remove();  polyPreviewLine = null; }
    rectStart  = null;
    polyPoints = [];
}

// ---- Rectangle selection ----

function startRectMode() {
    clearSelection();
    selectMode = 'rect';
    map.dragging.disable();
    map.getContainer().style.cursor = 'crosshair';
}

map.on('mousedown', function(e) {
    if (selectMode !== 'rect') return;
    rectStart = e.latlng;
    if (rectLayer) { rectLayer.remove(); rectLayer = null; }
});

map.on('mousemove', function(e) {
    if (selectMode !== 'rect' || !rectStart) return;
    if (rectLayer) rectLayer.remove();
    rectLayer = L.rectangle([rectStart, e.latlng], {
        color: '#2c7bb6', weight: 2, fillOpacity: 0.1, dashArray: '5,5'
    }).addTo(map);
});

map.on('mouseup', function(e) {
    if (selectMode !== 'rect' || !rectStart) return;

    var bounds = L.latLngBounds(rectStart, e.latlng);
    // Convert bounds to polygon corners for pointInPolygon
    var corners = [
        L.latLng(bounds.getNorth(), bounds.getWest()),
        L.latLng(bounds.getNorth(), bounds.getEast()),
        L.latLng(bounds.getSouth(), bounds.getEast()),
        L.latLng(bounds.getSouth(), bounds.getWest())
    ];
    applySelectionFromShape(corners);

    selectMode = null;
    rectStart  = null;
    map.dragging.enable();
    map.getContainer().style.cursor = '';
    setActiveButton(null);
});

// ---- Polygon selection ----

function startPolyMode() {
    clearSelection();
    selectMode = 'poly';
    polyPoints = [];
    map.getContainer().style.cursor = 'crosshair';
}

map.on('click', function(e) {
    if (selectMode !== 'poly') return;

    polyPoints.push(e.latlng);

    // Redraw the in-progress polygon outline
    if (polyLayer) polyLayer.remove();
    if (polyPoints.length > 1) {
        polyLayer = L.polyline(polyPoints, {
            color: '#e67e22', weight: 2, dashArray: '5,5'
        }).addTo(map);
    }
});

map.on('mousemove', function(e) {
    if (selectMode !== 'poly' || polyPoints.length === 0) return;
    if (polyPreviewLine) polyPreviewLine.remove();
    polyPreviewLine = L.polyline([polyPoints[polyPoints.length - 1], e.latlng], {
        color: '#e67e22', weight: 1.5, dashArray: '3,4', opacity: 0.7
    }).addTo(map);
});

map.on('dblclick', function(e) {
    if (selectMode !== 'poly' || polyPoints.length < 3) return;

    // Close the polygon
    if (polyLayer) polyLayer.remove();
    polyLayer = L.polygon(polyPoints, {
        color: '#e67e22', weight: 2, fillOpacity: 0.1
    }).addTo(map);

    applySelectionFromShape(polyPoints);

    selectMode = null;
    if (polyPreviewLine) { polyPreviewLine.remove(); polyPreviewLine = null; }
    map.getContainer().style.cursor = '';
    setActiveButton(null);
});

// ---- CSV download ----

function downloadCSV() {
    var headers = ['Name', 'Producer', 'Operator', 'SIC Type', 'Geology', 'Production (tons)', 'Latitude', 'Longitude'];

    var rows = selectedData.map(function(d) {
        return [
            csvEscape(d.name),
            csvEscape(d.producer),
            csvEscape(d.operator),
            csvEscape(d.sic),
            csvEscape(GEOLOGY_LABELS[d.geology] || d.geology),
            d.production,
            d.lat,
            d.lon
        ].join(',');
    });

    var csv  = [headers.join(',')].concat(rows).join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href     = url;
    a.download = 'aggs_selection.csv';
    a.click();
    URL.revokeObjectURL(url);
}

function csvEscape(val) {
    if (val === null || val === undefined) return '';
    var str = String(val);
    // Wrap in quotes if value contains comma, quote, or newline
    if (str.search(/[",\n]/) >= 0) return '"' + str.replace(/"/g, '""') + '"';
    return str;
}

// ============================================================
// SELECTION CONTROL BUTTON GROUP
// ============================================================

var activeSelectBtn = null;

function setActiveButton(btn) {
    if (activeSelectBtn) {
        activeSelectBtn.style.background = 'white';
        activeSelectBtn.style.color      = '#333';
    }
    activeSelectBtn = btn;
    if (btn) {
        btn.style.background = '#2c7bb6';
        btn.style.color      = 'white';
    }
}

function buildSelectionControl() {
    var ctrl = L.control({ position: 'topleft' });

    ctrl.onAdd = function() {
        var container = L.DomUtil.create('div', 'leaflet-bar select-control');
        container.style.cssText =
            'background:white;border:2px solid rgba(0,0,0,0.2);border-radius:4px;' +
            'box-shadow:0 1px 5px rgba(0,0,0,0.4);overflow:hidden;';

        // Title bar
        var title = document.createElement('div');
        title.textContent = 'Select Sites';
        title.style.cssText =
            'padding:6px 10px;font-size:12px;font-weight:700;color:#555;' +
            'border-bottom:1px solid #ddd;background:#f8f8f8;';
        container.appendChild(title);

        var btnStyle =
            'display:block;width:100%;padding:7px 12px;border:none;border-bottom:1px solid #eee;' +
            'background:white;color:#333;font-size:13px;cursor:pointer;text-align:left;font-family:inherit;';

        // Rectangle button
        var rectBtn = document.createElement('button');
        rectBtn.innerHTML = '⬜ Rectangle';
        rectBtn.style.cssText = btnStyle;
        rectBtn.title = 'Click and drag to select sites';
        rectBtn.addEventListener('click', function(e) {
            L.DomEvent.stopPropagation(e);
            if (selectMode === 'rect') {
                selectMode = null;
                map.dragging.enable();
                map.getContainer().style.cursor = '';
                setActiveButton(null);
            } else {
                startRectMode();
                setActiveButton(rectBtn);
            }
        });
        container.appendChild(rectBtn);

        // Polygon button
        var polyBtn = document.createElement('button');
        polyBtn.innerHTML = '✏️ Polygon';
        polyBtn.style.cssText = btnStyle;
        polyBtn.title = 'Click to add vertices, double-click to close';
        polyBtn.addEventListener('click', function(e) {
            L.DomEvent.stopPropagation(e);
            if (selectMode === 'poly') {
                selectMode = null;
                map.getContainer().style.cursor = '';
                clearDrawing();
                setActiveButton(null);
            } else {
                startPolyMode();
                setActiveButton(polyBtn);
            }
        });
        container.appendChild(polyBtn);

        // Clear button
        var clearBtn = document.createElement('button');
        clearBtn.innerHTML = '✕ Clear';
        clearBtn.style.cssText = btnStyle + 'border-bottom:none;color:#c0392b;';
        clearBtn.addEventListener('click', function(e) {
            L.DomEvent.stopPropagation(e);
            clearSelection();
            setActiveButton(null);
        });
        container.appendChild(clearBtn);

        // Prevent map click-through on the control
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);

        return container;
    };

    ctrl.addTo(map);
}

// ============================================================
// LEGEND
// ============================================================

function makeSymbolCanvas(geology, color, size) {
    size = size || 7;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = 28;
    var ctx = canvas.getContext('2d');
    var cx = 14, cy = 14;

    ctx.fillStyle   = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth   = 0.8;
    ctx.beginPath();

    if (geology === 'limestone') {
        ctx.arc(cx, cy, size, 0, Math.PI * 2);
    } else if (geology === 'hard_rock') {
        ctx.moveTo(cx,        cy - size);
        ctx.lineTo(cx + size, cy);
        ctx.lineTo(cx,        cy + size);
        ctx.lineTo(cx - size, cy);
        ctx.closePath();
    } else {
        ctx.moveTo(cx,                cy - size);
        ctx.lineTo(cx + size * 0.866, cy + size * 0.5);
        ctx.lineTo(cx - size * 0.866, cy + size * 0.5);
        ctx.closePath();
    }

    ctx.fill();
    ctx.stroke();
    return canvas;
}

function legendRow(canvas, label) {
    var row = document.createElement('div');
    row.className = 'legend-item';
    var sym = document.createElement('span');
    sym.className = 'legend-symbol';
    sym.appendChild(canvas);
    var txt = document.createElement('span');
    txt.textContent = label;
    row.appendChild(sym);
    row.appendChild(txt);
    return row;
}

function buildLegend() {
    var legend = L.control({ position: 'topright' });

    legend.onAdd = function() {
        var container = L.DomUtil.create('div', 'legend-container');

        var btn = L.DomUtil.create('button', 'legend-toggle', container);
        btn.innerHTML = '☰ Legend';
        btn.style.cssText =
            'background:white;border:2px solid rgba(0,0,0,0.2);border-radius:4px;' +
            'padding:8px 12px;cursor:pointer;font-size:14px;font-weight:600;' +
            'box-shadow:0 1px 5px rgba(0,0,0,0.4);display:block;width:100%;';

        var panel = L.DomUtil.create('div', 'legend', container);
        panel.style.display = 'none';

        // Geology types
        var h1 = document.createElement('h4');
        h1.textContent = 'Geology Type';
        panel.appendChild(h1);
        var sec1 = document.createElement('div');
        sec1.className = 'legend-section';
        [
            { geology: 'limestone',   label: 'Limestone'     },
            { geology: 'hard_rock',   label: 'Hard Rock'     },
            { geology: 'sand_gravel', label: 'Sand & Gravel' }
        ].forEach(function(g) {
            sec1.appendChild(legendRow(makeSymbolCanvas(g.geology, '#666'), g.label));
        });
        panel.appendChild(sec1);

        // Production sizes
        var h2 = document.createElement('h4');
        h2.textContent = 'Annual Production';
        h2.style.marginTop = '10px';
        panel.appendChild(h2);
        var sec2 = document.createElement('div');
        sec2.className = 'legend-section';
        [
            { label: '< 100K tons',      size: SIZE_BUCKETS[0].size },
            { label: '100K - 250K tons', size: SIZE_BUCKETS[1].size },
            { label: '250K - 500K tons', size: SIZE_BUCKETS[2].size },
            { label: '500K - 1.5M tons', size: SIZE_BUCKETS[3].size },
            { label: '> 1.5M tons',      size: SIZE_BUCKETS[4].size }
        ].forEach(function(s) {
            sec2.appendChild(legendRow(makeSymbolCanvas('limestone', '#666', s.size * 0.65), s.label));
        });
        panel.appendChild(sec2);

        // Top producers
        var h3 = document.createElement('h4');
        h3.textContent = 'Top Producers';
        h3.style.marginTop = '10px';
        panel.appendChild(h3);
        var sec3 = document.createElement('div');
        sec3.className = 'legend-section';
        Object.keys(PRODUCER_COLORS).forEach(function(name) {
            sec3.appendChild(legendRow(makeSymbolCanvas('limestone', PRODUCER_COLORS[name]), name));
        });
        sec3.appendChild(legendRow(makeSymbolCanvas('limestone', OTHER_COLOR), 'All Other Producers'));
        panel.appendChild(sec3);

        btn.addEventListener('click', function() {
            var hidden = panel.style.display === 'none';
            panel.style.display = hidden ? 'block' : 'none';
            btn.innerHTML = hidden ? '✕ Legend' : '☰ Legend';
        });

        return container;
    };

    legend.addTo(map);
}

console.log('Map script loaded — waiting for GeoJSON...');
