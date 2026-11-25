"""Fetch the EA LIDAR Composite DTM (1 m) for the Malvern Hills.

By default this keeps the native 1 m resolution; pass --res 5 (or similar) for a
server-side resampled copy.

The ArcGIS ImageServer URL in the original brief no longer resolves, so this uses
the Environment Agency WCS 2.0 endpoint for the same dataset. Large requests time
out at the gateway, so the area is fetched in tiles and mosaicked locally.

Usage: python scripts/fetch_dtm.py [--res 1] [--out data/dtm_1m.tif]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import time
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

DATASET = "13787b9a-26a4-4775-8523-806d13af58fc"
COVERAGE = f"{DATASET}__Lidar_Composite_Elevation_DTM_1m"
WCS = f"https://environment.data.gov.uk/geoservices/datasets/{DATASET}/wcs"

# British National Grid (EPSG:27700) extent: Chase End Hill (S) to End Hill (N),
# Severn side (E) to Herefordshire side (W), with a margin.
E_MIN, E_MAX = 369_000, 386_000
N_MIN, N_MAX = 233_000, 250_000
TILE = 2_000   # metres per request; larger requests time out at the gateway


def read_tiff(data: bytes) -> np.ndarray:
    with rasterio.MemoryFile(io.BytesIO(data)) as mem, mem.open() as ds:
        arr = ds.read(1).astype("float32")
        if ds.nodata is not None:
            arr[arr == ds.nodata] = np.nan
    arr[arr < -100] = np.nan
    return arr


def fetch_tile(e0: int, n0: int, res: float, cache: Path, retries: int = 8) -> tuple[int, int, np.ndarray]:
    """Fetch one tile, caching it on disk so an interrupted run can resume."""
    cached = cache / f"{e0}_{n0}.tif"
    if cached.exists():
        return e0, n0, read_tiff(cached.read_bytes())
    e1, n1 = min(e0 + TILE, E_MAX), min(n0 + TILE, N_MAX)
    url = (
        f"{WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId={COVERAGE}"
        f"&format=image/tiff&subset=E({e0},{e1})&subset=N({n0},{n1})"
        + (f"&SCALEFACTOR={1 / res}" if res != 1 else "")
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                data = r.read()
            arr = read_tiff(data)
            cache.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(data)
            return e0, n0, arr
        except Exception as exc:  # noqa: BLE001
            if attempt == retries - 1:
                raise RuntimeError(f"tile {e0},{n0} failed: {exc}") from exc
            # Back off harder when the server says we are rate limited.
            time.sleep((20 if "429" in str(exc) else 3) * (attempt + 1))
    raise AssertionError


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--res", type=float, default=1.0, help="metres per cell (1 = native)")
    ap.add_argument("--out", help="output GeoTIFF (default data/dtm_<res>m.tif)")
    args = ap.parse_args()
    res = args.res
    tag = f"{res:g}m"
    cache = Path(f"data/tiles_{tag}")
    out = Path(args.out or f"data/dtm_{tag}.tif")

    width = int((E_MAX - E_MIN) / res)
    height = int((N_MAX - N_MIN) / res)
    mosaic = np.full((height, width), np.nan, dtype="float32")

    jobs = [(e, n) for e in range(E_MIN, E_MAX, TILE) for n in range(N_MIN, N_MAX, TILE)]
    with cf.ThreadPoolExecutor(max_workers=2) as pool:
        for i, (e0, n0, arr) in enumerate(pool.map(lambda j: fetch_tile(*j, res, cache), jobs), 1):
            col = int((e0 - E_MIN) / res)
            row = int((N_MAX - n0) / res) - arr.shape[0]
            mosaic[row : row + arr.shape[0], col : col + arr.shape[1]] = arr
            print(f"\r{i}/{len(jobs)} tiles", end="", flush=True)
    print()

    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out, "w", driver="GTiff", width=width, height=height, count=1, dtype="float32",
        crs="EPSG:27700", transform=from_origin(E_MIN, N_MAX, res, res), nodata=np.nan,
        compress="deflate", predictor=3, tiled=True, blockxsize=512, blockysize=512,
        BIGTIFF="IF_SAFER",
    ) as dst:
        dst.write(mosaic, 1)
    print(f"wrote {out} ({width}x{height}, {np.isnan(mosaic).mean():.2%} nodata)")


if __name__ == "__main__":
    main()
