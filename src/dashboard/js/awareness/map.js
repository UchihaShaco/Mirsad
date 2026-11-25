/**
 * The awareness map: a small self-drawn slippy map of the Abu Dhabi emirate with a heat layer.
 *
 * When the page is opened from a signed-in dashboard tab, the base map uses the dashboard's own tile proxy
 * (/v1/map/tiles, OpenStreetMap) with the officer token, exactly like the Places map. Otherwise it draws the emirate
 * outline itself, so the page also works on its own. Everything else is one canvas: outline, heat, area markers.
 */
import { project, tilesForView, unproject, TILE_SIZE } from '../map-slippy.js';
import { ABU_DHABI_RINGS, OTHER_EMIRATES } from './abu-dhabi-shape.js';
import { COMMUNITIES } from './model.js';

const TOKEN_KEY = 'mirsad.officerSession.v2';
const MIN_ZOOM = 7;
const MAX_ZOOM = 13;
const HIT_RADIUS = 16;

/** Heat palette: low (cool) to high (hot), as [stop, r, g, b]. */
const PALETTE = [
  [0.0, 49, 54, 149],
  [0.25, 69, 117, 180],
  [0.45, 116, 196, 118],
  [0.65, 254, 224, 79],
  [0.82, 244, 109, 67],
  [1.0, 190, 20, 40],
];

export function paletteColor(t) {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < PALETTE.length; i += 1) {
    if (x <= PALETTE[i][0]) {
      const [s0, r0, g0, b0] = PALETTE[i - 1];
      const [s1, r1, g1, b1] = PALETTE[i];
      const k = (x - s0) / (s1 - s0);
      return [Math.round(r0 + (r1 - r0) * k), Math.round(g0 + (g1 - g0) * k), Math.round(b0 + (b1 - b0) * k)];
    }
  }
  return PALETTE[PALETTE.length - 1].slice(1);
}

function storedToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * @param {HTMLElement} host
 * @param {{
 *   heatPoints: () => Array<{lat:number, lon:number, w?:number}>,
 *   rateAreas: () => Array<{id:string, lat:number, lon:number, sent:number, rate:number}>,
 *   selected: () => Set<string>,
 *   mode: () => 'clicks' | 'rate',
 *   onAreaClick: (id: string) => void,
 *   onHover: (info: null | {id:string, x:number, y:number}) => void,
 * }} hooks
 */
export function createAwarenessMap(host, hooks) {
  const state = { center: { lon: 54.25, lat: 23.95 }, zoom: 8, tiles: storedToken() !== null };
  const tileUrls = new Map();
  const tilesLayer = document.createElement('div');
  tilesLayer.className = 'aw-map-tiles';
  const canvas = document.createElement('canvas');
  canvas.className = 'aw-map-canvas';
  const ctx = canvas.getContext('2d');
  const heatCanvas = document.createElement('canvas');
  const heatCtx = heatCanvas.getContext('2d', { willReadFrequently: true });
  const attribution = document.createElement('p');
  attribution.className = 'aw-map-attrib';
  host.append(tilesLayer, canvas, attribution);

  let width = 0;
  let height = 0;
  let dpr = 1;
  let frame = 0;
  let heatDirty = true;
  let lastHover = null;

  const sprite = document.createElement('canvas');

  function buildSprite(radius) {
    const size = radius * 2;
    if (sprite.width === size) return;
    sprite.width = size;
    sprite.height = size;
    const g = sprite.getContext('2d');
    const gradient = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
    gradient.addColorStop(0, 'rgba(0,0,0,1)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gradient;
    g.fillRect(0, 0, size, size);
  }

  function toScreen(lon, lat) {
    const c = project(state.center.lon, state.center.lat, state.zoom);
    const p = project(lon, lat, state.zoom);
    return { x: p.x - c.x + width / 2, y: p.y - c.y + height / 2 };
  }

  function setAttribution() {
    attribution.textContent = state.tiles
      ? 'Map: OpenStreetMap contributors · outline: geoBoundaries (ODbL) · simulated data'
      : 'Outline: geoBoundaries, OpenStreetMap contributors (ODbL) · simulated data';
  }

  function tileUrl(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileUrls.has(key)) return tileUrls.get(key);
    const pending = fetch(`/v1/map/tiles/${key}`, { headers: { Authorization: `Bearer ${storedToken()}` } })
      .then((response) => {
        if (response.status === 401 || response.status === 403) {
          state.tiles = false;
          setAttribution();
          schedule(true);
          return null;
        }
        if (!response.ok) return null;
        return response.blob().then((blob) => URL.createObjectURL(blob));
      })
      .catch(() => null);
    tileUrls.set(key, pending);
    return pending;
  }

  function drawTiles() {
    tilesLayer.replaceChildren();
    if (!state.tiles) return;
    for (const tile of tilesForView(state.center.lon, state.center.lat, state.zoom, width, height)) {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.width = TILE_SIZE;
      img.height = TILE_SIZE;
      img.style.left = `${Math.round(tile.left)}px`;
      img.style.top = `${Math.round(tile.top)}px`;
      tilesLayer.append(img);
      tileUrl(state.zoom, tile.x, tile.y).then((url) => {
        if (url) img.src = url;
      });
    }
  }

  function ringPath(g, ring) {
    ring.forEach(([lon, lat], i) => {
      const p = toScreen(lon, lat);
      if (i === 0) g.moveTo(p.x, p.y);
      else g.lineTo(p.x, p.y);
    });
    g.closePath();
  }

  function drawBase() {
    const land = cssVar('--aw-land', '#f4f1e8');
    const sea = cssVar('--aw-sea', '#cfe3ea');
    const others = cssVar('--aw-other-land', '#e4e1d7');
    const coast = cssVar('--aw-coast', '#8a9aa8');
    if (!state.tiles) {
      ctx.fillStyle = sea;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = others;
      ctx.beginPath();
      for (const rings of Object.values(OTHER_EMIRATES)) for (const ring of rings) ringPath(ctx, ring);
      ctx.fill();
      ctx.fillStyle = land;
      ctx.beginPath();
      for (const ring of ABU_DHABI_RINGS) ringPath(ctx, ring);
      ctx.fill();
    } else {
      // Dim everything outside the emirate so the area of interest stands out on the street map.
      ctx.fillStyle = 'rgba(20, 28, 48, 0.18)';
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      for (const ring of ABU_DHABI_RINGS) ringPath(ctx, ring);
      ctx.fill('evenodd');
    }
    ctx.strokeStyle = coast;
    ctx.lineWidth = state.tiles ? 2 : 1.2;
    ctx.beginPath();
    for (const ring of ABU_DHABI_RINGS) ringPath(ctx, ring);
    ctx.stroke();
  }

  function renderHeat() {
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (heatCanvas.width !== w || heatCanvas.height !== h) {
      heatCanvas.width = w;
      heatCanvas.height = h;
    }
    heatCtx.clearRect(0, 0, w, h);
    const points = hooks.heatPoints();
    if (points.length === 0) return;
    const radius = Math.round(Math.max(10, Math.min(46, 6 * 1.45 ** (state.zoom - 6))) * dpr);
    buildSprite(radius);
    // Low per-point alpha, then normalised to the densest spot below, so the full palette is always used.
    const alpha = 0.08;
    for (const pt of points) {
      const p = toScreen(pt.lon, pt.lat);
      if (p.x < -60 || p.y < -60 || p.x > width + 60 || p.y > height + 60) continue;
      heatCtx.globalAlpha = alpha * (pt.w ?? 1);
      heatCtx.drawImage(sprite, p.x * dpr - radius, p.y * dpr - radius);
    }
    heatCtx.globalAlpha = 1;
    const image = heatCtx.getImageData(0, 0, w, h);
    const data = image.data;
    let peak = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > peak) peak = data[i];
    if (peak === 0) return;
    for (let i = 0; i < data.length; i += 4) {
      const raw = data[i + 3] / peak;
      if (raw < 0.015) {
        data[i + 3] = 0;
        continue;
      }
      const t = Math.sqrt(raw); // lift sparse areas so a few taps still show
      const [r, g, b] = paletteColor(t);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.round(Math.min(1, 0.35 + t * 0.8) * 225);
    }
    heatCtx.putImageData(image, 0, 0);
  }

  function drawRateAreas() {
    const areas = hooks.rateAreas();
    const maxRate = Math.max(0.05, ...areas.map((a) => a.rate));
    const scale = 1.3 ** (state.zoom - 8);
    // Largest first so small areas stay visible on top.
    for (const area of [...areas].sort((a, b) => b.sent - a.sent)) {
      if (area.sent === 0) continue;
      const p = toScreen(area.lon, area.lat);
      const r = Math.max(8, Math.min(44, Math.sqrt(area.sent) * 0.42 * scale));
      const [cr, cg, cb] = paletteColor(area.rate / maxRate);
      ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, 0.62)`;
      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 1)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (r >= 14) {
        ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#101426';
        ctx.fillText(`${(area.rate * 100).toFixed(1)}%`, p.x, p.y);
      }
    }
  }

  function drawMarkers() {
    const selected = hooks.selected();
    const showLabels = state.zoom >= 10;
    ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const c of COMMUNITIES) {
      const p = toScreen(c.lon, c.lat);
      if (p.x < -20 || p.y < -20 || p.x > width + 20 || p.y > height + 20) continue;
      const isSelected = selected.has(c.id);
      const isHover = lastHover === c.id;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isSelected || isHover ? 6.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? '#3f44b4' : 'rgba(255, 255, 255, 0.9)';
      ctx.fill();
      ctx.lineWidth = isSelected || isHover ? 2 : 1.5;
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(30, 36, 60, 0.75)';
      ctx.stroke();
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(63, 68, 180, 0.65)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      if (showLabels || isSelected || isHover) {
        const label = c.name;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
        ctx.fillRect(p.x + 10, p.y - 9, tw + 10, 18);
        ctx.fillStyle = '#1d2238';
        ctx.fillText(label, p.x + 15, p.y);
      }
    }
  }

  function paint() {
    frame = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawBase();
    if (hooks.mode() === 'clicks') {
      if (heatDirty) {
        renderHeat();
        heatDirty = false;
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(heatCanvas, 0, 0);
      ctx.restore();
    } else {
      drawRateAreas();
    }
    drawMarkers();
  }

  function schedule(viewChanged = false) {
    if (viewChanged) {
      heatDirty = true;
      drawTiles();
    }
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function resize() {
    const rect = host.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    schedule(true);
  }

  function zoomAt(delta, x = width / 2, y = height / 2) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom + delta));
    if (next === state.zoom) return;
    const c = project(state.center.lon, state.center.lat, state.zoom);
    const anchor = unproject(c.x + (x - width / 2), c.y + (y - height / 2), state.zoom);
    const a = project(anchor.lon, anchor.lat, next);
    state.zoom = next;
    state.center = unproject(a.x - (x - width / 2), a.y - (y - height / 2), next);
    schedule(true);
  }

  function hitTest(x, y) {
    let best = null;
    let bestDistance = HIT_RADIUS;
    for (const c of COMMUNITIES) {
      const p = toScreen(c.lon, c.lat);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestDistance) {
        best = c.id;
        bestDistance = d;
      }
    }
    return best;
  }

  let drag = null;
  host.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    drag = { x: event.clientX, y: event.clientY, center: { ...state.center }, moved: false };
  });
  host.addEventListener('pointermove', (event) => {
    const rect = host.getBoundingClientRect();
    if (drag) {
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        host.classList.add('is-dragging');
        try {
          host.setPointerCapture(event.pointerId);
        } catch {
          // The pointer is already gone.
        }
      }
      const start = project(drag.center.lon, drag.center.lat, state.zoom);
      state.center = unproject(start.x - (event.clientX - drag.x), start.y - (event.clientY - drag.y), state.zoom);
      schedule(true);
      return;
    }
    const id = hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (id !== lastHover) {
      lastHover = id;
      host.classList.toggle('is-over-area', id !== null);
      schedule();
    }
    hooks.onHover(id ? { id, x: event.clientX - rect.left, y: event.clientY - rect.top } : null);
  });
  const endDrag = (event) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    host.classList.remove('is-dragging');
    if (!wasDrag && event.type === 'pointerup') {
      const rect = host.getBoundingClientRect();
      const id = hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (id) hooks.onAreaClick(id);
    }
  };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);
  host.addEventListener('pointerleave', () => {
    if (lastHover) {
      lastHover = null;
      schedule();
    }
    hooks.onHover(null);
  });
  host.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = host.getBoundingClientRect();
    zoomAt(event.deltaY < 0 ? 1 : -1, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  new ResizeObserver(resize).observe(host);
  setAttribution();
  resize();

  return {
    zoomIn: () => zoomAt(1),
    zoomOut: () => zoomAt(-1),
    reset() {
      // Fit the emirate: zoom 8 shows it whole from about 620 px wide.
      state.center = { lon: 54.3, lat: 23.9 };
      state.zoom = width >= 620 ? 8 : 7;
      schedule(true);
    },
    focus(lon, lat, zoom) {
      state.center = { lon, lat };
      state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      schedule(true);
    },
    /** Call when the heat data changed but the view did not. */
    refresh() {
      heatDirty = true;
      schedule();
    },
    redraw: () => schedule(),
    get zoom() {
      return state.zoom;
    },
  };
}
