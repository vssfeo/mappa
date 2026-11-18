# CRS reference sources

## ziminskoe-msk90.csv

Official boundary points from the Ziminskoe rural settlement general plan
(Раздольненский район, Republic of Crimea), appendix to decision
No. 1427-2/23 of 2023-12-20.

- CRS: **МСК-90**, zone 1 (`lon_0=32.5`, `x_0=4300000`, `y_0=-9214.692`)
- 18 points, cartometric method, stated accuracy 0.10 m
- source PDF SHA-256: `14d6e3830fe1ac49a304f736a837b5611e4bcfa3baf7fdd0cca65d97946ce1eb`
- source: https://avangardpress.ru/wp-content/uploads/2023/12/1427-%D0%9E-%D0%B2%D0%BD%D0%B5%D1%81%D0%B5%D0%BD%D0%B8%D0%B8-%D0%B8%D0%B7%D0%BC%D0%B5%D0%BD%D0%B5%D0%BD%D0%B8%D0%B9-%D0%B2-%D1%80%D0%B5%D1%88%D0%B5%D0%BD%D0%B8%D0%B5-%D0%93%D0%9F-%D0%97%D0%B8%D0%BC%D0%B8%D0%BD%D1%81%D0%BA%D0%BE%D0%B5-%D1%81%D0%BF-%D1%81-%D0%BF%D1%80%D0%B8%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D0%B5%D0%BC.pdf

This is **not** a WGS84 pair and not a cadastral extract. It is a verified
MSK-90 input for a future silver dataset. Do not use it as a legal source.

### Pairing notes

- The 18 points do not match the OpenStreetMap `Зиминское сельское поселение`
  boundary (nearest segments are 0.9-1.7 km away), so this is a different
  object, likely a territorial/land boundary rather than the settlement outline.
- An NSPD point query at the polygon centroid returned no land parcel.
- Next step: find the cadastral number for this object or use a Trimble JXL
  with both WGS84 and MSK-90.

## Projection controls

The rows in [projection-controls.yaml](../projection-controls.yaml) use geographic
Pulkovo 1942 (EPSG:4284) latitude/longitude in degrees, then northing/easting in
metres. Mappa's API accepts longitude/latitude and easting/northing.

- For the six MSK-90 rows, the reference projections are EPSG:7828 (CS63 X4)
  and EPSG:7829 (CS63 X5), respectively. Their conversion records explicitly
  give the equivalent equatorial origin with false northing −9214.692 m.
  Reproduce a row with pyproj 3.7.1 / PROJ 9.6.0 using
  `Transformer.from_crs(4284, code, always_xy=True).transform(lon, lat)`.
  These are calculated checks of the projection parameters. Field accuracy
  and official equivalence of the regional systems require independent surveys.
  [EPSG conversion records in PROJ](https://github.com/OSGeo/PROJ/blob/5e7a7e024969d9de9e03991a2a9585df833a1f43/data/sql/conversion.sql#L1471)
- The five numbered Gauss–Krüger zones come from Sergey Fetisov's published
  test table (2023, [MIT](fetisov-geodesy-LICENSE.txt)). Independent projection with EPSG:4284 as input
  reproduced the published values within approximately 1 mm per axis.
  [Source table](https://github.com/fetisov/geodesy/blob/114c3e5db303343032e2c044b5130b5270321354/testbench.c#L71)
- The Ziminskoe cross-projection test uses point 1 from the CSV above.
  Transforming its easting/northing from EPSG:7828 to EPSG:28406 with
  `always_xy=True` gives 6541168.76 m east, 5050702.21 m north.
  Only the MSK-90 coordinates are from the boundary document.

The centimetre-level projection test tolerances cover numerical differences
and rounding in the tables. They describe agreement between implementations.

## Datum transformation controls

Mappa uses the EPSG:5044 transformation from Pulkovo 1942 to WGS 84.
The EPSG coordinate-frame rotations are negated when expressed as PROJ
position-vector rotations in `+towgs84`. The Moscow WGS 84 reference in the
unit tests was computed by projecting (37.6173° E, 55.7558° N, height 0 m)
with that operation and Gauss–Krüger zone 7.
[EPSG:5044](https://epsg.io/5044)

The PHOTOMOD GeoCalculator example uses GOST 32453-2017. Its published
geocentric Cartesian coordinates (X, Y, Z in metres) are:

| Datum | X | Y | Z |
|---|---:|---:|---:|
| SK-42 | 2849849.364 | 2196061.234 | 5249170.796 |
| WGS 84 | 2849872.803 | 2195930.716 | 5249085.005 |

To reproduce the two geographic coordinates used by the horizontal test,
apply the inverse PROJ Cartesian conversion separately to each triple:
`+proj=pipeline +step +inv +proj=cart +ellps=krass +step +proj=unitconvert +xy_in=rad +xy_out=deg`
for SK-42, substituting `+ellps=WGS84` for WGS 84. This step uses no datum
shift. The test compares the resulting longitude and latitude through Mappa's
2D API. Its tolerance of 0.000001° per axis accommodates the different
published operations and the API's zero-height convention at this point.
[PHOTOMOD reference triples](https://github.com/fetisov/geodesy/blob/114c3e5db303343032e2c044b5130b5270321354/testbench.c#L447)

The antimeridian test uses both geographic SK-42 inputs and the rounded
WGS 84 output from [PROJ's EPSG:5044 regression](https://github.com/OSGeo/PROJ/blob/5e7a7e024969d9de9e03991a2a9585df833a1f43/test/cli/test_cs2cs_various.yaml#L1165).
