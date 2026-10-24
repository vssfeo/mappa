import assert from 'node:assert/strict'
import test from 'node:test'

import { projectionFromWkt } from '../src/prj.ts'

const utm = `PROJCS["WGS_1984_UTM_Zone_37N",
  GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],
  PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],
  PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000],
  PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",39],
  PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0],
  UNIT["Meter",1],AUTHORITY["EPSG","32637"]]`

const pulkovo = `PROJCS["Pulkovo 1942 / Gauss-Kruger zone 7",
  GEOGCS["GCS_Pulkovo_1942",DATUM["D_Pulkovo_1942",SPHEROID["Krasovsky_1940",6378245,298.3]],
  PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],
  PROJECTION["Gauss_Kruger"],PARAMETER["False_Easting",7500000],
  PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",39],
  PARAMETER["Scale_Factor",1],PARAMETER["Latitude_Of_Origin",0],UNIT["Meter",1]]`

const lambert = `PROJCS["NAD83 / Conus Albers",
  GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS_1980",6378137,298.257222101]]],
  PROJECTION["Albers_Conic_Equal_Area"],PARAMETER["Standard_Parallel_1",29.5],
  PARAMETER["Standard_Parallel_2",45.5],PARAMETER["Latitude_Of_Origin",23],
  PARAMETER["Central_Meridian",-96],PARAMETER["False_Easting",0],
  PARAMETER["False_Northing",0],UNIT["Meter",1]]`

test('uses a root EPSG authority when present', () => {
  const projection = projectionFromWkt(utm)
  assert.deepEqual(projection?.spec, { epsg: 32637 })
  assert.match(projection?.label ?? '', /EPSG:32637/)
})

test('translates Gauss-Kruger WKT to proj4', () => {
  const projection = projectionFromWkt(pulkovo)
  assert.ok(projection?.spec.proj)
  const proj = projection?.spec.proj ?? ''
  assert.match(proj, /\+proj=tmerc/)
  assert.match(proj, /\+lon_0=39/)
  assert.match(proj, /\+x_0=7500000/)
  assert.match(proj, /\+ellps=krass/)
})

test('supports Lambert and Albers projections', () => {
  const projection = projectionFromWkt(lambert)
  assert.match(projection?.spec.proj ?? '', /\+proj=aea/)
  assert.match(projection?.spec.proj ?? '', /\+lat_1=29.5/)
  assert.match(projection?.spec.proj ?? '', /\+lat_2=45.5/)
})

test('rejects unknown WKT', () => {
  assert.equal(projectionFromWkt('PROJCS["Mystery"]'), null)
  assert.equal(projectionFromWkt('not wkt at all'), null)
})
