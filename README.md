# US Aggregate Producers Map

A custom Leaflet map for visualizing aggregate producer facilities across the United States with custom symbology based on geology type, production volume, and company.

## Features

- **Custom Canvas Rendering** - Efficient rendering of 5,000+ points without DOM overhead
- **Geology-Based Symbols**
  - Limestone: Circles
  - Hard Rock: Squares
  - Sand & Gravel: Triangles
- **Production-Scaled Sizing** - Symbol size reflects production volume using square root scaling
- **Color-Coded Producers** - Top producers get unique colors, others are grey
- **Interactive Popups** - Click any point for detailed facility information
- **Responsive Legend** - Shows geology types, size scale, and producer colors

## Getting Started

### Quick Start

1. Open `index.html` in a web browser - that's it!
2. The map will load with sample data

### Adding Your Data

1. Open `data.js`
2. Replace the sample `producerData` array with your actual data
3. Ensure your data matches this structure:

```javascript
var producerData = [
    {
        "name": "Facility Name",
        "producer": "Company Name",
        "geology": "limestone",        // or "hard_rock" or "sand_gravel"
        "production": 500000,          // numeric value
        "lat": 33.7490,               // latitude
        "lon": -84.3880,              // longitude
        "state": "GA",                // optional
        "county": "Fulton"            // optional
    },
    // ... more points
];
```

### Customizing Producer Colors

Open `map.js` and edit the `PRODUCER_COLORS` object at the top:

```javascript
const PRODUCER_COLORS = {
    'Your Producer Name': '#e41a1c',  // hex color
    'Another Producer': '#377eb8',
    // Add or remove producers as needed
};
```

### Customizing Data Field Names

If your data uses different field names, update `DATA_FIELDS` in `map.js`:

```javascript
const DATA_FIELDS = {
    name: 'your_name_field',
    producer: 'your_company_field',
    geology: 'your_geology_field',
    production: 'your_production_field',
    lat: 'your_latitude_field',
    lon: 'your_longitude_field'
};
```

### Other Customizations

All configuration is at the top of `map.js`:

- `MIN_SIZE` / `MAX_SIZE` - Control symbol size range (pixels)
- `OTHER_PRODUCER_COLOR` - Color for non-top producers
- `INITIAL_VIEW` - Map starting position and zoom level

## File Structure

```
aggregate-map/
├── index.html          # Main HTML file
├── map.js             # Map logic and configuration
├── data.js            # Your data (replace with actual data)
└── README.md          # This file
```

## Data Requirements

### Required Fields
- Facility name
- Producer/company name
- Geology type (must be: "limestone", "hard_rock", or "sand_gravel")
- Production value (numeric)
- Latitude (decimal degrees)
- Longitude (decimal degrees)

### Optional Fields
- State abbreviation
- County name
- Any other fields you want to display in popups

## Deployment

### Local Development
Simply open `index.html` in your browser - no server required!

### Web Hosting
Upload all files to any web host. The map uses CDN-hosted libraries (Leaflet) so no dependencies need to be installed.

### GitHub Pages
1. Push this folder to a GitHub repository
2. Enable GitHub Pages in repository settings
3. Your map will be live at `https://yourusername.github.io/repository-name/`

## Performance Notes

- Efficiently handles 5,000+ points using canvas rendering
- All points remain visible and interactive at all zoom levels
- No clustering required
- Smooth panning and zooming even with full dataset displayed

## Customizing Popup Content

Edit the popup content in `map.js` around line 200:

```javascript
var popupContent = '<div class="popup-content">' +
    '<strong>' + name + '</strong>' +
    '<div><b>Producer:</b> ' + producer + '</div>' +
    // Add more fields here
    '</div>';
```

## Browser Compatibility

Works in all modern browsers:
- Chrome
- Firefox
- Safari
- Edge

## License

Free to use and modify for your needs.

## Support

For issues or questions about the implementation, refer to:
- Leaflet documentation: https://leafletjs.com/
- Canvas API: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API
