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
