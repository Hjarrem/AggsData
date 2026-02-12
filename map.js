// ============================================
// CONFIGURATION - CUSTOMIZE THESE VALUES
// ============================================

// Producer color mapping - Add/edit producers and their colors here
// Top 15 producers based on actual data (total production)
const PRODUCER_COLORS = {
    'Vulcan Materials Company': '#e41a1c',
    'CRH PLC': '#377eb8',
    'Martin Marietta Materials Inc': '#4daf4a',
    'Heidelberg Materials AG': '#984ea3',
    'Amrize Ltd': '#ff7f00',
    'Rogers Group Inc': '#ffff33',
    'Cemex S A': '#a65628',
    'Carmeuse Holding SA': '#f781bf',
    'Summit Materials LLC': '#d95f02',
    'Knife River Corporation': '#7570b3',
    'Specialty Granules LLC': '#e7298a',
    'Charles S  Luck IV': '#66a61e',
    'Arcosa, Inc': '#e6ab02',
    'Atlas Energy Solutions Inc': '#a6761d',
    'Granite Construction Inc': '#666666'
};

// Fallback color for producers not in the list above
const OTHER_PRODUCER_COLOR = '#cccccc';

// Symbol size range (in pixels)
const MIN_SIZE = 2;
const MAX_SIZE = 40;

// Size scaling method: 'sqrt' (gentle), 'log' (moderate), 'power' (dramatic)
const SIZE_SCALE_METHOD = 'power';

// Data field mapping - Update these if your data uses different field names
const DATA_FIELDS = {
    name: 'name',           // Facility name
    producer: 'producer',   // Company name (controller)
    geology: 'geology',     // Geology type
    production: 'production', // Production value
    lat: 'lat',            // Latitude
    lon: 'lon',            // Longitude
    operator: 'operator',  // Operator name (optional)
    sic: 'sic'            // SIC code (optional)
};

// Map initial view
const INITIAL_VIEW = {
    center: [39.8283, -98.5795], // Center of USA
    zoom: 5
};

// ============================================
// CANVAS LAYER IMPLEMENTATION
// ============================================

L.Canvas.include({
    _updateCustomLayer: function(layer) {
        if (!this._drawing || layer._empty()) { return; }
        
        var p = layer._point,
            ctx = this._ctx,
            size = layer.options.size || 5,
            geology = layer.options.geology,
            color = layer.options.color || '#3388ff';
        
        ctx.globalAlpha = layer.options.opacity || 1;
        ctx.fillStyle = color;
        ctx.strokeStyle = layer.options.stroke || '#333';
        ctx.lineWidth = layer.options.weight || 1;
        
        ctx.beginPath();
        
        // Draw different shapes based on geology
        if (geology === 'limestone') {
            // Circle
            ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        } else if (geology === 'hard_rock') {
            // Triangle
            ctx.moveTo(p.x, p.y - size);
            ctx.lineTo(p.x - size * 0.866, p.y + size * 0.5);
            ctx.lineTo(p.x + size * 0.866, p.y + size * 0.5);
            ctx.closePath();
        } else if (geology === 'sand_gravel') {
            // Square
            ctx.rect(p.x - size * 0.7, p.y - size * 0.7, size * 1.4, size * 1.4);
        } else {
            // Default to circle if geology type not recognized
            ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        }
        
        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
});

// Custom marker class
var CustomCanvasMarker = L.CircleMarker.extend({
    options: {
        renderer: null,
        size: 5,
        geology: 'limestone',
        color: '#3388ff',
        weight: 1,
        stroke: '#333',
        opacity: 0.8
    },
    
    _updatePath: function() {
        this._renderer._updateCustomLayer(this);
    }
});

// ============================================
// MAP INITIALIZATION
// ============================================

var map = L.map('map').setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);

// Add base map
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18
}).addTo(map);

// Create canvas renderer
var canvasRenderer = L.canvas({ padding: 0.5 });

// ============================================
// DATA PROCESSING
// ============================================

function getProducerColor(producerName) {
    return PRODUCER_COLORS[producerName] || OTHER_PRODUCER_COLOR;
}

function calculateSize(production, minProd, maxProd) {
    // Avoid issues with zero or very small values
    if (production <= 0) return MIN_SIZE;
    
    var normalized;
    
    if (SIZE_SCALE_METHOD === 'log') {
        // Logarithmic scale - good for wide ranges, more dramatic than sqrt
        // Add 1 to avoid log(0)
        normalized = Math.log(production + 1) / Math.log(maxProd + 1);
    } else if (SIZE_SCALE_METHOD === 'power') {
        // Power scale (exponent 0.4) - very dramatic differences
        normalized = Math.pow(production / maxProd, 0.4);
    } else {
        // Square root scale - default, more gentle
        normalized = Math.sqrt(production) / Math.sqrt(maxProd);
    }
    
    return MIN_SIZE + (normalized * (MAX_SIZE - MIN_SIZE));
}

function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(0) + 'K';
    }
    return num.toString();
}

// Calculate production range for scaling
var minProduction = Infinity;
var maxProduction = -Infinity;

producerData.forEach(function(point) {
    var prod = point[DATA_FIELDS.production];
    if (prod < minProduction) minProduction = prod;
    if (prod > maxProduction) maxProduction = prod;
});

console.log('Production range:', minProduction, 'to', maxProduction);
console.log('Total points:', producerData.length);

// ============================================
// ADD MARKERS TO MAP
// ============================================

var markers = [];

producerData.forEach(function(point) {
    var lat = point[DATA_FIELDS.lat];
    var lon = point[DATA_FIELDS.lon];
    var producer = point[DATA_FIELDS.producer];
    var geology = point[DATA_FIELDS.geology];
    var production = point[DATA_FIELDS.production];
    var name = point[DATA_FIELDS.name];
    
    var baseSize = calculateSize(production, minProduction, maxProduction);
    var zoomFactor = map.getZoom() / INITIAL_VIEW.zoom; // Scale with zoom
    var size = baseSize * zoomFactor;
    var color = getProducerColor(producer);
    
    var marker = new CustomCanvasMarker([lat, lon], {
        renderer: canvasRenderer,
        size: size,
        geology: geology,
        color: color,
        weight: 1,
        stroke: '#333',
        opacity: 0.85
    });
    
    // Create popup content
    var popupContent = '<div class="popup-content">' +
        '<strong>' + name + '</strong>' +
        '<div><b>Producer:</b> ' + producer + '</div>';
    
    // Add operator if different from producer
    if (point[DATA_FIELDS.operator] && point[DATA_FIELDS.operator] !== producer) {
        popupContent += '<div><b>Operator:</b> ' + point[DATA_FIELDS.operator] + '</div>';
    }
    
    popupContent += '<div><b>Geology:</b> ' + geology.replace('_', ' & ') + '</div>' +
        '<div><b>Production:</b> ' + formatNumber(production) + ' tons/year</div>';
    
    // Add SIC if available
    if (point[DATA_FIELDS.sic]) {
        popupContent += '<div><b>Type:</b> ' + point[DATA_FIELDS.sic] + '</div>';
    }
    
    popupContent += '</div>';
    
    marker.bindPopup(popupContent);
    marker.addTo(map);
    markers.push(marker);
});

console.log('Added', markers.length, 'markers to map');

// ============================================
// LEGEND
// ============================================

var legend = L.control({position: 'topright'});

legend.onAdd = function(map) {
    var div = L.DomUtil.create('div', 'legend');
    
    // Helper function to draw symbol on canvas
    function drawSymbol(geology, color, size) {
        var canvas = document.createElement('canvas');
        canvas.width = 30;
        canvas.height = 30;
        var ctx = canvas.getContext('2d');
        var centerX = 15;
        var centerY = 15;
        
        ctx.fillStyle = color;
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        
        ctx.beginPath();
        if (geology === 'limestone') {
            ctx.arc(centerX, centerY, size, 0, Math.PI * 2);
        } else if (geology === 'hard_rock') {
            ctx.moveTo(centerX, centerY - size);
            ctx.lineTo(centerX - size * 0.866, centerY + size * 0.5);
            ctx.lineTo(centerX + size * 0.866, centerY + size * 0.5);
            ctx.closePath();
        } else if (geology === 'sand_gravel') {
            ctx.rect(centerX - size * 0.7, centerY - size * 0.7, size * 1.4, size * 1.4);
        }
        ctx.fill();
        ctx.stroke();
        
        return canvas;
    }
    
    var html = '<h4>Geology Types</h4><div class="legend-section">';
    
    var geologyTypes = [
        {type: 'limestone', label: 'Limestone'},
        {type: 'hard_rock', label: 'Hard Rock'},
        {type: 'sand_gravel', label: 'Sand & Gravel'}
    ];
    
    geologyTypes.forEach(function(geo) {
        html += '<div class="legend-item">' +
            '<span class="legend-symbol"></span>' +
            '<span>' + geo.label + '</span>' +
            '</div>';
    });
    
    html += '</div><h4>Production Size</h4><div class="legend-section">';
    
    var sizeExamples = [
        {label: 'Small', value: minProduction},
        {label: 'Medium', value: (minProduction + maxProduction) / 2},
        {label: 'Large', value: maxProduction}
    ];
    
    sizeExamples.forEach(function(ex) {
        var size = calculateSize(ex.value, minProduction, maxProduction);
        html += '<div class="legend-item">' +
            '<span class="legend-symbol"></span>' +
            '<span>' + ex.label + ' (' + formatNumber(ex.value) + ')</span>' +
            '</div>';
    });
    
    html += '</div><h4>Top Producers</h4><div class="legend-section">';
    
    Object.keys(PRODUCER_COLORS).forEach(function(producer) {
        html += '<div class="legend-item">' +
            '<span class="legend-symbol"></span>' +
            '<span>' + producer + '</span>' +
            '</div>';
    });
    
    html += '<div class="legend-item">' +
        '<span class="legend-symbol"></span>' +
        '<span>Other Producers</span>' +
        '</div>';
    
    html += '</div>';
    
    div.innerHTML = html;
    
    // Add actual canvas symbols after DOM is created
    setTimeout(function() {
        var symbols = div.querySelectorAll('.legend-symbol');
        var idx = 0;
        
        // Geology symbols
        geologyTypes.forEach(function(geo) {
            symbols[idx].appendChild(drawSymbol(geo.type, '#666', 6));
            idx++;
        });
        
        // Size symbols
        sizeExamples.forEach(function(ex) {
            var size = calculateSize(ex.value, minProduction, maxProduction);
            symbols[idx].appendChild(drawSymbol('limestone', '#666', size));
            idx++;
        });
        
        // Producer colors
        Object.keys(PRODUCER_COLORS).forEach(function(producer) {
            symbols[idx].appendChild(drawSymbol('limestone', PRODUCER_COLORS[producer], 6));
            idx++;
        });
        
        // Other producers
        symbols[idx].appendChild(drawSymbol('limestone', OTHER_PRODUCER_COLOR, 6));
    }, 0);
    
    return div;
};

legend.addTo(map);

console.log('Map initialized successfully');
