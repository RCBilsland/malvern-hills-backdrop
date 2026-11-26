# Malvern Hills layered backdrop

Layered SVG silhouettes of the Malvern Hills, built from real elevation data and
seen from the Severn valley looking west. The layers stack on a web page and move
at different speeds as it scrolls (parallax).

## Data

Environment Agency LIDAR Composite DTM, 1 m, 2022
([dataset page](https://environment.data.gov.uk/dataset/13787b9a-26a4-4775-8523-806d13af58fc)),
under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

The ArcGIS ImageServer URL listed in the dataset metadata no longer resolves, so
`fetch_dtm.py` uses the dataset's WCS 2.0 endpoint instead. Large requests time
out at the gateway and the service rate-limits, so the area is fetched in 2 km
tiles, cached in `data/tiles_<res>m/`, and mosaicked locally. Rerunning resumes.

Extent (British National Grid, EPSG:27700): E 369000 to 386000, N 233000 to 250000.

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/fetch_dtm.py            # native 1 m, about 1.1 GB of tiles
.venv/bin/python scripts/build_layers.py         # 8 layers into malvern-hills/layers/
python3 -m http.server 8765                      # then open http://127.0.0.1:8765/
```

After changing anything in `malvern-hills/` or `malvern-ridges/`, run
`python3 scripts/stamp_assets.py` before committing. It adds a hash of each file
to its link in the demo pages (`?v=...`), so browsers fetch the new file rather
than reusing a cached copy alongside the new page. GitHub Pages lets browsers
cache files for 10 minutes, and mobile Safari in particular will otherwise mix
old and new files.

`index.html` is a demo page built on the component below. It also works opened
directly from disk.

## Using it in another page

Everything the page needs is in the `malvern-hills/` folder:

```text
malvern-hills/
  malvern-hills.css   component styles (all scoped to .mh-*)
  malvern-hills.js    component script (no dependencies)
  layers/             the SVG layers plus layers.json / layers.js
```

1. Copy `malvern-hills/` into the site.
2. Add the stylesheet in `<head>`:

   ```html
   <link rel="stylesheet" href="/path/to/malvern-hills/malvern-hills.css">
   ```

3. Put one element where the hills should appear, with `data-src` pointing at
   the `layers/` folder:

   ```html
   <div class="mh-hills" data-src="/path/to/malvern-hills/layers/"></div>
   ```

4. Add the script once, before `</body>`:

   ```html
   <script src="/path/to/malvern-hills/malvern-hills.js" defer></script>
   ```

5. Add the data credit somewhere on the page (required by the licence):

   > Contains Environment Agency LIDAR Composite DTM data. © Environment Agency
   > copyright and/or database right 2022. All rights reserved. Used under the
   > [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

Every `.mh-hills` element is set up when the page loads. For elements added
later (for example by a framework), call `MalvernHills.init(element)`.

### Options

Data attributes on the element:

| Attribute | Default | Effect |
| --- | --- | --- |
| `data-src` | `malvern-hills/layers/` | Folder with `layers.json` (or `layers.js`) and the SVGs. |
| `data-strength` | `0.45` | How far the furthest layer moves, as a share of the band's distance from the screen centre. `0` turns parallax off. Nearer layers move proportionally less; the nearest stays fixed. |

CSS custom properties on the element, or on any parent:

| Property | Default | Effect |
| --- | --- | --- |
| `--mh-sky-top` | `#8fa9bf` | Sky colour at the top of the band. |
| `--mh-sky-low` | `#e9e3d6` | Sky colour near the horizon. |
| `--mh-sky-h` | `max(20vh, 140px)` | Height of the sky strip above the hills. |
| `--mh-ground-h` | `14vh` | Height of the ground strip below the hills. |
| `--mh-min-width` | `1100px` | The hills never draw narrower than this; on narrow screens the sides crop instead. |
| `--mh-focus` | `0.68` | Which part stays in view when the sides crop: 0 is the south end, 1 the north end. |
| `--mh-overdraw` | `50vh` | How far above the band the far layers may draw. `0px` clips at the band's top edge. |

The band's total height is the sky strip, plus the hills (sized from the layer
width and the SVG proportions), plus the ground strip. It works in a container
of any width, not just full width.

### What it expects from the surrounding page

- **Above the band:** while the band is below the centre of the screen, the far
  layers rise above its top edge (up to `--mh-overdraw`) and draw over whatever
  is above it. Make the section above the same colour as `--mh-sky-top` so this
  blends in, and keep text clear of the bottom of it. The overdraw area ignores
  the mouse, so links above stay clickable. If the section above cannot match,
  add the class `mh-hills--clip-top` to clip at the band's top edge (consider
  lowering `data-strength` too, so peaks are not cut off).
- **Below the band:** the ground is the nearest layer's colour (`#23302c`). Give
  the section after the band that background for a seamless join.
- **Alignment:** the layers line up exactly as drawn when the band is centred on
  the screen.
- **Reduced motion:** if the visitor's device asks for reduced motion, the layers
  stay still and lined up.
- **Browsers:** clipping uses only `overflow: hidden` on an inner stage that
  reaches above the band, so it behaves the same in Safari, Chrome and Firefox.
  (An earlier version used `overflow-x: clip` with a negative `clip-path`
  inset; Safari clipped the raised layers at the band's top edge.)

### Events

Each element fires a bubbling `mh:ready` event when its layers are in place,
with the layer data in `event.detail.manifest`. The demo page uses this to
build its layer table.

## Tuning `build_layers.py`

| Option | Default | Effect |
| --- | --- | --- |
| `--res` | 5 | Working resolution in metres. Downsampling keeps the block maximum, so crests are not lost. |
| `--axis` | 375789,234000,5.1 | Start easting, start northing and grid bearing of the axis line. |
| `--length` | 15000 | Length of the axis in metres (the width of the view). |
| `--crest-half` | 500 | Half-width of the ridge band, in metres. |
| `--front` | 500,900,1600,2800,5000 | Band edges east of the axis, in metres. Four bands. |
| `--behind` | 500,1300,2700,5000 | Band edges west of the axis, in metres. Three bands. |
| `--peek` | 0.15,0.3,0.45 | Share of the width each behind-ridge layer should show above the ridge, nearest first. `0` keeps true heights. |
| `--exaggeration` | 3 | Vertical exaggeration: every height is multiplied by this. |
| `--smooth-m` | 20 | Gaussian smoothing along the profile, in metres. |
| `--simplify` | 0.6 | Path simplification tolerance in SVG units. |

### How the bands work

Every band is a straight strip parallel to one axis line. The axis is a
least-squares fit through 13 summits found in the DTM, from Chase End Hill to
End Hill. It runs from E 375789 N 234000 on a grid bearing of 5.1° to about
E 377122 N 248941. The view looks square on to it: from just south of due east, facing a bearing of about 275°.

| Summit (from the DTM) | Easting | Northing | Height | Offset from axis |
| --- | --- | --- | --- | --- |
| Chase End Hill | 376102 | 235502 | 191 m | 178 m east |
| (unnamed) | 375938 | 236428 | 256 m | 69 m west |
| (unnamed) | 375958 | 237518 | 285 m | 147 m west |
| (unnamed) | 376192 | 238572 | 273 m | 8 m west |
| (unnamed) | 375992 | 239648 | 328 m | 304 m west |
| Herefordshire Beacon | 375998 | 240032 | 339 m | 333 m west |
| (unnamed) | 376832 | 241302 | 309 m | 387 m east |
| (unnamed) | 376792 | 242108 | 358 m | 275 m east |
| (unnamed) | 376908 | 243028 | 326 m | 308 m east |
| Worcestershire Beacon | 376882 | 245228 | 425 m | 85 m east |
| (unnamed) | 376692 | 245792 | 370 m | 156 m west |
| North Hill | 376932 | 246362 | 398 m | 33 m east |
| End Hill area | 376690 | 246802 | 328 m | 248 m west |

Summits marked "(unnamed)" are local high points the fit found; they are not
matched to names here. All lie within 390 m of the axis, so the ridge band
(±500 m) contains every one of them. Each layer is the maximum elevation within
its strip, sampled in slices across the strip every 5 m along the axis.

Land behind the ridge is lower than the crest, so in a true view from the east
it is almost entirely hidden. `--peek` lifts each behind-ridge layer by a
constant amount, chosen so it shows above the ridge along roughly that share of
the width. The lift is recorded per layer in `layers.json` (`lift_m`). This is
an artistic adjustment, not real terrain; use `--peek 0` for true heights.

All layers share one viewBox (sea level at y = 0), so they line up when stacked.
Output goes to `malvern-hills/layers/`: one SVG per layer, a combined `malverns-all.svg`, and
`layers.json` / `layers.js` describing the bands.

## Ridgeline view (`ridges.html`)

A second visualisation of the same data: parallel elevation profiles crossing
the ridge at 45 degrees, drawn as white lines on black that hide whatever lies
behind them, in the manner of a ridgeline ("joy") plot. The view slowly orbits
the hills in 3D and can be turned by dragging.

```bash
.venv/bin/python scripts/build_ridges.py         # writes malvern-ridges/data/
```

| Option | Default | Effect |
| --- | --- | --- |
| `--angle` | 45 | Angle of the lines to the summit axis, degrees clockwise (bearing 50.1°). |
| `--radius` | 7400 | Radius of the circle of lines, metres, centred on the axis midpoint (E 376456 N 241470). |
| `--spacing` | 200 | Distance between lines, metres (75 lines). |
| `--step` | 20 | Distance between samples along a line, metres. |
| `--smooth-m` | 30 | Gaussian smoothing along each line, metres. |

Heights are stored as true elevations; exaggeration is applied in the browser.

To use it in another page, copy `malvern-ridges/` and add:

```html
<link rel="stylesheet" href="/path/to/malvern-ridges/malvern-ridges.css">
<div class="mr-ridges" data-src="/path/to/malvern-ridges/data/"></div>
<script src="/path/to/malvern-ridges/malvern-ridges.js" defer></script>
```

| Attribute | Default | Effect |
| --- | --- | --- |
| `data-exaggeration` | `3` | Vertical exaggeration, the same as the layered view. |
| `data-speed` | `4` | Orbit speed in degrees per second. `0` keeps it still. |
| `data-elevation` | `12` | Camera height above the horizon, degrees. |
| `data-bearing` | `275` | Direction the view faces at the start (west, across the ridge). |
| `data-line-width` | none | Line width in CSS pixels. Overrides `--mr-line-width`, which the themes set to 1.6 (dark) and 1.2 (light). |
| `data-depth-fade` | none | How far the furthest lines fade towards the background, 0 to 1, like haze. Overrides `--mr-depth-fade`, which the themes set to 0.35 (dark) and 0.55 (light). The marker never fades. |
| `data-edge-fade` | `0.12` | Share of the radius over which heights flatten towards the rim. `0` keeps true heights to the edge. This is an artistic adjustment. |
| `data-marker` | none | `latitude,longitude` in decimal degrees (WGS84, as GPS and web maps give them; west is negative). A floating arrow points at that spot. Separate several with `;`. |
| `data-marker-label` | none | Text shown above each arrow, separated with `;` to match the markers. |
| `data-marker-image` | none | URL of an image (a logo, say) shown above each arrow in place of the text, which then becomes its alt text. Separate several with `;`. Its width is `--mr-marker-image-w` (default `clamp(120px, 18vw, 220px)`), and a soft plate behind it (`--mr-marker-plate`, the background colour by default, at `--mr-marker-plate-opacity`, default `70%`) keeps it clear of the lines. |

The marker's position is converted to British National Grid in the browser,
using the Helmert transformation and projection in Ordnance Survey's
[A guide to coordinate systems in Great Britain](https://www.ordnancesurvey.co.uk/documents/resources/guide-coordinate-systems-great-britain.pdf),
which is accurate to a few metres. The demo marks 52.1266° N, 2.3376° W
(E 376985 N 247642), at the northern foot of the hills, with the Coco Software
logo (a local copy in `assets/`, from cocosoftware.io) and an arrow in the logo's blue-to-green
gradient. The demo starts facing a bearing of 140° (`data-bearing="140"`),
which puts the marker in front of the hills and to the left, far enough in to
keep the logo on screen on a phone. The orbit carries it round in front of the
viewer (nearest at about 185°) and it stays on the near side until about 275°. A thin stem joins each
arrow to the ground and is hidden where a hill stands in front of it. A marker
outside the mapped circle is skipped with a console warning. The instance
lists the converted positions in `element.mrInstance.markers`.

**Light and dark.** The component follows the visitor's system setting
([`prefers-color-scheme`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme))
unless a `data-theme="light"` or `data-theme="dark"` attribute on the element or
any parent (usually `<html>`) says otherwise. It repaints straight away when
either changes, so a page's own theme switch only has to set that attribute.

| Theme | Background | Lines | Line width | Depth fade |
| --- | --- | --- | --- | --- |
| Dark (default) | `#000` | `#f2f2f2` | 1.6 px | 0.35 |
| Light | `#f5f3ee` | `#4a4744` (warm grey) | 1.2 px | 0.55 |

The depth fade blends each line towards the background with distance, from
none at the near edge of the circle to the given share at the far edge. The
light theme uses a softer grey, finer lines and a stronger fade because full black on a light
background reads as a harsh, busy texture across this many lines.

The themes set only `--mr-bg`, `--mr-line`, `--mr-line-width`, `--mr-depth-fade` and `--mr-marker-image-filter`. To
change those in one theme, use the same selectors as the component
(`[data-theme="light"] .mr-ridges` and the `prefers-color-scheme` media query).
Marker colours are not themed, so the page sets them; the demo uses the logo's
colours, brighter on black (`#2ebf91`, `#6087c3`) and deeper on the light
background (`#1e9e74`, `#4f78b8`). The demo's switch, top right, remembers the
choice in the browser.

CSS properties `--mr-bg`, `--mr-line`, `--mr-marker` (default `#ff5a36`), `--mr-marker-top` (top of the arrow and stem gradient) and `--mr-ratio` (default `16 / 10`) set
the colours and proportions. It needs WebGL 2, does not turn by itself when
reduced motion is requested, and pauses while off screen. Events: `mr:ready`
(data in `event.detail.data`) and `mr:view` (`{ bearing, elevation }`). The
same data credit applies.

## Credit

Contains Environment Agency LIDAR Composite DTM data. © Environment Agency
copyright and/or database right 2022. All rights reserved.
