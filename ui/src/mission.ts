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
  /** Inclusion polygons as WGS84 lon/lat rings. */
  geofencePolygons?: [number, number][][]
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

  const fencePolygons = (options.geofencePolygons ?? [])
    .filter((ring) => ring.length >= 3)
    .map((ring) => ({
      polygon: ring.map(([lon, lat]) => [round(lat), round(lon)]),
      inclusion: true,
      version: 1,
    }))

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
        polygons: fencePolygons,
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

export interface DjiMissionOptions extends MissionOptions {
  /** Speed in m/s written to both templates. */
  speed?: number
  /** ISO timestamp; fixed in tests so the archive is deterministic. */
  createdAt?: string
}

const WPML_NS = 'http://www.dji.com/wpmz/1.0.6'

const haversineM = (a: MissionPoint, b: MissionPoint): number => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

const wpmlMissionConfig = (speed: number, takeoffHeight: number): string => `    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>${takeoffHeight}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${speed}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>68</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>0</wpml:droneSubEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>`

const wpmlPoint = (point: MissionPoint, index: number, speed: number): string => `      <Placemark>
        <Point>
          <coordinates>${round(point.lon)},${round(point.lat)}</coordinates>
        </Point>
        <wpml:index>${index}</wpml:index>
        <wpml:executeHeight>${round(point.alt, 2)}</wpml:executeHeight>
        <wpml:waypointSpeed>${speed}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0,0,0</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>0</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0.2</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:useStraightLine>1</wpml:useStraightLine>
      </Placemark>`

/**
 * DJI WPML KMZ: `wpmz/template.kml` plus `wpmz/waylines.wpml`.
 * AGL maps to `relativeToStartPoint`, ASL to `absoluteAltitude`.
 */
export function djiKmz(
  points: MissionPoint[],
  options: DjiMissionOptions = {},
): Uint8Array {
  if (points.length === 0) {
    throw new Error('a mission needs at least one waypoint')
  }
  const mode = options.mode ?? 'agl'
  const speed = options.speed ?? options.cruiseSpeed ?? 15
  const heightMode = mode === 'agl' ? 'relativeToStartPoint' : 'absoluteAltitude'
  const createdAt = options.createdAt ?? new Date().toISOString()
  const height = round(points[0].alt, 2)
  const distance = points
    .slice(1)
    .reduce((sum, point, index) => sum + haversineM(points[index], point), 0)
  const duration = speed > 0 ? distance / speed : 0
  const pointsXml = points.map((point, index) => wpmlPoint(point, index, speed)).join('\n')

  const template = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${WPML_NS}">
  <Document>
    <wpml:author>Mappa</wpml:author>
    <wpml:createTime>${createdAt}</wpml:createTime>
    <wpml:updateTime>${createdAt}</wpml:updateTime>
${wpmlMissionConfig(speed, Math.max(20, height))}
    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>${heightMode}</wpml:heightMode>
        <wpml:globalShootHeight>${height}</wpml:globalShootHeight>
        <wpml:positioningType>GPS</wpml:positioningType>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${speed}</wpml:autoFlightSpeed>
      <wpml:globalHeight>${height}</wpml:globalHeight>
      <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
      <wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>
      <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>
${pointsXml}
    </Folder>
  </Document>
</kml>
`

  const waylines = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${WPML_NS}">
  <Document>
${wpmlMissionConfig(speed, Math.max(20, height))}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>${heightMode}</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>${distance.toFixed(1)}</wpml:distance>
      <wpml:duration>${duration.toFixed(1)}</wpml:duration>
      <wpml:autoFlightSpeed>${speed}</wpml:autoFlightSpeed>
${pointsXml}
    </Folder>
  </Document>
</kml>
`

  return createStoredZip([
    { name: 'wpmz/template.kml', data: new TextEncoder().encode(template) },
    { name: 'wpmz/waylines.wpml', data: new TextEncoder().encode(waylines) },
  ])
}


/**
 * Buffers an open polyline into a closed WGS84 ring `widthM` wide.
 * The local metric frame uses an equirectangular approximation around the
 * line centroid; good enough for corridors of a few kilometres.
 */
export function corridorPolygon(
  line: [number, number][],
  widthM: number,
): [number, number][] {
  if (line.length < 2 || !(widthM > 0)) return []
  const lon0 = line.reduce((sum, point) => sum + point[0], 0) / line.length
  const lat0 = line.reduce((sum, point) => sum + point[1], 0) / line.length
  const metresPerDegreeLat = 111_320
  const metresPerDegreeLon = 111_320 * Math.cos((lat0 * Math.PI) / 180)
  const local = line.map(([lon, lat]): [number, number] => [
    (lon - lon0) * metresPerDegreeLon,
    (lat - lat0) * metresPerDegreeLat,
  ])
  const half = widthM / 2
  const left: [number, number][] = []
  const right: [number, number][] = []
  for (let index = 0; index < local.length - 1; index += 1) {
    const [x1, y1] = local[index]
    const [x2, y2] = local[index + 1]
    const dx = x2 - x1
    const dy = y2 - y1
    const length = Math.hypot(dx, dy)
    if (length < 1e-9) continue
    const nx = (-dy / length) * half
    const ny = (dx / length) * half
    if (left.length === 0) {
      left.push([x1 + nx, y1 + ny])
      right.push([x1 - nx, y1 - ny])
    }
    left.push([x2 + nx, y2 + ny])
    right.push([x2 - nx, y2 - ny])
  }
  if (left.length < 2) return []
  const ring = [...left, ...right.reverse()]
  const toWgs = ([x, y]: [number, number]): [number, number] => [
    round(lon0 + x / metresPerDegreeLon),
    round(lat0 + y / metresPerDegreeLat),
  ]
  const closed = ring.map(toWgs)
  closed.push(closed[0])
  return closed
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
