/**
 * The Places map view: a small self-drawn slippy map over proxied raster tiles
 * with the Abu Dhabi places directory on top. The browser only talks to us
 * (tiles come from /v1/map/tiles, places from /v1/places/search), so the
 * dashboard Content-Security-Policy stays same-origin and no map library is
 * vendored. Text is set with textContent only, never parsed as markup.
 */
import { describeError } from '../format.js';
import { bboxForView, project, tilesForView, unproject } from '../map-slippy.js';
import { append, bdi, clear, h } from '../dom.js';

const ABU_DHABI = { lon: 54.375, lat: 24.45 };
const DEFAULT_ZOOM = 11;
const MIN_ZOOM = 10;
const MAX_ZOOM = 18;
const PAGE_SIZE = 200;
const FETCH_DEBOUNCE_MS = 250;

function markerButton(place, selected, onSelect) {
  const marker = h('button', {
    type: 'button', className: selected ? 'places-marker selected' : 'places-marker',
    dataset: { placeId: place.id }, text: '',
  });
  marker.setAttribute('aria-label', place.name);
  marker.addEventListener('click', () => onSelect(place.id));
  return marker;
}

export function createPlacesView(refs, api, signal) {
  const state = {
    built: false, center: { ...ABU_DHABI }, zoom: DEFAULT_ZOOM,
    q: '', category: '', items: [], total: 0, capped: false,
    selectedId: null, request: 0, timer: null, tileCache: new Map(), tileFetching: new Map(),
  };
  let tilesLayer, markersLayer;
  let drawQueued = false;

  /** One paint per frame no matter how many pointer moves arrive. */
  function queueDraw() {
    if (drawQueued || !state.built) return;
    drawQueued = true;
    window.requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  function size() {
    return { width: refs.placesMap.clientWidth || 640, height: refs.placesMap.clientHeight || 480 };
  }

  /** Short readable host for a website URL, falling back to the URL itself. */
function shortHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Only http(s) URLs may become clickable hrefs; anything else renders as inert text. */
function safeHttpUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const scheme = new URL(url).protocol;
    return scheme === 'http:' || scheme === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** An external link, or inert text when the URL is not an http(s) address. */
function externalLink(text, url, className) {
  const href = safeHttpUrl(url);
  if (href === null) return h('span', { text });
  const anchor = h('a', { text });
  if (className) anchor.className = className;
  anchor.setAttribute('href', href);
  anchor.setAttribute('title', url);
  anchor.setAttribute('target', '_blank');
  anchor.setAttribute('rel', 'noreferrer');
  return anchor;
}

/** Object URL for one tile, fetched once even when several redraws ask for it. */
  function tileUrl(key, z, x, y) {
    const cached = state.tileCache.get(key);
    if (cached) return Promise.resolve(cached);
    const inflight = state.tileFetching.get(key);
    if (inflight) return inflight;
    const pending = api.tileBlob(z, x, y).then((blob) => {
      const url = URL.createObjectURL(blob);
      state.tileCache.set(key, url);
      while (state.tileCache.size > 500) {
        const oldest = state.tileCache.keys().next();
        if (oldest.done) break;
        const oldUrl = state.tileCache.get(oldest.value);
        state.tileCache.delete(oldest.value);
        if (oldUrl) URL.revokeObjectURL(oldUrl);
      }
      return url;
    }, () => {
      setStatus('Some map tiles could not be loaded. The places dots still work.');
      return null;
    }).finally(() => {
      if (state.tileFetching.get(key) === pending) state.tileFetching.delete(key);
    });
    state.tileFetching.set(key, pending);
    return pending;
  }

  function closeDetails() {
    refs.placesDetails.hidden = true;
    state.selectedId = null;
    queueDraw();
  }

  function draw() {
    if (!state.built) return;
    const { width, height } = size();
    const center = project(state.center.lon, state.center.lat, state.zoom);
    clear(tilesLayer);
    // Tiles load with the officer Authorization header through the API transport and are shown as object
    // URLs, exactly like evidence captures. Plain <img src> could not authenticate.
    for (const tile of tilesForView(state.center.lon, state.center.lat, state.zoom, width, height)) {
      const img = document.createElement('img');
      img.setAttribute('alt', '');
      img.setAttribute('draggable', 'false');
      img.className = 'places-tile';
      img.style.left = `${tile.left}px`;
      img.style.top = `${tile.top}px`;
      const key = `${state.zoom}/${tile.x}/${tile.y}`;
      const cached = state.tileCache.get(key);
      if (cached) {
        img.setAttribute('src', cached);
      } else {
        img.dataset.tileKey = key;
        void tileUrl(key, state.zoom, tile.x, tile.y).then((url) => {
          if (url === null) return;
          const current = tilesLayer.querySelector(`img[data-tile-key="${key}"]`);
          if (current) current.setAttribute('src', url);
        });
      }
      tilesLayer.append(img);
    }
    clear(markersLayer);
    const markers = state.items.map((place) => {
      const point = project(place.lng, place.lat, state.zoom);
      const marker = markerButton(place, place.id === state.selectedId, (id) => void selectPlace(id));
      marker.style.left = `${point.x - (center.x - width / 2) - 7}px`;
      marker.style.top = `${point.y - (center.y - height / 2) - 7}px`;
      return marker;
    });
    append(markersLayer, markers);
  }

  function setStatus(text) {
    refs.placesStatus.textContent = text;
  }

  function syncCategoryOptions(categories) {
    const seen = [...new Set(categories)].sort();
    const current = refs.placesCategory.value || state.category;
    clear(refs.placesCategory);
    append(refs.placesCategory, [new Option('All categories', '')]);
    for (const category of seen) append(refs.placesCategory, [new Option(category.replaceAll('_', ' '), category)]);
    refs.placesCategory.value = seen.includes(current) ? current : '';
    state.category = refs.placesCategory.value;
  }

  async function refresh() {
    if (refs.placesView.hidden) return;
    const ticket = (state.request += 1);
    setStatus('Loading places…');
    queueDraw();
    const { width, height } = size();
    try {
      const result = await api.searchPlaces({
        q: state.q, category: state.category,
        bbox: bboxForView(state.center.lon, state.center.lat, state.zoom, width, height).join(','),
        limit: PAGE_SIZE,
      });
      if (ticket !== state.request) return;
      state.items = result.places;
      state.total = result.total;
      state.capped = result.total > result.places.length;
      syncCategoryOptions(result.categories);
      queueDraw();
      if (result.total === 0) {
        setStatus(state.q || state.category
          ? 'No places match this search in the visible area.'
          : 'The places directory is empty on this server. Fetch data/places-abu-dhabi.json first.');
      } else {
        setStatus(state.capped
          ? `Showing ${result.places.length} of ${result.total} places. Zoom in for the rest.`
          : `${result.total} place${result.total === 1 ? '' : 's'} in view.`);
      }
    } catch (error) {
      if (ticket !== state.request) return;
      state.items = [];
      queueDraw();
      setStatus(`Places are unavailable: ${describeError(error)}`);
    }
  }

  function destroy() {
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    for (const url of state.tileCache.values()) URL.revokeObjectURL(url);
    state.tileCache.clear();
    state.tileFetching.clear();
  }

  function scheduleRefresh() {
    if (state.timer !== null) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.timer = null;
      void refresh();
    }, FETCH_DEBOUNCE_MS);
  }

  function zoomBy(delta, anchor) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom + delta));
    if (next === state.zoom) return;
    if (anchor) {
      // Keep the geographic point under the cursor fixed while zooming.
      const { width, height } = size();
      const before = project(state.center.lon, state.center.lat, state.zoom);
      const fixed = {
        x: before.x + (anchor.x - width / 2),
        y: before.y + (anchor.y - height / 2),
      };
      const geo = unproject(fixed.x, fixed.y, state.zoom);
      state.zoom = next;
      const after = project(geo.lon, geo.lat, next);
      state.center = unproject(after.x - (anchor.x - width / 2), after.y - (anchor.y - height / 2), next);
    } else {
      state.zoom = next;
    }
    queueDraw();
    scheduleRefresh();
  }

  function copyText(text, button) {
    const done = () => {
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.textContent = 'Copy';
      }, 1500);
    };
    try {
      const result = navigator.clipboard?.writeText(text);
      if (result && typeof result.then === 'function') {
        result.then(done, () => setStatus('Copy failed in this browser. Select the text manually.'));
      } else {
        setStatus('Copy is unavailable in this browser. Select the text manually.');
      }
    } catch {
      setStatus('Copy is unavailable in this browser. Select the text manually.');
    }
  }

  function detailRow(label, text) {
    return h('p', { className: 'places-field' }, [h('strong', { text: `${label}: ` }), bdi(text)]);
  }

  function showDetails(place) {
    state.selectedId = place.id;
    queueDraw();
    clear(refs.placesDetailsBody);
    const rows = [h('h3', {}, [bdi(place.name)])];
    rows.push(h('p', { className: 'places-chips' }, [
      h('span', { className: 'places-chip', text: place.category.replaceAll('_', ' ') }),
    ]));
    if (place.address) rows.push(detailRow('Address', place.address));
    rows.push(detailRow('Details', place.description));
    if (place.phones.length > 0) {
      rows.push(h('h4', { text: 'Phones' }));
      for (const phone of place.phones) {
        const copy = h('button', { type: 'button', text: 'Copy' });
        copy.addEventListener('click', () => copyText(phone, copy));
        const call = h('a', { className: 'places-call', text: 'Call' });
        // Keep the tel: target to digits and a leading plus so control characters can never ride along.
        call.setAttribute('href', `tel:${phone.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')}`);
        call.setAttribute('rel', 'noreferrer');
        rows.push(h('p', { className: 'places-copy-row' }, [bdi(phone), call, copy]));
      }
    }
    if (place.urls.length > 0) {
      rows.push(h('h4', { text: 'Websites' }));
      const links = place.urls.map((url) => h('li', {}, [externalLink(shortHost(url), url)]));
      rows.push(h('ul', { className: 'places-links' }, links));
    }
    rows.push(h('p', {}, [externalLink('Open in map', place.location_link, 'places-map-link')]));
    append(refs.placesDetailsBody, rows);
    refs.placesDetails.hidden = false;
    refs.placesDetailsClose.focus({ preventScroll: true });
  }

  async function selectPlace(id) {
    try {
      showDetails(await api.getPlace(id));
    } catch (error) {
      setStatus(`Place details are unavailable: ${describeError(error)}`);
    }
  }

  function build() {
    state.built = true;
    refs.placesMap.replaceChildren();
    tilesLayer = h('div', { className: 'places-tiles', ariaHidden: 'true' });
    markersLayer = h('div', { className: 'places-markers' });
    const zoomIn = h('button', { type: 'button', className: 'places-zoom', text: '+' });
    zoomIn.setAttribute('aria-label', 'Zoom in');
    const zoomOut = h('button', { type: 'button', className: 'places-zoom', text: '−' });
    zoomOut.setAttribute('aria-label', 'Zoom out');
    const controls = h('div', { className: 'places-controls' }, [zoomIn, zoomOut]);
    const attribution = h('div', { className: 'places-attrib', text: 'Map data: OpenStreetMap contributors. Places: Overture Maps Foundation.' });
    append(refs.placesMap, [tilesLayer, markersLayer, controls, attribution]);

    zoomIn.addEventListener('click', () => zoomBy(1), { signal });
    zoomOut.addEventListener('click', () => zoomBy(-1), { signal });

    let dragging = null;
    refs.placesMap.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // No pointer capture yet: a press without movement must still reach the dot as a click.
      dragging = { x: event.clientX, y: event.clientY, lon: state.center.lon, lat: state.center.lat, moved: false };
    }, { signal });
    refs.placesMap.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      if (!dragging.moved) {
        if (Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) < 4) return;
        dragging.moved = true;
        try {
          refs.placesMap.setPointerCapture(event.pointerId);
        } catch {
          // The pointer was already released; the drag simply ends.
        }
      }
      const start = project(dragging.lon, dragging.lat, state.zoom);
      state.center = unproject(start.x - (event.clientX - dragging.x), start.y - (event.clientY - dragging.y), state.zoom);
      queueDraw();
    }, { signal });
    const endDrag = (event) => {
      if (!dragging) return;
      const wasDrag = dragging.moved;
      dragging = null;
      if (!wasDrag) return;
      try {
        refs.placesMap.releasePointerCapture(event.pointerId);
      } catch {
        // The pointer was already released.
      }
      scheduleRefresh();
    };
    refs.placesMap.addEventListener('pointerup', endDrag, { signal });
    refs.placesMap.addEventListener('pointercancel', endDrag, { signal });
    refs.placesMap.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = refs.placesMap.getBoundingClientRect();
      zoomBy(event.deltaY < 0 ? 1 : -1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }, { signal, passive: false });
    refs.placesMap.addEventListener('dblclick', (event) => {
      const rect = refs.placesMap.getBoundingClientRect();
      zoomBy(1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }, { signal });
    refs.placesMap.addEventListener('keydown', (event) => {
      const step = 120;
      if (event.key === 'Escape' && !refs.placesDetails.hidden) {
        closeDetails();
        refs.placesMap.focus({ preventScroll: true });
      } else if (event.key === '+' || event.key === '=') zoomBy(1);
      else if (event.key === '-') zoomBy(-1);
      else if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        const point = project(state.center.lon, state.center.lat, state.zoom);
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        state.center = unproject(point.x + dx, point.y + dy, state.zoom);
        queueDraw();
        scheduleRefresh();
      }
    }, { signal });

    refs.placesSearchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      state.q = refs.placesQuery.value.trim();
      state.category = refs.placesCategory.value;
      state.selectedId = null;
      refs.placesDetails.hidden = true;
      void refresh();
    }, { signal });
    refs.placesCategory.addEventListener('change', () => {
      state.category = refs.placesCategory.value;
      state.selectedId = null;
      refs.placesDetails.hidden = true;
      void refresh();
    }, { signal });
    refs.placesDetailsClose.addEventListener('click', closeDetails, { signal });
    window.addEventListener('resize', () => {
      if (!refs.placesView.hidden) {
        queueDraw();
        scheduleRefresh();
      }
    }, { signal });
    signal.addEventListener('abort', destroy, { once: true });
  }

  return {
    refresh() {
      if (!state.built) build();
      void refresh();
    },
    destroy,
  };
}
