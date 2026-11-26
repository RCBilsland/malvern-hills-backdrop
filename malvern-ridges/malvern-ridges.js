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
 *   data-exaggeration  vertical exaggeration (default 6)
 *   data-speed         orbit speed in degrees per second (default 4; 0 = still)
 *   data-elevation     camera height above the horizon in degrees (default 8)
 *   data-bearing       direction the view starts facing, degrees (default 275, west across the ridge)
 *   data-line-width    line width in CSS pixels (default 1.6)
 *   data-edge-fade     share of the radius over which heights flatten towards
 *                      the rim (default 0.12; 0 = true heights to the edge)
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

    const pos = new Float32Array(lines * samples * 3);
    const ok = new Uint8Array(lines * samples);
    for (let i = 0; i < lines; i++) {
      const v = -R + i * sp;
      for (let j = 0; j < samples; j++) {
        const k = i * samples + j;
        if (h[k] === NODATA) continue;
        ok[k] = 1;
        const u = -R + j * st;
        const r = Math.hypot(u, v) / R;
        let f = 1;
        if (edgeFade > 0) {
          const t = Math.min(1, Math.max(0, (1 - r) / edgeFade));
          f = t * t * (3 - 2 * t);
        }
        const e = u * ue + v * ve, n = u * un + v * vn;
        pos[k * 3] = e / 1000;
        pos[k * 3 + 1] = (h[k] / 10 - base) * exaggeration * f / 1000;
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
    return {
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
    in vec3 aPos; in vec3 aPrev; in vec3 aNext; in float aSide;
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
    }`;
  const LINE_FS = SURF_FS;

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
    const exaggeration = num(el, 'exaggeration', 6);
    const speed = num(el, 'speed', 4);
    const lineWidth = num(el, 'lineWidth', 1.6);
    const edgeFade = num(el, 'edgeFade', 0.12);
    let elevation = num(el, 'elevation', 8);
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

    const U = {
      surfMVP: gl.getUniformLocation(surfProg, 'uMVP'),
      surfColour: gl.getUniformLocation(surfProg, 'uColour'),
      lineMVP: gl.getUniformLocation(lineProg, 'uMVP'),
      lineColour: gl.getUniformLocation(lineProg, 'uColour'),
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
      gl.uniform2f(U.half, W / 2, H / 2);
      gl.uniform1f(U.width, lineWidth * dpr);
      gl.bindVertexArray(lineVao);
      gl.drawElements(gl.TRIANGLES, geo.line.idx.length, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);

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
