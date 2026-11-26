/*
 * Malvern Hills ridgelines: drop-in component script (WebGL 2, no dependencies).
 *
 *   <link rel="stylesheet" href="malvern-ridges/malvern-ridges.css">
 *   <div class="mr-ridges" data-src="malvern-ridges/data/"></div>
 *   <script src="malvern-ridges/malvern-ridges.js" defer></script>
 *
 * Parallel lines of real elevation cross the ridge at 45 degrees and the view
 * slowly orbits the hills. Each line hides whatever lies behind it, in the
 * manner of a ridgeline ("joy") plot. Drag sideways to turn the view, up and
 * down to raise or lower it.
 *
 * Options, as data attributes on the element:
 *   data-src           folder holding ridges.json / ridges.js (default "malvern-ridges/data/")
 *   data-exaggeration  vertical exaggeration (default 3, as the layered view)
 *   data-speed         orbit speed in degrees per second (default 4; 0 = still)
 *   data-elevation     camera height above the horizon in degrees (default 12)
 *   data-bearing       direction the view starts facing, degrees (default 275, west across the ridge)
 *   data-line-width    line width in CSS pixels (default 1.6)
 *   data-edge-fade     share of the radius over which heights flatten towards
 *                      the rim (default 0.12; 0 = true heights to the edge)
 *   data-marker        "latitude,longitude" in decimal degrees (WGS84, as GPS
 *                      and web maps give them; west is negative). A floating
 *                      arrow points at that spot. Separate several with ";".
 *   data-marker-label  text shown above the arrow (several: separate with ";")
 *   data-marker-image  URL of an image (a logo, say) shown above the arrow in
 *                      place of the text, which then becomes its alt text
 *
 * The view does not turn by itself if the visitor asks for reduced motion, and
 * it pauses while off screen. Each element fires a bubbling "mr:ready" event
 * with the data in event.detail.data, and "mr:view" with { bearing, elevation }
 * whenever the view moves.
 */
(() => {
  'use strict';

  const DEFAULT_SRC = 'malvern-ridges/data/';
  const NODATA = 65535;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const cache = new Map();

  function num(el, name, fallback) {
    const v = parseFloat(el.dataset[name]);
    return Number.isFinite(v) ? v : fallback;
  }

  function loadData(src) {
    if (cache.has(src)) return cache.get(src);
    const p = fetch(src + 'ridges.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(() => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src + 'ridges.js';
        s.onload = () => window.MALVERN_RIDGES ? resolve(window.MALVERN_RIDGES)
          : reject(new Error(src + 'ridges.js did not define MALVERN_RIDGES'));
        s.onerror = () => reject(new Error('Could not load ' + src + 'ridges.json or ridges.js'));
        document.head.appendChild(s);
      }));
    cache.set(src, p);
    return p;
  }

  function decode(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Uint16Array(bytes.buffer);      // little-endian on every platform browsers run on
  }

  // WGS84 latitude/longitude to British National Grid easting/northing: a
  // Helmert shift to OSGB36, then the National Grid transverse Mercator
  // projection. Formulas from Ordnance Survey, "A guide to coordinate systems
  // in Great Britain" (accurate to a few metres without the OSTN15 grid).
  function toNationalGrid(latDeg, lonDeg) {
    const rad = Math.PI / 180;
    // WGS84 (GRS80) geodetic to cartesian.
    let a = 6378137, b = 6356752.3141, e2 = 1 - (b * b) / (a * a);
    let phi = latDeg * rad, lam = lonDeg * rad;
    let nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const x1 = nu * Math.cos(phi) * Math.cos(lam);
    const y1 = nu * Math.cos(phi) * Math.sin(lam);
    const z1 = nu * (1 - e2) * Math.sin(phi);
    // Helmert transformation WGS84 to OSGB36.
    const tx = -446.448, ty = 125.157, tz = -542.06, s = 20.4894e-6;
    const rx = -0.1502 / 3600 * rad, ry = -0.247 / 3600 * rad, rz = -0.8421 / 3600 * rad;
    const x2 = tx + (1 + s) * x1 - rz * y1 + ry * z1;
    const y2 = ty + rz * x1 + (1 + s) * y1 - rx * z1;
    const z2 = tz - ry * x1 + rx * y1 + (1 + s) * z1;
    // Cartesian to geodetic on the Airy 1830 ellipsoid.
    a = 6377563.396; b = 6356256.909; e2 = 1 - (b * b) / (a * a);
    const p = Math.hypot(x2, y2);
    phi = Math.atan2(z2, p * (1 - e2));
    for (let i = 0; i < 10; i++) {
      nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
      phi = Math.atan2(z2 + e2 * nu * Math.sin(phi), p);
    }
    lam = Math.atan2(y2, x2);
    // Transverse Mercator, National Grid parameters.
    const F0 = 0.9996012717, phi0 = 49 * rad, lam0 = -2 * rad, N0 = -100000, E0 = 400000;
    const n = (a - b) / (a + b);
    const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
    nu = a * F0 / Math.sqrt(1 - e2 * sin * sin);
    const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sin * sin, 1.5);
    const eta2 = nu / rho - 1;
    const dp = phi - phi0, sp = phi + phi0;
    const M = b * F0 * ((1 + n + 1.25 * n * n + 1.25 * n ** 3) * dp
      - (3 * n + 3 * n * n + 2.625 * n ** 3) * Math.sin(dp) * Math.cos(sp)
      + (1.875 * n * n + 1.875 * n ** 3) * Math.sin(2 * dp) * Math.cos(2 * sp)
      - (35 / 24) * n ** 3 * Math.sin(3 * dp) * Math.cos(3 * sp));
    const I = M + N0;
    const II = nu / 2 * sin * cos;
    const III = nu / 24 * sin * cos ** 3 * (5 - tan * tan + 9 * eta2);
    const IIIA = nu / 720 * sin * cos ** 5 * (61 - 58 * tan * tan + tan ** 4);
    const IV = nu * cos;
    const V = nu / 6 * cos ** 3 * (nu / rho - tan * tan);
    const VI = nu / 120 * cos ** 5 * (5 - 18 * tan * tan + tan ** 4 + 14 * eta2 - 58 * tan * tan * eta2);
    const dl = lam - lam0;
    return {
      easting: E0 + IV * dl + V * dl ** 3 + VI * dl ** 5,
      northing: I + II * dl * dl + III * dl ** 4 + IIIA * dl ** 6,
    };
  }

  function cssColour(el, prop, fallback) {
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(el).getPropertyValue(prop).trim() || fallback;
    el.appendChild(probe);
    const m = getComputedStyle(probe).color.match(/[\d.]+/g) || [0, 0, 0];
    probe.remove();
    return [m[0] / 255, m[1] / 255, m[2] / 255];
  }

  // Geometry in kilometres: x east, y up, z south. Heights are measured above
  // the lowest point, exaggerated, and flattened towards the rim if asked.
  function buildGeometry(d, exaggeration, edgeFade) {
    const h = decode(d.heights);
    const { lines, samples } = d;
    const R = d.radius_m, sp = d.line_spacing_m, st = d.sample_step_m;
    const b = d.line_bearing_deg * Math.PI / 180;
    const ue = Math.sin(b), un = Math.cos(b), ve = Math.cos(b), vn = -Math.sin(b);
    const base = d.min_m;

    const lift = (metres, u, v) => {
      let f = 1;
      if (edgeFade > 0) {
        const t = Math.min(1, Math.max(0, (1 - Math.hypot(u, v) / R) / edgeFade));
        f = t * t * (3 - 2 * t);
      }
      return (metres - base) * exaggeration * f / 1000;
    };

    const pos = new Float32Array(lines * samples * 3);
    const ok = new Uint8Array(lines * samples);
    for (let i = 0; i < lines; i++) {
      const v = -R + i * sp;
      for (let j = 0; j < samples; j++) {
        const k = i * samples + j;
        if (h[k] === NODATA) continue;
        ok[k] = 1;
        const u = -R + j * st;
        const e = u * ue + v * ve, n = u * un + v * vn;
        pos[k * 3] = e / 1000;
        pos[k * 3 + 1] = lift(h[k] / 10, u, v);
        pos[k * 3 + 2] = -n / 1000;
      }
    }

    // Surface between neighbouring lines, drawn in the background colour so it
    // hides the lines behind it.
    const tri = [];
    for (let i = 0; i < lines - 1; i++) {
      for (let j = 0; j < samples - 1; j++) {
        const a = i * samples + j, c = a + samples;
        if (ok[a] && ok[a + 1] && ok[c]) tri.push(a, a + 1, c);
        if (ok[a + 1] && ok[c + 1] && ok[c]) tri.push(a + 1, c + 1, c);
      }
    }

    // Each line becomes a ribbon two vertices wide; the shader pushes the
    // vertices apart in screen space so the width is constant in pixels.
    const lv = [], li = [];
    let nv = 0;
    for (let i = 0; i < lines; i++) {
      let j = 0;
      while (j < samples) {
        while (j < samples && !ok[i * samples + j]) j++;
        const start = j;
        while (j < samples && ok[i * samples + j]) j++;
        const end = j - 1;
        if (end - start < 1) continue;
        for (let s = start; s <= end; s++) {
          const k = i * samples + s;
          const kp = i * samples + Math.max(start, s - 1);
          const kn = i * samples + Math.min(end, s + 1);
          for (const side of [-1, 1]) {
            lv.push(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2],
                    pos[kp * 3], pos[kp * 3 + 1], pos[kp * 3 + 2],
                    pos[kn * 3], pos[kn * 3 + 1], pos[kn * 3 + 2], side);
          }
          if (s < end) {
            const q = nv + (s - start) * 2;
            li.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
          }
        }
        nv += (end - start + 1) * 2;
      }
    }

    let top = 0;
    for (let k = 0; k < ok.length; k++) if (ok[k]) top = Math.max(top, pos[k * 3 + 1]);
    // Ground position (world units) of a National Grid point, interpolated
    // between the nearest samples on the two nearest lines; null outside.
    function groundAt(E, N) {
      const de = E - d.centre.easting, dn = N - d.centre.northing;
      const u = de * ue + dn * un, v = de * ve + dn * vn;
      if (Math.hypot(u, v) > R) return null;
      const fi = (v + R) / sp, fj = (u + R) / st;
      const i0 = Math.floor(fi), j0 = Math.floor(fj);
      let sum = 0, wsum = 0;
      for (const [i, wi] of [[i0, 1 - (fi - i0)], [i0 + 1, fi - i0]]) {
        for (const [j, wj] of [[j0, 1 - (fj - j0)], [j0 + 1, fj - j0]]) {
          if (i < 0 || j < 0 || i >= lines || j >= samples) continue;
          const k = i * samples + j;
          if (h[k] === NODATA || wi * wj === 0) continue;
          sum += h[k] / 10 * wi * wj; wsum += wi * wj;
        }
      }
      if (!wsum) return null;
      return [de / 1000, lift(sum / wsum, u, v), -dn / 1000];
    }

    return {
      groundAt,
      surf: { pos, idx: new Uint32Array(tri) },
      line: { vert: new Float32Array(lv), idx: new Uint32Array(li) },
      radius: R / 1000,
      top,
    };
  }

  const SURF_VS = `#version 300 es
    uniform mat4 uMVP;
    in vec3 aPos;
    void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;
  const SURF_FS = `#version 300 es
    precision mediump float;
    uniform vec3 uColour;
    out vec4 o;
    void main() { o = vec4(uColour, 1.0); }`;
  const LINE_VS = `#version 300 es
    uniform mat4 uMVP;
    uniform vec2 uHalf;      // half the canvas size in device pixels
    uniform float uWidth;    // line width in device pixels
    in vec3 aPos; in vec3 aPrev; in vec3 aNext; in float aSide; in float aMix;
    out float vMix;
    vec2 screen(vec4 c) { return c.xy / c.w * uHalf; }
    void main() {
      vec4 c = uMVP * vec4(aPos, 1.0);
      vec2 s = screen(c);
      vec2 a = s - screen(uMVP * vec4(aPrev, 1.0));
      vec2 b = screen(uMVP * vec4(aNext, 1.0)) - s;
      if (dot(a, a) < 1e-8) a = b;
      if (dot(b, b) < 1e-8) b = a;
      a = normalize(a); b = normalize(b);
      vec2 t = normalize(a + b + vec2(1e-6, 0.0));
      vec2 n = vec2(-t.y, t.x);
      float miter = 1.0 / max(dot(n, vec2(-a.y, a.x)), 0.4);
      c.xy += n * aSide * uWidth * 0.5 * miter / uHalf * c.w;
      gl_Position = c;
      vMix = aMix;
    }`;
  const LINE_FS = `#version 300 es
    precision mediump float;
    uniform vec3 uColour;
    uniform vec3 uColourTop;
    in float vMix;
    out vec4 o;
    void main() { o = vec4(mix(uColour, uColourTop, vMix), 1.0); }`;

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function buffer(gl, target, data) {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  }

  // Column-major 4x4 matrices.
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(eye, at) {
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const norm = p => { const l = Math.hypot(...p); return p.map(x => x / l); };
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const z = norm(sub(eye, at)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
            -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }
  function multiply(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }

  async function init(el) {
    if (el.mrInstance) return el.mrInstance;
    const inst = (el.mrInstance = {});
    const src = (el.dataset.src || DEFAULT_SRC).replace(/\/?$/, '/');
    const exaggeration = num(el, 'exaggeration', 3);
    const speed = num(el, 'speed', 4);
    const lineWidth = num(el, 'lineWidth', 1.6);
    const edgeFade = num(el, 'edgeFade', 0.12);
    let elevation = num(el, 'elevation', 12);
    let bearing = num(el, 'bearing', 275);       // direction the view faces

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) { el.classList.add('mr-ridges--error'); return inst; }

    let data;
    try {
      data = await loadData(src);
    } catch (err) {
      el.classList.add('mr-ridges--error');
      console.error('[malvern-ridges]', err);
      return inst;
    }
    if (!el.hasAttribute('role')) el.setAttribute('role', 'img');
    if (!el.hasAttribute('aria-label')) {
      el.setAttribute('aria-label', 'Ridgeline view of the Malvern Hills, slowly turning');
    }
    el.appendChild(canvas);

    const bg = cssColour(el, '--mr-bg', '#000');
    const fg = cssColour(el, '--mr-line', '#f2f2f2');
    const geo = buildGeometry(data, exaggeration, edgeFade);

    const surfProg = program(gl, SURF_VS, SURF_FS);
    const lineProg = program(gl, LINE_VS, LINE_FS);

    const surfVao = gl.createVertexArray();
    gl.bindVertexArray(surfVao);
    buffer(gl, gl.ARRAY_BUFFER, geo.surf.pos);
    const sp = gl.getAttribLocation(surfProg, 'aPos');
    gl.enableVertexAttribArray(sp);
    gl.vertexAttribPointer(sp, 3, gl.FLOAT, false, 0, 0);
    buffer(gl, gl.ELEMENT_ARRAY_BUFFER, geo.surf.idx);

    const lineVao = gl.createVertexArray();
    gl.bindVertexArray(lineVao);
    buffer(gl, gl.ARRAY_BUFFER, geo.line.vert);
    const stride = 10 * 4;
    [['aPos', 3, 0], ['aPrev', 3, 12], ['aNext', 3, 24], ['aSide', 1, 36]].forEach(([name, size, off]) => {
      const loc = gl.getAttribLocation(lineProg, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
    });
    buffer(gl, gl.ELEMENT_ARRAY_BUFFER, geo.line.idx);
    gl.bindVertexArray(null);

    // Markers: an arrow (HTML, so it stays crisp and styleable) floating above
    // each point, joined to the ground by a stem drawn in the scene, so the
    // part of the stem behind a hill is hidden like the lines are.
    const markerColour = cssColour(el, '--mr-marker', '#ff5a36');
    const markerTop = cssColour(el, '--mr-marker-top', getComputedStyle(el).getPropertyValue('--mr-marker').trim() || '#ff5a36');
    const labels = (el.dataset.markerLabel || '').split(';').map(t => t.trim());
    const images = (el.dataset.markerImage || '').split(';').map(t => t.trim());
    // Tall enough to lift the arrow clear of the hills at any exaggeration.
    const stemH = Math.max(geo.top * 0.55, geo.radius * 0.17);
    const markers = [];
    (el.dataset.marker || '').split(';').map(t => t.trim()).filter(Boolean).forEach((text, n) => {
      const [lat, lon] = text.split(',').map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        console.warn('[malvern-ridges] could not read marker', text); return;
      }
      const { easting, northing } = toNationalGrid(lat, lon);
      const ground = geo.groundAt(easting, northing);
      if (!ground) {
        console.warn('[malvern-ridges] marker is outside the mapped circle', text); return;
      }
      const tip = [ground[0], ground[1] + stemH, ground[2]];
      const m = document.createElement('div');
      m.className = 'mr-marker';
      const gid = 'mr-grad-' + Math.random().toString(36).slice(2);
      m.innerHTML = '<div class="mr-marker-float">'
        + (images[n] ? '<img class="mr-marker-image" decoding="async">'
          : labels[n] ? '<span class="mr-marker-label"></span>' : '')
        + '<svg viewBox="0 0 20 26" width="20" height="26" aria-hidden="true">'
        + `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
        + '<stop offset="0" stop-color="var(--mr-marker-top, currentColor)"/>'
        + '<stop offset="1" stop-color="currentColor"/></linearGradient></defs>'
        + `<path d="M10 26 L0 12 H6 V0 H14 V12 H20 Z" fill="url(#${gid})"/></svg></div>`;
      if (images[n]) {
        const img = m.querySelector('img');
        img.src = images[n];
        img.alt = labels[n] || '';
      } else if (labels[n]) {
        m.querySelector('.mr-marker-label').textContent = labels[n];
      }
      el.appendChild(m);
      markers.push({ el: m, ground, tip, lat, lon, easting, northing });
    });
    let stemVao = null, stemCount = 0;
    if (markers.length) {
      const v = [], ix = [];
      markers.forEach(({ ground: g, tip: t }, n) => {
        for (const [p, q, r] of [[g, g, t], [t, g, t]]) {
          for (const side of [-1, 1]) v.push(...p, ...q, ...r, side, p === t ? 1 : 0);
        }
        const o = n * 4;
        ix.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
      });
      stemVao = gl.createVertexArray();
      gl.bindVertexArray(stemVao);
      buffer(gl, gl.ARRAY_BUFFER, new Float32Array(v));
      [['aPos', 3, 0], ['aPrev', 3, 12], ['aNext', 3, 24], ['aSide', 1, 36], ['aMix', 1, 40]].forEach(([name, size, off]) => {
        const loc = gl.getAttribLocation(lineProg, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride + 4, off);
      });
      buffer(gl, gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(ix));
      gl.bindVertexArray(null);
      stemCount = ix.length;
    }

    const U = {
      surfMVP: gl.getUniformLocation(surfProg, 'uMVP'),
      surfColour: gl.getUniformLocation(surfProg, 'uColour'),
      lineMVP: gl.getUniformLocation(lineProg, 'uMVP'),
      lineColour: gl.getUniformLocation(lineProg, 'uColour'),
      lineColourTop: gl.getUniformLocation(lineProg, 'uColourTop'),
      half: gl.getUniformLocation(lineProg, 'uHalf'),
      width: gl.getUniformLocation(lineProg, 'uWidth'),
    };

    let dpr = 1;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(el.clientWidth * dpr));
      const h = Math.max(1, Math.round(el.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }

    function draw() {
      resize();
      const W = canvas.width, H = canvas.height, aspect = W / H;
      const fovy = 30 * Math.PI / 180;
      const el_r = elevation * Math.PI / 180;
      const R = geo.radius;
      // Distance that fits the disc across the width and its tilted outline
      // plus the summits down the height.
      const hfov = 2 * Math.atan(Math.tan(fovy / 2) * aspect);
      const fitW = R * 1.08 / Math.sin(hfov / 2);
      const fitH = (R * Math.sin(el_r) + geo.top * Math.cos(el_r)) * 1.15 / Math.sin(fovy / 2);
      const dist = Math.max(fitW, fitH);
      const at = [0, geo.top * 0.3, 0];
      const cam = (bearing + 180) * Math.PI / 180;          // camera sits opposite the view
      const eye = [at[0] + dist * Math.cos(el_r) * Math.sin(cam),
                   at[1] + dist * Math.sin(el_r),
                   at[2] - dist * Math.cos(el_r) * Math.cos(cam)];
      const mvp = multiply(perspective(fovy, aspect, dist * 0.2, dist * 3), lookAt(eye, at));

      gl.viewport(0, 0, W, H);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);

      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.5, 2);
      gl.useProgram(surfProg);
      gl.uniformMatrix4fv(U.surfMVP, false, mvp);
      gl.uniform3fv(U.surfColour, bg);
      gl.bindVertexArray(surfVao);
      gl.drawElements(gl.TRIANGLES, geo.surf.idx.length, gl.UNSIGNED_INT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);

      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(U.lineMVP, false, mvp);
      gl.uniform3fv(U.lineColour, fg);
      gl.uniform3fv(U.lineColourTop, fg);
      gl.uniform2f(U.half, W / 2, H / 2);
      gl.uniform1f(U.width, lineWidth * dpr);
      gl.bindVertexArray(lineVao);
      gl.drawElements(gl.TRIANGLES, geo.line.idx.length, gl.UNSIGNED_INT, 0);
      if (stemVao) {
        gl.uniform3fv(U.lineColour, markerColour);
        gl.uniform3fv(U.lineColourTop, markerTop);
        gl.bindVertexArray(stemVao);
        gl.drawElements(gl.TRIANGLES, stemCount, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);

      // Place each arrow at the projected top of its stem.
      const cw = el.clientWidth, ch = el.clientHeight;
      for (const m of markers) {
        const [x, y, z] = m.tip;
        const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
        const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
        const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
        m.el.hidden = w <= 0;
        if (w > 0) {
          m.el.style.transform =
            `translate(${((cx / w + 1) / 2 * cw).toFixed(1)}px, ${((1 - cy / w) / 2 * ch).toFixed(1)}px)`;
        }
      }

      el.dispatchEvent(new CustomEvent('mr:view', { bubbles: true,
        detail: { bearing: ((bearing % 360) + 360) % 360, elevation },
      }));
    }

    // Animation: runs only while on screen, the tab is visible, and the
    // visitor has not asked for reduced motion. Dragging always works.
    let visible = true, last = 0, raf = 0, dirty = true;
    const spinning = () => speed !== 0 && !reduce.matches;
    function frame(t) {
      raf = 0;
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
      last = t;
      if (spinning() && !dragging) { bearing += speed * dt; dirty = true; }
      if (dirty) { dirty = false; draw(); }
      if (visible && !document.hidden && (spinning() || dragging)) raf = requestAnimationFrame(frame);
      else last = 0;
    }
    function kick() { dirty = true; if (!raf) raf = requestAnimationFrame(frame); }

    let dragging = false, px = 0, py = 0;
    el.addEventListener('pointerdown', e => {
      dragging = true; px = e.clientX; py = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.classList.add('mr-dragging');
      kick();
    });
    el.addEventListener('pointermove', e => {
      if (!dragging) return;
      bearing -= (e.clientX - px) * 0.3;
      elevation = Math.min(70, Math.max(3, elevation + (e.clientY - py) * 0.2));
      px = e.clientX; py = e.clientY;
      kick();
    });
    const end = () => { dragging = false; el.classList.remove('mr-dragging'); kick(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) kick(); })
        .observe(el);
    }
    document.addEventListener('visibilitychange', kick);
    reduce.addEventListener('change', kick);
    if ('ResizeObserver' in window) new ResizeObserver(kick).observe(el);
    else window.addEventListener('resize', kick);

    Object.defineProperties(inst, {
      data: { value: data },
      markers: { value: markers.map(({ lat, lon, easting, northing }) => ({ lat, lon, easting, northing })) },
      bearing: { get: () => bearing },
      elevation: { get: () => elevation },
      redraw: { value: kick },
    });
    el.dispatchEvent(new CustomEvent('mr:ready', { bubbles: true, detail: { data } }));
    kick();
    return inst;
  }

  const initAll = () => document.querySelectorAll('.mr-ridges').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();

  window.MalvernRidges = { init };
})();
