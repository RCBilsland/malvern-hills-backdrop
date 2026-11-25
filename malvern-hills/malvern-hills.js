/*
 * Malvern Hills parallax backdrop: drop-in component script.
 *
 *   <link rel="stylesheet" href="malvern-hills/malvern-hills.css">
 *   <div class="mh-hills" data-src="malvern-hills/layers/" data-strength="0.45"></div>
 *   <script src="malvern-hills/malvern-hills.js" defer></script>
 *
 * Every .mh-hills element on the page is set up automatically. Options, as
 * data attributes on the element:
 *   data-src       folder holding layers.json / layers.js and the SVGs
 *                  (default "malvern-hills/layers/")
 *   data-strength  how far the furthest layer moves, as a share of the band's
 *                  distance from the centre of the screen (default 0.45;
 *                  0 = no parallax). Nearer layers move proportionally less,
 *                  and the nearest layer stays fixed to the band.
 *
 * The layers line up exactly when the band is centred on the screen. Below the
 * centre the far layers sit higher; above it they sink behind the ridge.
 *
 * For pages that add elements later (frameworks), call MalvernHills.init(el).
 * Each element fires a bubbling "mh:ready" event with the manifest in
 * event.detail.manifest once its layers are in place.
 */
(() => {
  'use strict';

  const DEFAULT_SRC = 'malvern-hills/layers/';
  const DEFAULT_STRENGTH = 0.45;
  const instances = [];
  const manifests = new Map();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let ticking = false;

  // layers.json over http(s); layers.js as a fallback so the page also works
  // when opened straight from disk, where fetch() is blocked.
  function loadManifest(src) {
    if (manifests.has(src)) return manifests.get(src);
    const p = fetch(src + 'layers.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(() => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src + 'layers.js';
        s.onload = () => window.MALVERN_LAYERS
          ? resolve(window.MALVERN_LAYERS)
          : reject(new Error(src + 'layers.js did not define MALVERN_LAYERS'));
        s.onerror = () => reject(new Error('Could not load ' + src + 'layers.json or layers.js'));
        document.head.appendChild(s);
      }));
    manifests.set(src, p);
    return p;
  }

  async function init(el) {
    if (el.mhInstance) return el.mhInstance;
    const inst = { el, layers: [] };
    el.mhInstance = inst;

    const src = (el.dataset.src || DEFAULT_SRC).replace(/\/?$/, '/');
    const raw = parseFloat(el.dataset.strength);
    const strength = Number.isFinite(raw) ? raw : DEFAULT_STRENGTH;

    let data;
    try {
      data = await loadManifest(src);
    } catch (err) {
      el.classList.add('mh-hills--error');
      console.error('[malvern-hills]', err);
      return inst;
    }

    const [, , vbW, vbH] = data.viewBox;
    el.style.setProperty('--mh-ratio', (vbH / vbW).toFixed(4));
    if (!el.hasAttribute('role')) el.setAttribute('role', 'img');
    if (!el.hasAttribute('aria-label')) {
      el.setAttribute('aria-label', 'Silhouette of the Malvern Hills seen from the east');
    }

    // Furthest first, so nearer layers paint over it.
    const frag = document.createDocumentFragment();
    for (const L of [...data.layers].reverse()) {
      const layer = document.createElement('div');
      layer.className = 'mh-layer';
      const img = document.createElement('img');
      img.src = src + L.file;
      img.alt = '';
      img.decoding = 'async';
      const fill = document.createElement('div');
      fill.className = 'mh-fill';
      fill.style.background = L.colour;
      layer.append(img, fill);
      frag.appendChild(layer);
      inst.layers.push({ el: layer, speed: strength * L.depth });
    }
    el.appendChild(frag);

    // The band's height depends on its width, so track it.
    const setWidth = () => el.style.setProperty('--mh-width', el.clientWidth + 'px');
    setWidth();
    if ('ResizeObserver' in window) new ResizeObserver(() => { setWidth(); queue(); }).observe(el);

    instances.push(inst);
    el.dispatchEvent(new CustomEvent('mh:ready', { bubbles: true, detail: { manifest: data } }));
    queue();
    return inst;
  }

  function update() {
    ticking = false;
    const vh = window.innerHeight;
    for (const { el, layers } of instances) {
      if (reduce.matches) {
        for (const l of layers) l.el.style.transform = '';
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.bottom < -vh / 2 || r.top > vh * 1.5) continue;     // well off screen
      const delta = r.top + r.height / 2 - vh / 2;              // + = below centre
      for (const l of layers) {
        l.el.style.transform = `translate3d(0, ${(-delta * l.speed).toFixed(1)}px, 0)`;
      }
    }
  }

  function queue() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }

  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue);
  reduce.addEventListener('change', queue);

  const initAll = () => document.querySelectorAll('.mh-hills').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();

  window.MalvernHills = { init, refresh: queue };
})();
