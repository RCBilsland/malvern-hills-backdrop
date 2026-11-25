"""Turn the LIDAR DTM into layered SVG silhouettes of the Malvern Hills.

Viewpoint: from the Severn valley, square on to the ridge axis, so facing a
bearing of about 275 degrees (just north of due west). Layers run from the nearest band (east) to the furthest (west, behind
the ridge).

Bands are straight strips parallel to an axis line fitted through the summits
(--axis). Each layer is the maximum elevation within its strip, sampled in
slices across the strip every --res metres along the axis. The horizontal axis
of the SVG is distance along that line, south on the left and north on the right.

Layers behind the ridge are lower than the crest, so in a true view they are
almost entirely hidden. --peek lifts each of them just enough that it shows
above the ridge along a chosen share of the width. Set --peek 0 for true heights.

The source DTM can be any resolution (the native 1 m file by default). It is
downsampled to --res metres by block maximum, so crests are kept.

Usage: python scripts/build_layers.py [--res 5] [--exaggeration 3] [--peek 0.15,0.3,0.45]
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from shapely.geometry import LineString

VIEW_W = 2000          # SVG user units across the full length of the axis
TOP_MARGIN = 20        # units of sky kept above the highest summit
BASE_H = 80            # solid fill below sea level (y = 0), so parallax never shows a gap
NEAR_COLOUR = (0x23, 0x30, 0x2c)   # deep green-grey in the foreground
FAR_COLOUR = (0xc4, 0xd0, 0xd8)    # pale blue-grey haze at the back

# Axis: least-squares line through 13 summits from the DTM, Chase End Hill to
# End Hill (see README). Easting at the southern end, northing there, bearing.
DEFAULT_AXIS = "375789,234000,5.1"


def gaussian_smooth(y: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return y
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    return np.convolve(np.pad(y, r, mode="edge"), k, mode="valid")


def mix(a, b, t: float) -> str:
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(a, b))


def floats(s: str) -> list[float]:
    return [float(v) for v in s.split(",") if v.strip()]


def load_dtm(path: str, res: float):
    """Read the DTM and downsample by block maximum to roughly `res` metres."""
    with rasterio.open(path) as ds:
        factor = max(1, round(res / ds.res[0]))
        shape = (ds.height // factor, ds.width // factor)
        full = ds.read(1, masked=True).filled(np.nan)
        full = full[: shape[0] * factor, : shape[1] * factor]
        with np.errstate(all="ignore"):
            z = np.nanmax(full.reshape(shape[0], factor, shape[1], factor), axis=(1, 3))
        cell = ds.res[0] * factor
        cols_e = ds.bounds.left + (np.arange(shape[1]) + 0.5) * cell
        rows_n = ds.bounds.top - (np.arange(shape[0]) + 0.5) * cell
    return z, cell, cols_e, rows_n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dtm", default="data/dtm_1m.tif")
    ap.add_argument("--res", type=float, default=5.0, help="working resolution in metres")
    ap.add_argument("--out", default="malvern-hills/layers")
    ap.add_argument("--axis", default=DEFAULT_AXIS,
                    help="easting,northing,bearing: start of the axis line and its grid bearing")
    ap.add_argument("--length", type=float, default=15_000, help="length of the axis in metres")
    ap.add_argument("--crest-half", type=float, default=500,
                    help="half-width of the crest band in metres")
    ap.add_argument("--front", default="500,900,1600,2800,5000",
                    help="band edges east of the axis, metres")
    ap.add_argument("--behind", default="500,1300,2700,5000",
                    help="band edges west of the axis, metres")
    ap.add_argument("--peek", default="0.15,0.3,0.45",
                    help="share of the width each behind-ridge layer shows above the ridge "
                         "(nearest first); 0 keeps true heights")
    ap.add_argument("--exaggeration", type=float, default=3.0)
    ap.add_argument("--smooth-m", type=float, default=20, help="Gaussian sigma in metres")
    ap.add_argument("--simplify", type=float, default=0.6, help="tolerance in SVG units")
    args = ap.parse_args()

    z, cell, cols_e, rows_n = load_dtm(args.dtm, args.res)
    e0, n0, bearing = floats(args.axis)
    th = math.radians(bearing)
    de = cols_e[None, :] - e0
    dn = rows_n[:, None] - n0
    along = de * math.sin(th) + dn * math.cos(th)      # metres along the axis
    across = de * math.cos(th) - dn * math.sin(th)     # metres east (+) / west (-) of it
    del de, dn

    nbins = int(args.length / cell)
    sbin = np.floor(along / cell).astype(np.int64)
    valid = (sbin >= 0) & (sbin < nbins) & ~np.isnan(z)
    s_centres = (np.arange(nbins) + 0.5) * cell

    # Band list, nearest first, as (label, east_edge_m, west_edge_m, role).
    front = floats(args.front)
    behind = floats(args.behind)
    bands = []
    for near, far in zip(front[:0:-1], front[-2::-1]):
        bands.append((f"{far:g} to {near:g} m east of axis", near, far, "front"))
    bands.append((f"axis \u00b1{args.crest_half:g} m (ridge)", args.crest_half, -args.crest_half, "crest"))
    for near, far in zip(behind[:-1], behind[1:]):
        bands.append((f"{near:g} to {far:g} m west of axis", -near, -far, "behind"))

    profiles = []
    for label, e_edge, w_edge, role in bands:
        mask = valid & (across <= e_edge) & (across > w_edge)
        prof = np.full(nbins, -np.inf)
        np.maximum.at(prof, sbin[mask], z[mask])
        ok = np.isfinite(prof)
        if not ok.all():                   # fill slices the band misses by interpolation
            prof = np.interp(s_centres, s_centres[ok], prof[ok])
        profiles.append(gaussian_smooth(prof, args.smooth_m / cell))

    # Lift behind-ridge layers so each peeks over the ridge along a share of the width.
    ridge = profiles[[b[3] for b in bands].index("crest")]
    peek = floats(args.peek) or [0.0]
    lifts = []
    bi = 0
    for i, (_, _, _, role) in enumerate(bands):
        lift = 0.0
        if role == "behind":
            share = peek[min(bi, len(peek) - 1)]
            bi += 1
            if share > 0:
                gap = ridge - profiles[i]
                lift = max(0.0, float(np.quantile(gap, share)))
                profiles[i] = profiles[i] + lift
        lifts.append(lift)

    m_per_unit = args.length / VIEW_W
    v_scale = args.exaggeration / m_per_unit
    x = s_centres / m_per_unit

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("layer-*.svg"):
        old.unlink()
    meta, paths, tops = [], [], []
    n = len(bands)
    for i, ((label, e_edge, w_edge, role), prof, lift) in enumerate(zip(bands, profiles, lifts)):
        y = -prof * v_scale                # sea level at y = 0, up is negative
        line = LineString(np.column_stack([x, y])).simplify(args.simplify, preserve_topology=False)
        pts = np.asarray(line.coords)
        d = f"M0,{BASE_H} " + " ".join(f"L{px:.1f},{py:.1f}" for px, py in pts)
        d += f" L{VIEW_W},{BASE_H} Z"
        t = i / max(n - 1, 1)              # 0 = nearest, 1 = furthest
        colour = mix(NEAR_COLOUR, FAR_COLOUR, t)
        name = f"layer-{i + 1:02d}.svg"
        paths.append((colour, d))
        tops.append(float(pts[:, 1].min()))
        meta.append({
            "file": name, "depth": round(t, 3), "colour": colour, "role": role,
            "band": label, "offset_east_m": e_edge, "offset_west_m": w_edge,
            "max_elevation_m": round(float(prof.max() - lift), 1),
            "lift_m": round(lift, 1), "points": len(pts),
        })
        print(f"{name}: {label:32s} max {prof.max() - lift:4.0f} m"
              f"{f', lifted {lift:.0f} m' if lift else ''}, {len(pts)} pts")

    # Every layer shares one viewBox, cropped to the highest summit, so they
    # line up exactly when stacked.
    top = round(min(tops) - TOP_MARGIN)
    vb = f"0 {top} {VIEW_W} {BASE_H - top}"
    for m, (colour, d) in zip(meta, paths):
        (out / m["file"]).write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">\n'
            f'  <path fill="{colour}" d="{d}"/>\n</svg>\n'
        )
    body = "\n".join(f'  <path fill="{c}" d="{d}"/>' for c, d in reversed(paths))
    (out / "malverns-all.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">\n{body}\n</svg>\n'
    )
    manifest = json.dumps({
        "viewBox": [0, top, VIEW_W, BASE_H - top], "sea_level_y": 0,
        "axis": {"start_easting": e0, "start_northing": n0, "bearing_deg": bearing,
                 "length_m": args.length,
                 "end_easting": round(e0 + args.length * math.sin(th)),
                 "end_northing": round(n0 + args.length * math.cos(th))},
        "exaggeration": args.exaggeration,
        "source": f"Environment Agency LIDAR Composite DTM 1m (2022), max-resampled to {cell:g} m",
        "layers": meta,
    }, indent=2)
    (out / "layers.json").write_text(manifest)
    # Same data as a script, so the demo also works when opened from file://.
    (out / "layers.js").write_text(f"window.MALVERN_LAYERS = {manifest};\n")
    print(f"axis {bearing:g} deg from E {e0:.0f} N {n0:.0f}, {args.length:.0f} m")


if __name__ == "__main__":
    main()
