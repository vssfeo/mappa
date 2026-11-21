**Mappa 1.33 is out** — a Linux-first offline map workstation built with Rust, Tauri and MapLibre. Apache-2.0.

It is made for four workflows:

- **Field survey:** signed MBTiles/PMTiles packs, LAN/QR distribution, SK-42/MSK and UTM/MGRS, DEM and contours, scan georeferencing by GCP, CLI for repeatable pack builds.
- **Drone planning:** waypoints and polygon grid, corridor as an inclusion geofence, elevation from DEM and min AGL, export to QGC `.plan`, DJI WPML KMZ and MAVLink WPL 110. Telemetry is read-only.
- **SAR and volunteer teams:** offline packs, GPS/NMEA tracks, Fresnel-zone LOS, field mode, PDF/GPX, no account and no cloud.
- **Linux users leaving SAS.Planet or Avenza:** native AppImage/deb, own XYZ/WMS/WMTS sources, no Wine.

New in 1.33: MQTT JSON fixes, DJI WPML KMZ export, MAVLink WPL 110, and corridor geofence polygons for QGC plans.

Download: https://github.com/vssfeo/mappa/releases/latest — AppImage 86 MB, deb 11 MB, Windows beta 9 MB.

Limits worth knowing: no mobile app, no GeoPDF import, and Mappa does not control the aircraft — QGC or the autopilot does.

If you work in the field, fly survey missions, run SAR maps, or just want SAS.Planet without Wine: try it and tell me what breaks first. Issues are open, and I am looking for 3–5 teams per workflow to test a real scenario.
