/** Mission export: QGroundControl `.plan`, KML and KMZ from waypoints. */

import { createStoredZip } from './zip.ts'

export interface MissionPoint {
  name: string
  lon: number
  lat: number
  /** Altitude in metres, interpreted by `mode`. */
  alt: number
}

export interface MissionOptions {
  name?: string
  mode?: 'agl' | 'asl'
  cruiseSpeed?: number
  /** Inclusion circle around the home point. */
  geofenceRadiusM?: number
}

const round = (value: number, digits = 7) =>
  Number(value.toFixed(digits))

const escapeXml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/** MAVLink frame: 3 = global relative altitude, 0 = global (ASL). */
const frameFor = (mode: 'agl' | 'asl') => (mode === 'agl' ? 3 : 0)

/** QGroundControl plan altitude mode: 1 = relative (AGL), 0 = absolute. */
const altitudeModeFor = (mode: 'agl' | 'asl') => (mode === 'agl' ? 1 : 0)

/**
 * Builds a QGC `.plan` file: takeoff, one NAV_WAYPOINT per point, and RTL.
 * See `PlanView` in QGroundControl for the schema.
 */
export function qgcPlan(
  points: MissionPoint[],
  options: MissionOptions = {},
): string {
  if (points.length === 0) {
    throw new Error('a mission needs at least one waypoint')
  }
  const mode = options.mode ?? 'agl'
  const frame = frameFor(mode)
  const altitudeMode = altitudeModeFor(mode)
  const home = points[0]
  const items: unknown[] = []
  let sequence = 1

  items.push({
    AMSLAltAboveTerrain: null,
    Altitude: points[0].alt,
    AltitudeMode: altitudeMode,
    autoContinue: true,
    command: 22, // MAV_CMD_NAV_TAKEOFF
    doJumpId: sequence++,
    frame,
    params: [0, 0, 0, null, home.lat, home.lon, points[0].alt],
    type: 'SimpleItem',
  })
  for (const point of points) {
    items.push({
      AMSLAltAboveTerrain: null,
      Altitude: point.alt,
      AltitudeMode: altitudeMode,
      autoContinue: true,
      command: 16, // MAV_CMD_NAV_WAYPOINT
      doJumpId: sequence++,
      frame,
      params: [0, 0, 0, null, round(point.lat), round(point.lon), point.alt],
      type: 'SimpleItem',
    })
  }
  const last = points[points.length - 1]
  items.push({
    AMSLAltAboveTerrain: null,
    Altitude: last.alt,
    AltitudeMode: altitudeMode,
    autoContinue: true,
    command: 20, // MAV_CMD_NAV_RETURN_TO_LAUNCH
    doJumpId: sequence++,
    frame,
    params: [0, 0, 0, null, 0, 0, 0],
    type: 'SimpleItem',
  })

  return JSON.stringify(
    {
      fileType: 'Plan',
      geoFence: {
        circles:
          options.geofenceRadiusM && options.geofenceRadiusM > 0
            ? [
                {
                  circle: {
                    center: [round(home.lat), round(home.lon)],
                    radius: options.geofenceRadiusM,
                  },
                  inclusion: true,
                  version: 1,
                },
              ]
            : [],
        polygons: [],
        version: 2,
      },
      groundStation: 'Mappa',
      mission: {
        cruiseSpeed: options.cruiseSpeed ?? 15,
        firmwareType: 12, // PX4
        globalPlanAltitudeMode: altitudeMode,
        hoverSpeed: 5,
        items,
        plannedHomePosition: [round(home.lat), round(home.lon), home.alt],
        vehicleType: 2, // multirotor
        version: 2,
      },
      rallyPoints: { points: [], version: 2 },
      version: 1,
    },
    null,
    2,
  )
}

/** KML with a flight line and one placemark per waypoint. */
export function missionKml(
  points: MissionPoint[],
  name = 'Mappa mission',
  mode: 'agl' | 'asl' = 'agl',
): string {
  if (points.length === 0) {
    throw new Error('a mission needs at least one waypoint')
  }
  const altitudeMode = mode === 'agl' ? 'relativeToGround' : 'absolute'
  const coordinates = points
    .map((point) => `${round(point.lon)},${round(point.lat)},${point.alt}`)
    .join(' ')
  const placemarks = points
    .map(
      (point, index) => `    <Placemark>
      <name>${escapeXml(point.name || `WP ${index + 1}`)}</name>
      <Point>
        <altitudeMode>${altitudeMode}</altitudeMode>
        <coordinates>${round(point.lon)},${round(point.lat)},${point.alt}</coordinates>
      </Point>
    </Placemark>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(name)}</name>
    <Style id="route">
      <LineStyle>
        <color>ff457aff</color>
        <width>2</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>${escapeXml(name)}</name>
      <styleUrl>#route</styleUrl>
      <LineString>
        <altitudeMode>${altitudeMode}</altitudeMode>
        <coordinates>${coordinates}</coordinates>
      </LineString>
    </Placemark>
${placemarks}
  </Document>
</kml>
`
}

/** KMZ: the KML above packed as `doc.kml`. */
export function missionKmz(
  points: MissionPoint[],
  name = 'Mappa mission',
  mode: 'agl' | 'asl' = 'agl',
): Uint8Array {
  const kml = missionKml(points, name, mode)
  return createStoredZip([
    { name: 'doc.kml', data: new TextEncoder().encode(kml) },
  ])
}


/**
 * Lawnmower survey: parallel lines inside a polygon, spaced `spacingM`
 * apart, alternating direction. Coordinates are WGS84; the local metric
 * frame uses an equirectangular approximation around the centroid, which is
 * accurate enough for fields under a few kilometres.
 */
export function surveyWaypoints(
  polygon: [number, number][],
  spacingM: number,
  angleDeg = 0,
): [number, number][] {
  if (polygon.length < 3) return []
  if (!(spacingM > 0.5)) throw new Error('spacing must be positive')
  const ring =
    polygon[0][0] === polygon[polygon.length - 1][0] &&
    polygon[0][1] === polygon[polygon.length - 1][1]
      ? polygon.slice(0, -1)
      : polygon.slice()
  if (ring.length < 3) return []

  const lon0 = ring.reduce((sum, point) => sum + point[0], 0) / ring.length
  const lat0 = ring.reduce((sum, point) => sum + point[1], 0) / ring.length
  const metresPerDegreeLat = 111_320
  const metresPerDegreeLon = 111_320 * Math.cos((lat0 * Math.PI) / 180)
  const angle = (angleDeg * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const toLocal = ([lon, lat]: [number, number]): [number, number] => {
    const x = (lon - lon0) * metresPerDegreeLon
    const y = (lat - lat0) * metresPerDegreeLat
    return [x * cos + y * sin, -x * sin + y * cos]
  }
  const fromLocal = ([x, y]: [number, number]): [number, number] => {
    const rx = x * cos - y * sin
    const ry = x * sin + y * cos
    return [lon0 + rx / metresPerDegreeLon, lat0 + ry / metresPerDegreeLat]
  }

  const local = ring.map(toLocal)
  const minY = Math.min(...local.map((point) => point[1]))
  const maxY = Math.max(...local.map((point) => point[1]))
  const waypoints: [number, number][] = []
  let flipped = false
  for (let y = minY + spacingM / 2; y <= maxY; y += spacingM) {
    const crossings: number[] = []
    for (let index = 0; index < local.length; index += 1) {
      const [x1, y1] = local[index]
      const [x2, y2] = local[(index + 1) % local.length]
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1))
      }
    }
    crossings.sort((a, b) => a - b)
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const left = crossings[index]
      const right = crossings[index + 1]
      if (right - left < 1) continue
      const pair: [number, number][] = [
        [left, y],
        [right, y],
      ]
      if (flipped) pair.reverse()
      waypoints.push(...pair.map(fromLocal))
    }
    flipped = !flipped
  }
  return waypoints
}
