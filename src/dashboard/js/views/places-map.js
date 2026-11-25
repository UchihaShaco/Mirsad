/**
 * The Places map view: a small self-drawn slippy map over proxied raster tiles
 * with the Abu Dhabi places directory on top. The browser only talks to us
 * (tiles come from /v1/map/tiles, places from /v1/places/search), so the
 * dashboard Content-Security-Policy stays same-origin and no map library is
 * vendored. Text is set with textContent only, never parsed as markup.
 *
 * Listings whose website Mirsad's website shield flagged (imported checks, never fetched from here) get a marker
 * shape and ring as well as a colour, so the flag reads without colour vision, and the details panel says why. A
 * flagged listing's websites and the address they lead to are shown as defanged text, never as links.
 */
import { describeError, formatTime } from '../format.js';
import { bboxForView, project, tilesForView, unproject } from '../map-slippy.js';
import { append, bdi, clear, h } from '../dom.js';

const ABU_DHABI = { lon: 54.375, lat: 24.45 };
const DEFAULT_ZOOM = 11;
const MIN_ZOOM = 10;
const MAX_ZOOM = 18;
const PAGE_SIZE = 200;
const FETCH_DEBOUNCE_MS = 250;

/** Exact names of the website flags (src/contract/labels.ts, WEBSITE_FLAG_LABELS), most serious first. */
export const WEBSITE_FLAG_LABELS = {
  harmful: 'Harmful website',
  suspicious: 'Redirects elsewhere',
  parked: 'Expired or parked',
  unconfirmed: 'Low-confidence warning',
};

/** The website shield's finding, said plainly for the details panel. */
export const WEBSITE_FINDING_TEXT = {
  harmful_redirect: "This listing's website now leads to an online gambling site or other harmful content. The business's domain was probably taken over or compromised.",
  data_theft: "This listing's website runs a script that can steal visitors' data or drain their crypto wallets.",
  feed_listed: "This listing's website is on a public list of phishing sites.",
  unrelated_redirect: "The website's name was registered again by someone else and now redirects to an unrelated site.",
  parked: "The website's domain has expired and is parked for sale. It is no longer the business's website.",
  other_warning: 'The website shield raised a low-confidence warning about this website, for example a very new domain or a risky domain ending. Check before acting on it.',
  brand_mismatch: 'This website may imitate a registered brand. Low confidence: check before acting on it.',
  none: 'The website shield found nothing wrong with this website.',
  not_checked: 'This website could not be checked.',
};

const DECISION_LABELS = { block: 'Blocked', warn: 'Warning', allow: 'Allowed' };

/** An address made inert for display: hxxps://casino[.]example/... cannot be clicked or pasted by accident. */
export function defangUrl(url) {
  return String(url).replace(/^http/i, 'hxxp').replaceAll('.', '[.]');
}

function markerButton(place, selected, flag, onSelect) {
  const classes = ['places-marker'];
  if (flag) classes.push(`flag-${flag}`);
  if (selected) classes.push('selected');
  const marker = h('button', { type: 'button', className: classes.join(' '), dataset: { placeId: place.id }, text: '' });
  marker.setAttribute('aria-label', place.name);
  // The flag is the dot's description (tooltip and screen readers); its name stays the listing's name.
  if (flag) {
    marker.dataset.websiteFlag = flag;
    marker.setAttribute('title', `${place.name}: ${WEBSITE_FLAG_LABELS[flag]}`);
  }
  marker.addEventListener('click', () => onSelect(place.id));
  return marker;
}

export function createPlacesView(refs, api, signal) {
  const state = {
    built: false, center: { ...ABU_DHABI }, zoom: DEFAULT_ZOOM,
    q: '', category: '', websiteFlag: '', items: [], flags: {}, flagCounts: null, total: 0, capped: false,
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
    }, (error) => {
      setStatus(
        error instanceof Error && 'code' in error && error.code === 'rate_limited'
          ? 'Map tiles are rate-limited right now. The places dots still work; panning pauses the tiles briefly.'
          : 'Some map tiles could not be loaded. The places dots still work.',
      );
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
      const marker = markerButton(place, place.id === state.selectedId, state.flags[place.id], (id) => void selectPlace(id));
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

  /** The Flagged websites filter with a count per kind for the current search (whole directory, not only the view). */
  function syncWebsiteFlagOptions(counts) {
    const current = refs.placesWebsiteFlag.value || state.websiteFlag;
    clear(refs.placesWebsiteFlag);
    const n = (key) => (counts ? ` (${counts[key]})` : '');
    const flagged = counts ? ` (${counts.harmful + counts.suspicious + counts.parked})` : '';
    append(refs.placesWebsiteFlag, [
      new Option('All listings', ''),
      new Option(`Flagged websites${flagged}`, 'flagged'),
      ...Object.entries(WEBSITE_FLAG_LABELS).map(([key, label]) => new Option(`${label}${n(key)}`, key)),
    ]);
    refs.placesWebsiteFlag.value = current;
    state.websiteFlag = refs.placesWebsiteFlag.value;
  }

  async function refresh() {
    if (refs.placesView.hidden) return;
    const ticket = (state.request += 1);
    setStatus('Loading places…');
    queueDraw();
    const { width, height } = size();
    try {
      const result = await api.searchPlaces({
        q: state.q, category: state.category, websiteFlag: state.websiteFlag,
        bbox: bboxForView(state.center.lon, state.center.lat, state.zoom, width, height).join(','),
        limit: PAGE_SIZE,
      });
      if (ticket !== state.request) return;
      state.items = result.places;
      state.flags = result.websiteFlags;
      state.flagCounts = result.websiteFlagCounts;
      state.total = result.total;
      state.capped = result.total > result.places.length;
      syncCategoryOptions(result.categories);
      syncWebsiteFlagOptions(result.websiteFlagCounts);
      queueDraw();
      if (result.total === 0) {
        setStatus(state.websiteFlag
          ? 'No flagged websites in the visible area. Zoom out or pan to find them.'
          : state.q || state.category
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

  /** Why the listing's website was flagged: the finding in plain words, risk, reasons, where it leads, when, evidence. */
  function websiteCheckRows(check) {
    const flagged = check.flag !== null;
    const box = h('div', { className: flagged ? `places-website-check flag-${check.flag}` : 'places-website-check' });
    const rows = [];
    if (flagged) rows.push(h('p', { className: 'places-flag-label', text: WEBSITE_FLAG_LABELS[check.flag] }));
    rows.push(h('p', { className: 'places-finding', text: WEBSITE_FINDING_TEXT[check.finding] ?? check.findingEn }));
    if (check.findingAr) rows.push(h('p', { className: 'places-finding-ar', lang: 'ar', dir: 'rtl', text: check.findingAr }));
    rows.push(detailRow('Website', defangUrl(check.website)));
    if (check.riskScore !== null) {
      const decision = DECISION_LABELS[check.decision] ?? '';
      rows.push(detailRow('Risk score', `${Math.round(check.riskScore)} of 100${decision ? ` (${decision})` : ''}`));
    }
    if (check.finalUrl && check.finalUrl !== check.website) {
      rows.push(h('p', { className: 'places-field' }, [
        h('strong', { text: 'Leads to: ' }), h('code', { className: 'places-defanged', text: defangUrl(check.finalUrl) }),
      ]));
    }
    if (check.reasons.length > 0) {
      rows.push(h('p', { className: 'places-field' }, [h('strong', { text: 'Reasons:' })]));
      rows.push(h('ul', { className: 'places-reasons' }, check.reasons.map((reason) => h('li', {}, [
        bdi(reason.en),
        reason.ar ? h('span', { className: 'places-reason-ar', lang: 'ar', dir: 'rtl', text: reason.ar }) : null,
      ]))));
    }
    if (check.checkedAt) rows.push(detailRow('Checked', formatTime(new Date(check.checkedAt).toISOString())));
    if (check.evidenceRef) rows.push(detailRow('Evidence reference', check.evidenceRef));
    rows.push(h('p', { className: 'hint', text: "From Mirsad's website shield. The portal never opens these websites." }));
    append(box, rows);
    return [h('h4', { text: 'Website check' }), box];
  }

  function showDetails(place, check = null) {
    state.selectedId = place.id;
    queueDraw();
    clear(refs.placesDetailsBody);
    const rows = [h('h3', {}, [bdi(place.name)])];
    rows.push(h('p', { className: 'places-chips' }, [
      h('span', { className: 'places-chip', text: place.category.replaceAll('_', ' ') }),
    ]));
    if (check) rows.push(...websiteCheckRows(check));
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
      // A flagged listing's websites may lead somewhere harmful: show them as inert, defanged text.
      const inert = check !== null && check.flag !== null;
      const links = place.urls.map((url) => h('li', {}, [
        inert ? h('code', { className: 'places-defanged', text: defangUrl(url) }) : externalLink(shortHost(url), url),
      ]));
      rows.push(h('ul', { className: 'places-links' }, links));
    }
    rows.push(h('p', {}, [externalLink('Open in map', place.location_link, 'places-map-link')]));
    append(refs.placesDetailsBody, rows);
    refs.placesDetails.hidden = false;
    refs.placesDetailsClose.focus({ preventScroll: true });
  }

  async function selectPlace(id) {
    try {
      const { place, websiteCheck } = await api.getPlaceDetail(id);
      showDetails(place, websiteCheck);
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
    const attribution = h('div', { className: 'places-attrib', text: "Map data: OpenStreetMap contributors. Places: Overture Maps Foundation. Website checks: Mirsad's website shield." });
    clear(refs.placesLegend);
    append(refs.placesLegend, [
      h('span', { className: 'places-legend-title', text: 'Websites:' }),
      h('span', { className: 'places-legend-item' }, [h('span', { className: 'places-swatch', 'aria-hidden': 'true' }), h('span', { text: 'No flag' })]),
      ...Object.entries(WEBSITE_FLAG_LABELS).map(([key, label]) => h('span', { className: 'places-legend-item' }, [
        h('span', { className: `places-swatch flag-${key}`, 'aria-hidden': 'true' }), h('span', { text: label }),
      ])),
    ]);
    syncWebsiteFlagOptions(null);
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
      state.websiteFlag = refs.placesWebsiteFlag.value;
      state.selectedId = null;
      refs.placesDetails.hidden = true;
      void refresh();
    }, { signal });
    refs.placesWebsiteFlag.addEventListener('change', () => {
      state.websiteFlag = refs.placesWebsiteFlag.value;
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

  /**
   * Opens the map on a value from a case (a phone number or website): finds it across the whole directory, centres the
   * map on the first match and opens its details, so the match is never hidden outside the visible area.
   */
  async function focusSearch(q) {
    if (!state.built) build();
    refs.placesQuery.value = q;
    refs.placesCategory.value = '';
    refs.placesWebsiteFlag.value = '';
    state.q = q;
    state.category = '';
    state.websiteFlag = '';
    try {
      const result = await api.searchPlaces({ q, limit: 20 });
      const first = result.places[0];
      if (first) {
        state.center = { lon: first.lng, lat: first.lat };
        state.zoom = Math.max(state.zoom, 15);
        showDetails(first);
        void selectPlace(first.id);
      } else {
        closeDetails();
      }
    } catch {
      // The visible-area refresh below reports the error.
    }
    void refresh();
  }

  return {
    refresh() {
      if (!state.built) build();
      void refresh();
    },
    search(q) {
      void focusSearch(q);
    },
    destroy,
  };
}
