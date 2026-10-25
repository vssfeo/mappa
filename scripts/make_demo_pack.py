#!/usr/bin/env python3
"""Builds the synthetic demo pack shipped with Mappa.

The tiles are drawn procedurally (no third-party imagery), so the pack is
small, licence-free and works offline on the first run.  Re-run after changing
the style:

    python3 scripts/make_demo_pack.py assets/demo/demo.mbtiles

Requires Pillow only.
"""

from __future__ import annotations

import argparse
import io
import math
import sqlite3
from pathlib import Path

from PIL import Image

# Atlantic coast of Ireland, around Connemara and the Cliffs of Moher.
# A neutral coastline keeps the demo free of any real-world conflict.
WEST, SOUTH, EAST, NORTH = -10.00, 52.95, -9.45, 53.25
MIN_ZOOM, MAX_ZOOM = 10, 12
TILE = 256
NAME = "Ireland demo"


def lon_to_x(lon: float, zoom: int) -> float:
    return (lon + 180.0) / 360.0 * (1 << zoom)


def lat_to_y(lat: float, zoom: int) -> float:
    radians = math.radians(lat)
    return (
        (1.0 - math.asinh(math.tan(radians)) / math.pi) / 2.0 * (1 << zoom)
    )


def x_to_lon(x: float, zoom: int) -> float:
    return x / (1 << zoom) * 360.0 - 180.0


def y_to_lat(y: float, zoom: int) -> float:
    n = math.pi - 2.0 * math.pi * y / (1 << zoom)
    return math.degrees(math.atan(math.sinh(n)))


def shoreline(lat: float) -> float:
    """Longitude of the shore; the Atlantic lies to the west of it."""
    v = lat - 53.10
    return -9.80 + 0.020 * math.sin(v * 18.0) + 0.010 * math.sin(v * 55.0 + 1.1)


def _hash(ix: int, iy: int) -> float:
    n = ix * 374_761_393 + iy * 668_265_263
    n = (n ^ (n >> 13)) * 1_274_126_177
    return ((n ^ (n >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def _noise(x: float, y: float) -> float:
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    sx = fx * fx * (3.0 - 2.0 * fx)
    sy = fy * fy * (3.0 - 2.0 * fy)
    a = _hash(ix, iy)
    b = _hash(ix + 1, iy)
    c = _hash(ix, iy + 1)
    d = _hash(ix + 1, iy + 1)
    return a * (1 - sx) * (1 - sy) + b * sx * (1 - sy) + c * (1 - sx) * sy + d * sx * sy


def _fbm(lon: float, lat: float, octaves: int = 3) -> float:
    total = 0.0
    amplitude = 1.0
    frequency = 26.0
    norm = 0.0
    for _ in range(octaves):
        total += amplitude * _noise(lon * frequency, lat * frequency)
        norm += amplitude
        amplitude *= 0.55
        frequency *= 2.1
    return total / norm


def height(lon: float, lat: float) -> float:
    """Synthetic elevation in metres; the sea floor is negative."""
    shore = shoreline(lat)
    if lon < shore:
        return -max(0.0, (shore - lon) * 90000.0)
    inland_distance = lon - shore
    relief = max(0.0, _fbm(lon, lat) - 0.28)
    land = 20.0 + 900.0 * relief * relief
    inland = max(0.0, min(1.0, inland_distance / 0.35))
    inland = inland * inland * (3.0 - 2.0 * inland)
    land += 150.0 * inland
    # Cliffs: a ridge just inland from the shore.
    cliff = math.exp(-(((inland_distance - 0.03) / 0.025) ** 2))
    land += 90.0 * cliff
    return max(0.0, land)


LAND = (
    (8.0, (217, 200, 160)),
    (90.0, (134, 160, 106)),
    (260.0, (111, 143, 87)),
    (460.0, (125, 138, 78)),
    (700.0, (142, 132, 104)),
    (950.0, (162, 154, 134)),
    (1250.0, (186, 181, 170)),
    (1600.0, (230, 228, 222)),
)
SEA_SHALLOW = (90, 160, 180)
SEA_DEEP = (16, 58, 88)


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))  # type: ignore[return-value]


def metres_per_pixel(lat: float, zoom: int) -> float:
    return 156_543.03392 * math.cos(math.radians(lat)) / (1 << zoom)


def land_color(h: float) -> tuple[int, int, int]:
    previous = LAND[0]
    for limit, color in LAND[1:]:
        if h <= limit:
            span = limit - previous[0]
            t = 0.0 if span <= 0 else (h - previous[0]) / span
            return lerp(previous[1], color, max(0.0, min(1.0, t)))
        previous = (limit, color)
    return LAND[-1][1]


def contour_interval(zoom: int) -> float:
    return {10: 500.0, 11: 250.0, 12: 100.0, 13: 50.0}.get(zoom, 100.0)


def render_tile(zoom: int, x: int, y: int) -> Image.Image:
    interval = contour_interval(zoom)
    # Height grid with a one-pixel apron so gradients stay continuous across
    # tile borders.
    size = TILE + 2
    grid = [[0.0] * size for _ in range(size)]
    for row in range(size):
        lat = y_to_lat(y + (row - 0.5) / TILE, zoom)
        for column in range(size):
            lon = x_to_lon(x + (column - 0.5) / TILE, zoom)
            grid[row][column] = height(lon, lat)

    pixels = bytearray(TILE * TILE * 3)
    offset = 0
    for row in range(TILE):
        lat = y_to_lat(y + (row + 0.5) / TILE, zoom)
        metres = metres_per_pixel(lat, zoom)
        for column in range(TILE):
            h = grid[row + 1][column + 1]
            slope_x = (grid[row + 1][column + 2] - grid[row + 1][column]) / (2.0 * metres)
            slope_y = (grid[row][column + 1] - grid[row + 2][column + 1]) / (2.0 * metres)
            if h < 0.0:
                depth = min(1.0, -h / 900.0)
                color = lerp(SEA_SHALLOW, SEA_DEEP, depth**0.7)
                if -h < 60.0:
                    color = lerp(color, (222, 232, 226), (60.0 + h) / 60.0)
            else:
                color = land_color(h)
                if h < 6.0 and lon < shoreline(lat) + 0.012:
                    color = lerp((222, 205, 165), color, h / 6.0)
                slope = math.hypot(slope_x, slope_y)
                contour_width = max(0.0035, slope * metres * 1.15 / interval)
                band = (h % interval) / interval
                if h > interval * 0.5 and band < contour_width:
                    index_line = interval * 5.0
                    factor = 0.7 if (h % index_line) < index_line * contour_width * 1.5 else 0.84
                    color = tuple(int(c * factor) for c in color)  # type: ignore[assignment]
                # Vertical exaggeration keeps the relief readable at map scale.
                light = 0.98 - 1.5 * slope_x - 1.1 * slope_y
                light = max(0.58, min(1.24, light))
                color = tuple(min(255, int(c * light)) for c in color)  # type: ignore[assignment]
            pixels[offset] = color[0]
            pixels[offset + 1] = color[1]
            pixels[offset + 2] = color[2]
            offset += 3
    image = Image.frombytes("RGB", (TILE, TILE), bytes(pixels))
    return image.quantize(colors=96, method=Image.Quantize.MEDIANCUT)


def tiles(zoom: int):
    x0 = int(math.floor(lon_to_x(WEST, zoom)))
    x1 = int(math.floor(lon_to_x(EAST, zoom)))
    y0 = int(math.floor(lat_to_y(NORTH, zoom)))
    y1 = int(math.floor(lat_to_y(SOUTH, zoom)))
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            yield x, y


def build(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    database = sqlite3.connect(path)
    database.executescript(
        """
        CREATE TABLE metadata (name TEXT, value TEXT);
        CREATE TABLE tiles (
            zoom_level INTEGER,
            tile_column INTEGER,
            tile_row INTEGER,
            tile_data BLOB
        );
        CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
        """
    )
    metadata = {
        "name": NAME,
        "description": "Synthetic demo map generated by Mappa",
        "format": "png",
        "type": "basemap",
        "version": "1",
        "minzoom": str(MIN_ZOOM),
        "maxzoom": str(MAX_ZOOM),
        "bounds": f"{WEST},{SOUTH},{EAST},{NORTH}",
        "attribution": "Demo map generated by Mappa",
    }
    database.executemany(
        "INSERT INTO metadata (name, value) VALUES (?, ?)", metadata.items()
    )
    total = 0
    size = 0
    for zoom in range(MIN_ZOOM, MAX_ZOOM + 1):
        count = 0
        for x, y in tiles(zoom):
            image = render_tile(zoom, x, y)
            buffer = io.BytesIO()
            image.save(buffer, format="PNG", optimize=True)
            data = buffer.getvalue()
            database.execute(
                "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
                (zoom, x, (1 << zoom) - 1 - y, data),
            )
            count += 1
            total += 1
            size += len(data)
        print(f"z{zoom}: {count} tiles")
    database.commit()
    database.execute("VACUUM")
    database.close()
    print(f"{total} tiles, {size / 1024:.0f} KiB of PNG, {path.stat().st_size / 1024:.0f} KiB file")


def preview(zoom: int, output: Path) -> None:
    x0 = int(math.floor(lon_to_x(WEST, zoom)))
    x1 = int(math.floor(lon_to_x(EAST, zoom)))
    y0 = int(math.floor(lat_to_y(NORTH, zoom)))
    y1 = int(math.floor(lat_to_y(SOUTH, zoom)))
    width = (x1 - x0 + 1) * TILE
    height_px = (y1 - y0 + 1) * TILE
    canvas = Image.new("RGB", (width, height_px), (11, 15, 20))
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            tile = render_tile(zoom, x, y).convert("RGB")
            canvas.paste(tile, ((x - x0) * TILE, (y - y0) * TILE))
    canvas.save(output, optimize=True)
    print(f"preview {width}x{height_px} -> {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", nargs="?", default="assets/demo/demo.mbtiles")
    parser.add_argument("--preview", help="write a PNG mosaic instead of a pack")
    parser.add_argument("--zoom", type=int, default=11)
    arguments = parser.parse_args()
    if arguments.preview:
        preview(arguments.zoom, Path(arguments.preview))
    else:
        build(Path(arguments.output))
