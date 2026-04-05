fetch('AggsData.geojson')
    .then(res => res.json())
    .then(AggsData => {
        initMap(AggsData);
    })
    .catch(err => console.error('Failed to load AggsData.geojson:', err));

function initMap(AggsData) {
    const features = AggsData.features;
 

// ============================================================
// CONFIGURATION
// ============================================================

// GeoJSON property names — update here if your data schema changes
const FIELDS = {
    name:       'CURRENT_MINE_NAME',
    producer:   'CURRENT_CONTROLLER_NAME',
    operator:   'CURRENT_OPERATOR_NAME',
    sic:        'PRIMARY_SIC',
    canvass:    'PRIMARY_CANVASS',   // 'Stone' | 'SandAndGravel'
    production: 'Tons 2025',
    lat:        'LATITUDE',
    lon:        'LONGITUDE'
};

// Map PRIMARY_SIC strings to internal geology keys used for symbol shapes
// Add new SIC values here as your data grows
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

// Top 15 producers by total production — colors assigned per company
const PRODUCER_COLORS = {
    'Vulcan Materials Company':     '#e41a1c',
    'CRH PLC':                      '#377eb8',
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
// Each entry: minimum threshold → pixel radius at default zoom
const SIZE_BUCKETS = [
    { min: 0,        size: 3  },  // < 100K tons
    { min: 100000,   size: 6  },  // 100K – 250K
    { min: 250000,   size: 10 },  // 250K – 500K
    { min: 500000,   size: 16 },  // 500K – 1.5M
    { min: 1500000,  size: 24 }   // > 1.5M
];

// Map starting position and zoom
const INITIAL_VIEW = {
    center: [39.8283, -98.5795],
    zoom: 5
};

// Labels appear at this zoom level and above
const LABEL_MIN_ZOOM     = 9;
// Minimum production (tons) for a label to appear
const LABEL_MIN_PROD     = 100000;
// Max labels shown at zoom 9 / zoom 10+
const LABEL_LIMITS       = { default: 50, detailed: 100 };

// ============================================================
// GEOLOGY HELPERS
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
    // Walk buckets from largest to smallest and return matching size
    for (let i = SIZE_BUCKETS.length - 1; i >= 0; i--) {
        if (production >= SIZE_BUCKETS[i].min) {
            // Interpolate to next bucket if one exists
            const lower = SIZE_BUCKETS[i];
            const upper = SIZE_BUCKETS[i + 1];
            if (!upper) return lower.size;
            const t = (production - lower.min) / (upper.min - lower.min);
            return lower.size + t * (upper.size - lower.size);
        }
    }
    return SIZE_BUCKETS[0].size;
}

function formatTons(num) {
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000)     return (num / 1_000).toFixed(0) + 'K';
    return num.toLocaleString();
}

// ============================================================
// CANVAS RENDERER — custom shapes per geology type
// ============================================================

L.Canvas.include({
    _drawAggsMarker(layer) {
        if (!this._drawing || layer._empty()) return;

        const { x, y } = layer._point;
        const ctx      = this._ctx;
        const size     = layer.options.radius || 5;
        const geology  = layer.options.geology;
        const color    = layer.options.fillColor || '#999';

        ctx.globalAlpha = layer.options.fillOpacity ?? 0.85;
        ctx.fillStyle   = color;
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth   = 0.8;

        ctx.beginPath();

        if (geology === 'limestone') {
            // Circle
            ctx.arc(x, y, size, 0, Math.PI * 2);

        } else if (geology === 'hard_rock') {
            // Diamond (rotated square)
            ctx.moveTo(x,          y - size);
            ctx.lineTo(x + size,   y);
            ctx.lineTo(x,          y + size);
            ctx.lineTo(x - size,   y);
            ctx.closePath();

        } else {
            // Triangle (sand & gravel + fallback)
            ctx.moveTo(x,                   y - size);
            ctx.lineTo(x + size * 0.866,    y + size * 0.5);
            ctx.lineTo(x - size * 0.866,    y + size * 0.5);
            ctx.closePath();
        }

        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
});

const AggsMarker = L.CircleMarker.extend({
    _updatePath() {
        this._renderer._drawAggsMarker(this);
    }
});

// ============================================================
// MAP SETUP
// ============================================================

const map = L.map('map', { preferCanvas: true })
    .setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18
}).addTo(map);

const renderer = L.canvas({ padding: 0.5 });

// ============================================================
// DATA LOADING & MARKER CREATION
// ============================================================
// AggsData is the global variable injected by AggsData.geojson

const features   = AggsData.features;
const markerData = [];           // flat array used by update loop

console.log(`Loading ${features.length} features from AggsData.geojson`);

features.forEach(feature => {
    const props      = feature.properties;
    const [lon, lat] = feature.geometry.coordinates;

    const name       = props[FIELDS.name];
    const producer   = props[FIELDS.producer];
    const operator   = props[FIELDS.operator];
    const sic        = props[FIELDS.sic];
    const production = props[FIELDS.production] ?? 0;
    const geology    = getGeology(props);
    const baseSize   = getBaseSize(production);
    const color      = getProducerColor(producer);

    const marker = new AggsMarker([lat, lon], {
        renderer,
        radius:      baseSize,
        fillColor:   color,
        fillOpacity: 0.85,
        geology,
        // stroke handled directly in _drawAggsMarker
        stroke: false
    });

    // Build popup once at creation time (not on every click)
    const geologyLabel = GEOLOGY_LABELS[geology] ?? geology;
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

    marker.addTo(map);

    // Store lightweight reference for the update loop
    markerData.push({ marker, producer, production, lat, lon, baseSize });
});

console.log(`Placed ${markerData.length} markers`);

// ============================================================
// ZOOM-RESPONSIVE SIZING & LABELS
// ============================================================

// Label overlay div — sits above the Leaflet canvas, pointer-events off
const labelPane = Object.assign(L.DomUtil.create('div'), {
    style: 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:400;'
});
map.getContainer().appendChild(labelPane);

function updateMarkersAndLabels() {
    const zoom     = map.getZoom();
    const zoomDiff = zoom - INITIAL_VIEW.zoom;
    const scale    = Math.pow(1.5, zoomDiff);   // exponential growth with zoom
    const bounds   = map.getBounds();

    // Recolor: find which named producers are visible in the current viewport
    const viewTotals = {};
    markerData.forEach(({ producer, production, lat, lon }) => {
        if (bounds.contains([lat, lon])) {
            viewTotals[producer] = (viewTotals[producer] ?? 0) + production;
        }
    });
    const topInView = new Set(
        Object.entries(viewTotals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([name]) => name)
    );

    // Apply new size and color to every marker
    markerData.forEach(({ marker, producer, baseSize }) => {
        marker.setRadius(baseSize * scale);
        const color = (PRODUCER_COLORS[producer] && topInView.has(producer))
            ? PRODUCER_COLORS[producer]
            : OTHER_COLOR;
        marker.setStyle({ fillColor: color });
    });

    // Labels — only rendered when zoomed in
    labelPane.innerHTML = '';
    if (zoom < LABEL_MIN_ZOOM) return;

    const maxLabels = zoom >= 10 ? LABEL_LIMITS.detailed : LABEL_LIMITS.default;

    markerData
        .filter(d => bounds.contains([d.lat, d.lon]) && d.production >= LABEL_MIN_PROD)
        .sort((a, b) => b.production - a.production)
        .slice(0, maxLabels)
        .forEach(({ lat, lon, producer }) => {
            const pt  = map.latLngToContainerPoint([lat, lon]);
            const lbl = document.createElement('div');
            lbl.className   = 'marker-label';
            lbl.textContent = producer;
            Object.assign(lbl.style, {
                position:   'absolute',
                left:       `${pt.x + 8}px`,
                top:        `${pt.y - 6}px`,
                fontSize:   '11px',
                fontWeight: '600',
                color:      '#222',
                textShadow: '1px 1px 2px #fff,-1px -1px 2px #fff,1px -1px 2px #fff,-1px 1px 2px #fff',
                whiteSpace: 'nowrap',
                pointerEvents: 'none'
            });
            labelPane.appendChild(lbl);
        });
}

map.on('zoomend moveend', updateMarkersAndLabels);
updateMarkersAndLabels();

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

    if (geology === 'limestone') {
        ctx.arc(cx, cy, size, 0, Math.PI * 2);
    } else if (geology === 'hard_rock') {
        ctx.moveTo(cx,        cy - size);
        ctx.lineTo(cx + size, cy);
        ctx.lineTo(cx,        cy + size);
        ctx.lineTo(cx - size, cy);
        ctx.closePath();
    } else {
        ctx.moveTo(cx,                 cy - size);
        ctx.lineTo(cx + size * 0.866,  cy + size * 0.5);
        ctx.lineTo(cx - size * 0.866,  cy + size * 0.5);
        ctx.closePath();
    }

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
    row.append(sym, txt);
    return row;
}

const legend = L.control({ position: 'topright' });

legend.onAdd = function () {
    const container = L.DomUtil.create('div', 'legend-container');

    // Toggle button
    const btn = L.DomUtil.create('button', 'legend-toggle', container);
    btn.innerHTML = '☰ Legend';
    btn.style.cssText = [
        'background:white', 'border:2px solid rgba(0,0,0,0.2)',
        'border-radius:4px', 'padding:8px 12px', 'cursor:pointer',
        'font-size:14px', 'font-weight:600', 'box-shadow:0 1px 5px rgba(0,0,0,0.4)',
        'display:block', 'width:100%'
    ].join(';');

    // Content panel
    const panel = L.DomUtil.create('div', 'legend', container);
    panel.style.display = 'none';

    // --- Geology types ---
    const h1 = document.createElement('h4');
    h1.textContent = 'Geology Type';
    panel.appendChild(h1);

    const sec1 = document.createElement('div');
    sec1.className = 'legend-section';
    [
        { geology: 'limestone',   label: 'Limestone'     },
        { geology: 'hard_rock',   label: 'Hard Rock'     },
        { geology: 'sand_gravel', label: 'Sand & Gravel' }
    ].forEach(({ geology, label }) => {
        sec1.appendChild(legendRow(makeSymbolCanvas(geology, '#666'), label));
    });
    panel.appendChild(sec1);

    // --- Production sizes ---
    const h2 = document.createElement('h4');
    h2.textContent = 'Annual Production';
    h2.style.marginTop = '10px';
    panel.appendChild(h2);

    const sec2 = document.createElement('div');
    sec2.className = 'legend-section';
    [
        { label: '< 100K tons',      size: SIZE_BUCKETS[0].size },
        { label: '100K – 250K tons', size: SIZE_BUCKETS[1].size },
        { label: '250K – 500K tons', size: SIZE_BUCKETS[2].size },
        { label: '500K – 1.5M tons', size: SIZE_BUCKETS[3].size },
        { label: '> 1.5M tons',      size: SIZE_BUCKETS[4].size }
    ].forEach(({ label, size }) => {
        sec2.appendChild(legendRow(makeSymbolCanvas('limestone', '#666', size * 0.65), label));
    });
    panel.appendChild(sec2);

    // --- Top producers ---
    const h3 = document.createElement('h4');
    h3.textContent = 'Top Producers';
    h3.style.marginTop = '10px';
    panel.appendChild(h3);

    const sec3 = document.createElement('div');
    sec3.className = 'legend-section';
    Object.entries(PRODUCER_COLORS).forEach(([name, color]) => {
        sec3.appendChild(legendRow(makeSymbolCanvas('limestone', color), name));
    });
    sec3.appendChild(legendRow(makeSymbolCanvas('limestone', OTHER_COLOR), 'All Other Producers'));
    panel.appendChild(sec3);

    // Toggle
    btn.addEventListener('click', () => {
        const hidden = panel.style.display === 'none';
        panel.style.display = hidden ? 'block' : 'none';
        btn.innerHTML = hidden ? '✕ Legend' : '☰ Legend';
    });

    return container;
};

legend.addTo(map);

console.log('Map initialized successfully');

   // ... rest of your existing map.js code goes inside here
}
