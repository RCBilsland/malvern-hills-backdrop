"""Sample the LIDAR DTM along parallel lines for the 3D ridgeline view.

The lines cross the Malvern ridge at --angle degrees to the summit axis (45 by
default), are spaced --spacing metres apart, and are clipped to a disc of
--radius metres centred on the middle of the axis, so the view can orbit it.
Heights are sampled every --step metres along each line from the DTM,
downsampled to --res metres by block maximum, then smoothed along the line.

Output (in --out): ridges.json and ridges.js (the same data, for pages opened
from disk). Heights are true elevations in decimetres, packed as base64
little-endian uint16, one row per line; 65535 marks points outside the disc.

Usage: python scripts/build_ridges.py [--angle 45] [--spacing 200] [--step 20]
"""
from __future__ import annotations

import argparse
import base64
import json
import math
from pathlib import Path

import numpy as np

from build_layers import DEFAULT_AXIS, floats, gaussian_smooth, load_dtm

NODATA = 65535


def bilinear(z, cols_e, rows_n, e, n):
    """Sample grid z (rows run north to south) at points (e, n)."""
    cell = cols_e[1] - cols_e[0]
    fx = (e - cols_e[0]) / cell
    fy = (rows_n[0] - n) / cell
    x0 = np.clip(np.floor(fx).astype(int), 0, z.shape[1] - 2)
    y0 = np.clip(np.floor(fy).astype(int), 0, z.shape[0] - 2)
    tx = np.clip(fx - x0, 0, 1)
    ty = np.clip(fy - y0, 0, 1)
    a = z[y0, x0] * (1 - tx) + z[y0, x0 + 1] * tx
    b = z[y0 + 1, x0] * (1 - tx) + z[y0 + 1, x0 + 1] * tx
    return a * (1 - ty) + b * ty


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dtm", default="data/dtm_1m.tif")
    ap.add_argument("--res", type=float, default=5.0, help="working resolution in metres")
    ap.add_argument("--out", default="malvern-ridges/data")
    ap.add_argument("--axis", default=DEFAULT_AXIS, help="start E, start N, bearing (as build_layers)")
    ap.add_argument("--length", type=float, default=15000, help="axis length; the disc centres on its midpoint")
    ap.add_argument("--angle", type=float, default=45, help="angle of the lines to the axis, degrees clockwise")
    ap.add_argument("--radius", type=float, default=7400, help="radius of the disc, metres")
    ap.add_argument("--spacing", type=float, default=200, help="distance between lines, metres")
    ap.add_argument("--step", type=float, default=20, help="distance between samples along a line, metres")
    ap.add_argument("--smooth-m", type=float, default=30, help="Gaussian smoothing along each line, metres")
    args = ap.parse_args()

    e0, n0, axis_bearing = floats(args.axis)
    th = math.radians(axis_bearing)
    ce = e0 + args.length / 2 * math.sin(th)
    cn = n0 + args.length / 2 * math.cos(th)

    bearing = (axis_bearing + args.angle) % 360
    b = math.radians(bearing)
    ue, un = math.sin(b), math.cos(b)          # along each line
    ve, vn = math.cos(b), -math.sin(b)         # from one line to the next

    z, cell, cols_e, rows_n = load_dtm(args.dtm, args.res)
    print(f"DTM {z.shape[1]} x {z.shape[0]} at {cell:g} m")

    R = args.radius
    nlines = int(2 * R / args.spacing) + 1
    nsamp = int(2 * R / args.step) + 1
    v = -R + np.arange(nlines) * args.spacing
    u = -R + np.arange(nsamp) * args.step
    vv, uu = np.meshgrid(v, u, indexing="ij")
    inside = uu ** 2 + vv ** 2 <= R ** 2

    e = ce + uu * ue + vv * ve
    n = cn + uu * un + vv * vn
    h = bilinear(z, cols_e, rows_n, e, n)
    if np.isnan(h[inside]).any():
        raise SystemExit("the disc reaches beyond the DTM; reduce --radius")

    sigma = args.smooth_m / args.step
    for i in range(nlines):
        idx = np.flatnonzero(inside[i])
        if idx.size:
            h[i, idx] = gaussian_smooth(h[i, idx], sigma)

    lo, hi = float(np.min(h[inside])), float(np.max(h[inside]))
    packed = np.full(h.shape, NODATA, dtype="<u2")
    packed[inside] = np.clip(np.round(h[inside] * 10), 0, NODATA - 1).astype("<u2")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    data = {
        "source": "Environment Agency LIDAR Composite DTM 1 m (2022), OGL v3.0",
        "centre": {"easting": round(ce), "northing": round(cn)},
        "radius_m": R,
        "axis_bearing_deg": axis_bearing,
        "line_bearing_deg": round(bearing, 2),
        "line_spacing_m": args.spacing,
        "sample_step_m": args.step,
        "lines": nlines,
        "samples": nsamp,
        "min_m": round(lo, 1),
        "max_m": round(hi, 1),
        "units": "decimetres, uint16 little-endian, 65535 = outside the disc",
        "heights": base64.b64encode(packed.tobytes()).decode("ascii"),
    }
    text = json.dumps(data, separators=(",", ":"))
    (out / "ridges.json").write_text(text)
    (out / "ridges.js").write_text("window.MALVERN_RIDGES = " + text + ";\n")
    print(f"{nlines} lines x {nsamp} samples, bearing {bearing:.1f} deg, "
          f"{lo:.0f} to {hi:.0f} m, centre E {ce:.0f} N {cn:.0f}")
    print(f"wrote {out}/ridges.json ({len(text) / 1024:.0f} KB) and ridges.js")


if __name__ == "__main__":
    main()
