// ============================================================
// config.js  —  AggsData.com shared configuration
//
// Loaded first. Exposes everything on window so map.js and
// delivery-mode.js can both consume it without an ES-module
// build step.
// ============================================================

// ── Field names in AggsData.geojson ──────────────────────────────────────────

const FIELDS = {
    name:       'CURRENT_MINE_NAME',
    producer:   'CURRENT_CONTROLLER_NAME',
    operator:   'CURRENT_OPERATOR_NAME',
    sic:        'PRIMARY_SIC',
    canvass:    'PRIMARY_CANVASS',
    production: 'Tons 2025',
    lat:        'LATITUDE',
    lon:        'LONGITUDE',
};

// ── SIC → geology key ─────────────────────────────────────────────────────────

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
    'Construction Sand and Gravel':  'sand_gravel',
};

// ── Geology display labels ────────────────────────────────────────────────────

const GEOLOGY_LABELS = {
    limestone:   'Limestone',
    hard_rock:   'Hard Rock',
    sand_gravel: 'Sand & Gravel',
};

// ── Named producer color palette ─────────────────────────────────────────────

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
    'Granite Construction Inc':      '#555555',
};

const OTHER_COLOR = '#bbbbbb';

// ── Product color palette (used by delivery-mode) ─────────────────────────────
//
// Matches the intel-mode legend in index.html.

const PRODUCT_COLORS = [
    { test: p => /limestone|calcite|dense.?grade|dga|ag.?lime|screening/i.test(p), color: '#e8a44a' },
    { test: p => /granite|hard.?rock|trap|ballast|rip.?rap/i.test(p),              color: '#7a6fa0' },
    { test: p => /sand|gravel/i.test(p),                                            color: '#6baa75' },
    { test: p => /recycled|rca|rap/i.test(p),                                       color: '#5b9cba' },
    { test: p => /basalt|quartzite/i.test(p),                                       color: '#c26060' },
];

const PRODUCT_COLOR_DEFAULT = '#aaa';

// ── Production size buckets ───────────────────────────────────────────────────

const SIZE_BUCKETS = [
    { min: 0,       size: 2  },
    { min: 100000,  size: 4  },
    { min: 250000,  size: 8  },
    { min: 500000,  size: 12 },
    { min: 1500000, size: 16 },
];

// ── Map view defaults ─────────────────────────────────────────────────────────

const INITIAL_VIEW = {
    center: [39.8283, -98.5795],
    zoom: 5,
};

// ── Label thresholds ──────────────────────────────────────────────────────────

const LABEL_MIN_ZOOM = 11;
const LABEL_MIN_PROD = 150000;
const LABEL_LIMITS   = { default: 15, detailed: 100 };

// ── Selection cap ─────────────────────────────────────────────────────────────

const MAX_SELECTION = 100;

// ── z-index registry ──────────────────────────────────────────────────────────
//
// Single place for every z-index in the app.
// CSS custom properties mirror these for values used in stylesheets.

const Z = {
    producersPane: 420,   // Leaflet canvas pane — producer markers
    labelsPane:    430,   // Leaflet divIcon label pane (pointer-events:none)
    intelPane:     450,   // Leaflet canvas pane — intel delivery dots + plants
    selectionBar:  1000,  // Fixed bottom bar
    modeToggle:    1000,  // Floating mode-toggle pill
    intelSidebar:  1050,  // Sliding right panel
};

// ── Delivery-mode config ──────────────────────────────────────────────────────

const DELIVERY_CONFIG = {
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

// ── Helpers consumed by both modules ─────────────────────────────────────────

function getGeology(props) {
    return SIC_TO_GEOLOGY[props[FIELDS.sic]] || 'hard_rock';
}

function getProducerColor(name) {
    return PRODUCER_COLORS[name] || OTHER_COLOR;
}

function getProductColor(product) {
    const p = product || '';
    for (const entry of PRODUCT_COLORS) {
        if (entry.test(p)) return entry.color;
    }
    return PRODUCT_COLOR_DEFAULT;
}

function getBaseSize(production) {
    for (let i = SIZE_BUCKETS.length - 1; i >= 0; i--) {
        if (production >= SIZE_BUCKETS[i].min) {
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
    if (num >= 1_000)     return Math.round(num / 1_000) + 'K';
    return num.toLocaleString();
}

// ── Shared geology-shape drawing ──────────────────────────────────────────────
//
// Single implementation used by:
//   • L.Canvas._drawAggsMarker  (map.js — live canvas renderer)
//   • makeSymbolCanvas()        (map.js — legend thumbnails)
//   • buildPlantLayer()         (delivery-mode.js — intel plant markers)
//
// Draws the current path onto `ctx` centered at (cx, cy) with radius `size`.
// Caller is responsible for beginPath() before and fill()/stroke() after.

function drawGeologyPath(ctx, geology, cx, cy, size) {
    if (geology === 'limestone') {
        ctx.arc(cx, cy, size, 0, Math.PI * 2);
    } else if (geology === 'hard_rock') {
        ctx.moveTo(cx,        cy - size);
        ctx.lineTo(cx + size, cy);
        ctx.lineTo(cx,        cy + size);
        ctx.lineTo(cx - size, cy);
        ctx.closePath();
    } else {
        // sand_gravel — upward triangle
        ctx.moveTo(cx,                cy - size);
        ctx.lineTo(cx + size * 0.866, cy + size * 0.5);
        ctx.lineTo(cx - size * 0.866, cy + size * 0.5);
        ctx.closePath();
    }
}

// ── geologyKey: string → geology constant ─────────────────────────────────────
//
// delivery-mode.js receives a free-text geology string from aggregate-plants.geojson
// rather than a SIC code, so it needs its own mapping. Centralised here so it
// stays in sync with SIC_TO_GEOLOGY above.

function geologyKey(str) {
    const g = (str || '').toLowerCase();
    if (/sand|gravel/.test(g))                                          return 'sand_gravel';
    if (/granite|basalt|trap|quartzite|hard/.test(g))                   return 'hard_rock';
    return 'limestone';
}

// ── Expose everything globally (no bundler) ───────────────────────────────────

Object.assign(window, {
    FIELDS, SIC_TO_GEOLOGY, GEOLOGY_LABELS,
    PRODUCER_COLORS, OTHER_COLOR,
    PRODUCT_COLORS, PRODUCT_COLOR_DEFAULT,
    SIZE_BUCKETS, INITIAL_VIEW,
    LABEL_MIN_ZOOM, LABEL_MIN_PROD, LABEL_LIMITS,
    MAX_SELECTION, Z, DELIVERY_CONFIG,
    getGeology, getProducerColor, getProductColor,
    getBaseSize, formatTons,
    drawGeologyPath, geologyKey,
});
