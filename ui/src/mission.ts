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
      geoFence: { circles: [], polygons: [], version: 2 },
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
