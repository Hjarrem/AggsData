# Data Summary

## Dataset Overview
- **Total Points:** 8,575 aggregate producer facilities
- **Data File Size:** 2.3 MB

## Geology Distribution
- **Limestone:** 1,933 facilities (22.5%)
- **Hard Rock:** 1,258 facilities (14.7%)
- **Sand & Gravel:** 5,384 facilities (62.8%)

## Production Range
- **Minimum:** 22 tons/year
- **Maximum:** 19,695,104 tons/year  
- **Average:** 345,384 tons/year

## Top 15 Producers (by total production)

| Rank | Producer | Total Production | Color |
|------|----------|------------------|-------|
| 1 | Vulcan Materials Company | 244,214,806 tons | #e41a1c (red) |
| 2 | CRH PLC | 175,716,794 tons | #377eb8 (blue) |
| 3 | Martin Marietta Materials Inc | 166,328,470 tons | #4daf4a (green) |
| 4 | Heidelberg Materials AG | 100,357,092 tons | #984ea3 (purple) |
| 5 | Amrize Ltd | 53,255,620 tons | #ff7f00 (orange) |
| 6 | Rogers Group Inc | 50,542,888 tons | #ffff33 (yellow) |
| 7 | Cemex S A | 43,230,462 tons | #a65628 (brown) |
| 8 | Carmeuse Holding SA | 38,170,990 tons | #f781bf (pink) |
| 9 | Summit Materials LLC | 37,870,074 tons | #d95f02 (dark orange) |
| 10 | Knife River Corporation | 29,862,910 tons | #7570b3 (lavender) |
| 11 | Specialty Granules LLC | 23,938,134 tons | #e7298a (magenta) |
| 12 | Charles S Luck IV | 23,136,608 tons | #66a61e (olive) |
| 13 | Arcosa, Inc | 22,893,552 tons | #e6ab02 (gold) |
| 14 | Atlas Energy Solutions Inc | 21,283,328 tons | #a6761d (tan) |
| 15 | Granite Construction Inc | 20,995,612 tons | #666666 (dark grey) |

**All other producers:** #cccccc (light grey)

## Data Fields Included

Each point contains:
- Facility name
- Producer (controller company)
- Operator company
- Geology type (limestone, hard_rock, or sand_gravel)
- Annual production (2025 estimate in tons)
- Latitude/Longitude coordinates
- SIC (Standard Industrial Classification) code

## Notes

- Colors have been set based on the top 15 producers by total aggregate production across all facilities
- Symbol shapes indicate geology type:
  - Circles = Limestone
  - Triangles = Hard Rock
  - Squares = Sand & Gravel
- Symbol sizes are scaled using square root to handle the wide production range (22 to 19.7M tons)
