/**
 * Awareness campaigns page (front-end prototype). Plans a safe phishing-awareness campaign over a synthetic population
 * of the Abu Dhabi emirate, plays it back as if it were being sent, and shows who tapped on a heat map.
 * No request leaves the page except the optional map tiles of a signed-in dashboard tab.
 */
import { createAwarenessMap } from './map.js';
import {
  AGE_BANDS, CHANNELS, COMMUNITIES, COMMUNITY_BY_ID, GENDERS, LANGUAGES, LURES, NATIONALITIES, REGIONS, RESIDENCES,
  buildPopulation, eligible, emptyFilters, rateBy, riskiestSegments, simulateCampaign, totals,
} from './model.js';

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const PLAYBACK_SECONDS = 12;
const TEST_LINK = 'aman-check.example/t/7QK2';

const people = buildPopulation();

const form = {
  lure: 'parcel',
  channel: 'sms',
  language: 'auto',
  filters: emptyFilters(),
  size: 5000,
};

/** @type {Array<{id:number, name:string, lure:string, channel:string, language:string, filters:object, size:number, when:string, outcomes:Array, live:boolean, elapsed:number}>} */
const campaigns = [];
const view = { mode: 'clicks', campaign: 'all', age: 'all', gender: 'all', nationality: 'all', groupBy: 'age', citizenStep: 0 };
let sending = false;

// ---------------------------------------------------------------------------------------------------------------
// Small DOM helpers

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function segmented(host, options, current, onPick, role = 'radio') {
  host.replaceChildren(...Object.entries(options).map(([value, label]) => el('button', {
    type: 'button',
    role,
    [role === 'tab' ? 'aria-selected' : 'aria-checked']: String(value === current),
    text: label,
    onClick: () => onPick(value),
  })));
}

function chips(host, options, selectedList, onToggle) {
  host.replaceChildren(...Object.entries(options).map(([value, label]) => el('button', {
    type: 'button',
    className: 'aw-chip',
    'aria-pressed': String(selectedList.includes(value)),
    text: label,
    onClick: () => onToggle(value),
  })));
}

function toggle(list, value) {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
  else list.push(value);
}

function options(select, entries, current) {
  select.replaceChildren(...entries.map(([value, label]) => el('option', { value, text: label })));
  select.value = current;
}

function describeAudience(filters) {
  const parts = [];
  const areas = [...filters.regions.map((r) => REGIONS.find((x) => x.id === r).name), ...filters.communities.map((c) => COMMUNITY_BY_ID[c].name)];
  parts.push(areas.length ? areas.join(', ') : 'the whole emirate');
  if (filters.ages.length) parts.push(`aged ${filters.ages.join(', ')}`);
  if (filters.genders.length === 1) parts.push(GENDERS[filters.genders[0]].toLowerCase());
  if (filters.nationalities.length) parts.push(filters.nationalities.map((n) => NATIONALITIES[n]).join(', '));
  if (filters.residences.length) parts.push(filters.residences.map((r) => RESIDENCES[r].toLowerCase()).join(', '));
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------------------------
// Builder

function renderBuilder() {
  $('f-lure').replaceChildren(...Object.entries(LURES).map(([id, lure]) => el('button', {
    type: 'button',
    role: 'radio',
    className: 'aw-lure',
    'aria-checked': String(form.lure === id),
    onClick: () => { form.lure = id; renderBuilder(); },
  }, [lure.name, el('small', { lang: 'ar', dir: 'rtl', text: lure.ar })])));
  segmented($('f-channel'), CHANNELS, form.channel, (v) => { form.channel = v; renderBuilder(); });
  segmented($('f-language'), { auto: "Recipient's", ar: 'Arabic', en: 'English' }, form.language, (v) => { form.language = v; renderBuilder(); });
  chips($('f-regions'), Object.fromEntries(REGIONS.map((r) => [r.id, r.name])), form.filters.regions, (v) => { toggle(form.filters.regions, v); afterFilterChange(); });
  $('f-areas').replaceChildren(...form.filters.communities.map((id) => el('button', {
    type: 'button',
    className: 'aw-chip aw-area-chip',
    'aria-label': `Remove ${COMMUNITY_BY_ID[id].name}`,
    text: COMMUNITY_BY_ID[id].name,
    onClick: () => { toggle(form.filters.communities, id); afterFilterChange(); },
  })));
  chips($('f-ages'), Object.fromEntries(AGE_BANDS.map((a) => [a, a])), form.filters.ages, (v) => { toggle(form.filters.ages, v); afterFilterChange(); });
  chips($('f-genders'), GENDERS, form.filters.genders, (v) => { toggle(form.filters.genders, v); afterFilterChange(); });
  chips($('f-residences'), RESIDENCES, form.filters.residences, (v) => { toggle(form.filters.residences, v); afterFilterChange(); });
  chips($('f-nationalities'), NATIONALITIES, form.filters.nationalities, (v) => { toggle(form.filters.nationalities, v); afterFilterChange(); });

  const pool = eligible(people, form.filters).length;
  const slider = $('f-size');
  const max = Math.max(100, pool);
  slider.max = String(max);
  slider.step = String(max > 5000 ? 100 : max > 1000 ? 50 : 10);
  form.size = Math.min(form.size, pool);
  slider.value = String(form.size);
  slider.disabled = pool === 0;
  $('f-size-out').textContent = nf.format(form.size);
  $('f-eligible').textContent = pool === 0
    ? 'Nobody matches these filters. Widen them to plan a campaign.'
    : `${nf.format(pool)} people in the simulated population match these filters.`;

  const lure = LURES[form.lure];
  const text = form.language === 'ar' ? lure.textAr : lure.text;
  const [before, after] = text.split('{link}');
  const bubble = $('f-preview');
  bubble.replaceChildren(before, el('span', { className: 'aw-link', text: TEST_LINK }), after ?? '');
  bubble.dir = form.language === 'ar' ? 'rtl' : 'auto';
  $('aw-launch').disabled = sending || form.size === 0;
  renderCitizen();
  map?.redraw();
}

function afterFilterChange() {
  const pool = eligible(people, form.filters).length;
  if (form.size === 0 || form.size > pool) form.size = Math.min(pool, Math.max(form.size, Math.min(5000, pool)));
  renderBuilder();
}

$('f-size').addEventListener('input', (event) => {
  form.size = Number(event.target.value);
  $('f-size-out').textContent = nf.format(form.size);
  $('aw-launch').disabled = sending || form.size === 0;
});

// ---------------------------------------------------------------------------------------------------------------
// Which outcomes the map and the charts show

function visibleCampaigns() {
  return view.campaign === 'all' ? campaigns : campaigns.filter((c) => String(c.id) === view.campaign);
}

function visibleOutcomes() {
  const out = [];
  for (const c of visibleCampaigns()) {
    for (const o of c.outcomes) {
      if (c.live && !o.delivered) continue;
      if (view.age !== 'all' && o.person.age !== view.age) continue;
      if (view.gender !== 'all' && o.person.gender !== view.gender) continue;
      if (view.nationality !== 'all' && o.person.nationality !== view.nationality) continue;
      // While a campaign is playing, a tap only counts once its moment has come.
      out.push(c.live && o.clicked && o.at > c.elapsed ? { ...o, clicked: false, installed: false } : o);
    }
  }
  return out;
}

function heatPoints() {
  return visibleOutcomes().filter((o) => o.clicked).map((o) => ({ lat: o.person.lat, lon: o.person.lon }));
}

function areaStats(outcomes = visibleOutcomes()) {
  const stats = new Map(COMMUNITIES.map((c) => [c.id, { id: c.id, lat: c.lat, lon: c.lon, sent: 0, clicked: 0, installed: 0 }]));
  for (const o of outcomes) {
    if (!o.delivered) continue;
    const s = stats.get(o.person.community);
    s.sent += 1;
    if (o.clicked) s.clicked += 1;
    if (o.installed) s.installed += 1;
  }
  return [...stats.values()].map((s) => ({ ...s, rate: s.sent ? s.clicked / s.sent : 0 }));
}

// ---------------------------------------------------------------------------------------------------------------
// Map

const mapHost = $('aw-map');
const tooltip = $('m-tooltip');
const map = createAwarenessMap(mapHost, {
  heatPoints,
  rateAreas: () => areaStats(),
  selected: () => new Set(form.filters.communities),
  mode: () => view.mode,
  onAreaClick: (id) => {
    toggle(form.filters.communities, id);
    afterFilterChange();
  },
  onHover: (info) => {
    if (!info) {
      tooltip.hidden = true;
      return;
    }
    const c = COMMUNITY_BY_ID[info.id];
    const s = areaStats().find((a) => a.id === info.id);
    const selected = form.filters.communities.includes(info.id);
    tooltip.replaceChildren(
      el('strong', { text: c.name }),
      el('span', { className: 'aw-ar-name', lang: 'ar', dir: 'rtl', text: c.ar }),
      el('br'),
      s.sent ? `${nf.format(s.sent)} delivered · ${nf.format(s.clicked)} tapped (${pct(s.rate)})` : 'No test messages here yet',
      el('br'),
      selected ? 'Targeted · click to remove' : 'Click to target this area',
    );
    tooltip.hidden = false;
    const x = Math.min(info.x + 14, mapHost.clientWidth - 220);
    const y = Math.min(info.y + 14, mapHost.clientHeight - 90);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  },
});
$('m-zoom-in').addEventListener('click', () => map.zoomIn());
$('m-zoom-out').addEventListener('click', () => map.zoomOut());
$('m-reset').addEventListener('click', () => map.reset());

function renderMapControls() {
  segmented($('m-mode'), { clicks: 'Heat: who tapped', rate: 'Click rate by area' }, view.mode, (v) => {
    view.mode = v;
    $('m-legend-low').textContent = v === 'clicks' ? 'Fewer taps' : 'Lower rate';
    $('m-legend-high').textContent = v === 'clicks' ? 'More taps' : 'Higher rate';
    renderMapControls();
    map.refresh();
  });
  options($('m-campaign'), [['all', 'All campaigns'], ...campaigns.map((c) => [String(c.id), c.name])], view.campaign);
  options($('m-age'), [['all', 'All ages'], ...AGE_BANDS.map((a) => [a, a])], view.age);
  options($('m-gender'), [['all', 'All'], ...Object.entries(GENDERS)], view.gender);
  options($('m-nationality'), [['all', 'All groups'], ...Object.entries(NATIONALITIES)], view.nationality);
}

for (const [id, key] of [['m-campaign', 'campaign'], ['m-age', 'age'], ['m-gender', 'gender'], ['m-nationality', 'nationality']]) {
  $(id).addEventListener('change', (event) => {
    view[key] = event.target.value;
    refreshAll();
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Results: totals, exposure by group, riskiest segments

function renderKpis() {
  const all = totals(campaigns.flatMap((c) => (c.live ? [] : c.outcomes)));
  $('kpi-sent').textContent = nf.format(all.sent);
  $('kpi-clicked').textContent = nf.format(all.clicked);
  $('kpi-rate').textContent = pct(all.rate);
  $('kpi-installed').textContent = nf.format(all.installed);
}

const GROUPINGS = {
  age: ['Age', 'age', AGE_BANDS, (k) => k],
  gender: ['Gender', 'gender', Object.keys(GENDERS), (k) => GENDERS[k]],
  nationality: ['Nationality', 'nationality', Object.keys(NATIONALITIES), (k) => NATIONALITIES[k]],
  residence: ['Residence', 'residence', Object.keys(RESIDENCES), (k) => RESIDENCES[k]],
  region: ['Region', 'region', REGIONS.map((r) => r.id), (k) => REGIONS.find((r) => r.id === k).name],
};

function renderExposure() {
  segmented($('r-tabs'), Object.fromEntries(Object.entries(GROUPINGS).map(([k, g]) => [k, g[0]])), view.groupBy, (v) => {
    view.groupBy = v;
    renderExposure();
  }, 'tab');
  const outcomes = visibleOutcomes();
  const [, attribute, order, label] = GROUPINGS[view.groupBy];
  const rows = rateBy(outcomes, attribute, order).filter((r) => r.sent > 0);
  const max = Math.max(0.01, ...rows.map((r) => r.rate));
  $('r-bars').replaceChildren(...(rows.length ? rows.map((r) => {
    const bar = el('span');
    const [cr, cg, cb] = heatRgb(r.rate / max);
    bar.style.width = `${Math.max(2, (r.rate / max) * 100)}%`;
    bar.style.background = `rgb(${cr} ${cg} ${cb})`;
    return el('li', { title: `${nf.format(r.clicked)} of ${nf.format(r.sent)} tapped` }, [
      el('span', { text: label(r.key) }),
      el('span', { className: 'aw-bar' }, bar),
      el('span', { className: 'aw-rate', text: pct(r.rate) }),
    ]);
  }) : [el('li', { text: 'No delivered messages in this selection yet.' })]));

  const segments = riskiestSegments(outcomes, 40);
  $('r-segments').replaceChildren(...segments.map((s, i) => el('li', {}, [
    el('span', { text: `${i + 1}. ${s.age} · ${NATIONALITIES[s.nationality]} · ${RESIDENCES[s.residence].toLowerCase()}` }),
    el('strong', { text: pct(s.rate) }),
  ])));
}

function heatRgb(t) {
  const stops = [[0, 69, 117, 180], [0.5, 254, 224, 79], [1, 190, 20, 40]];
  const x = Math.max(0, Math.min(1, t));
  const i = x <= 0.5 ? 1 : 2;
  const [s0, r0, g0, b0] = stops[i - 1];
  const [s1, r1, g1, b1] = stops[i];
  const k = (x - s0) / (s1 - s0);
  return [Math.round(r0 + (r1 - r0) * k), Math.round(g0 + (g1 - g0) * k), Math.round(b0 + (b1 - b0) * k)];
}

// ---------------------------------------------------------------------------------------------------------------
// What the citizen sees

function renderCitizen() {
  const steps = { 0: '1 · The test', 1: '2 · After the tap', 2: '3 · The invite' };
  segmented($('c-tabs'), steps, String(view.citizenStep), (v) => {
    view.citizenStep = Number(v);
    renderCitizen();
  }, 'tab');
  const lure = LURES[form.lure];
  const arabic = form.language === 'ar';
  const text = (arabic ? lure.textAr : lure.text).replace('{link}', TEST_LINK);
  const screen = $('c-screen');
  if (view.citizenStep === 0) {
    screen.replaceChildren(
      el('div', { className: 'aw-ph-top', text: form.channel === 'whatsapp' ? 'WhatsApp · +971 50 000 0000' : 'Messages · AD-INFO' }),
      el('div', { className: 'aw-ph-body' }, [el('div', { className: 'aw-ph-bubble', dir: arabic ? 'rtl' : 'auto', text })]),
    );
  } else if (view.citizenStep === 1) {
    screen.replaceChildren(
      el('div', { className: 'aw-ph-top', text: TEST_LINK }),
      el('div', { className: 'aw-ph-body' }, [
        el('div', { className: 'aw-ph-hero' }, [el('strong', { text: 'This was a safety test' }), 'A real scammer would now ask for your card or your code.']),
        el('ul', { className: 'aw-ph-list' }, [
          el('li', { text: 'Never pay a fee through a link in a message.' }),
          el('li', { text: 'Never share banking details, passwords or one-time codes with anyone.' }),
          el('li', { text: 'Nothing was collected from you.' }),
        ]),
        el('div', { className: 'aw-ph-ar', lang: 'ar', text: 'هذه رسالة تدريبية للتوعية. لا تشارك بياناتك البنكية أو كلمات المرور أو رموز التحقق مع أي شخص.' }),
        el('span', { className: 'aw-ph-cta', text: 'Install Mirsad · ثبّت مرصاد' }),
      ]),
    );
  } else {
    screen.replaceChildren(
      el('div', { className: 'aw-ph-top', text: '9:41' }),
      el('div', { className: 'aw-ph-body' }, [
        el('div', { className: 'aw-ph-notif' }, [
          el('small', { text: 'Awareness test · now' }),
          el('strong', { text: 'Stop the real ones before you see them' }),
          'Mirsad holds scam messages and calls on your phone, explains why, and never needs the internet.',
          el('div', { className: 'aw-ph-actions' }, [el('span', { text: 'Install Mirsad' }), el('span', { text: 'Later' })]),
        ]),
        el('div', { className: 'aw-ph-notif aw-ph-ar', lang: 'ar' }, [
          el('strong', { text: 'أوقف الاحتيال قبل أن يصلك' }),
          'مرصاد يحجز رسائل ومكالمات الاحتيال على هاتفك ويشرح السبب، دون إنترنت.',
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// History

function renderHistory() {
  $('h-rows').replaceChildren(...[...campaigns].reverse().map((c) => {
    const t = totals(c.live ? c.outcomes.filter((o) => o.delivered).map((o) => (o.clicked && o.at > c.elapsed ? { ...o, clicked: false, installed: false } : o)) : c.outcomes);
    return el('tr', { className: c.live ? 'is-live' : null }, [
      el('td', {}, [c.name, el('small', { text: `${LURES[c.lure].name} · ${CHANNELS[c.channel]} · ${c.when}` })]),
      el('td', {}, [el('small', { text: describeAudience(c.filters) })]),
      el('td', { text: nf.format(c.outcomes.length) }),
      el('td', { text: nf.format(t.clicked) }),
      el('td', { text: pct(t.rate) }),
      el('td', { text: nf.format(t.installed) }),
      el('td', {}, el('button', {
        type: 'button',
        className: 'quiet',
        text: 'Show on map',
        onClick: () => {
          view.campaign = String(c.id);
          refreshAll();
          mapHost.scrollIntoView({ behavior: 'smooth', block: 'center' });
        },
      })),
    ]);
  }));
}

function refreshAll() {
  renderKpis();
  renderMapControls();
  renderExposure();
  renderHistory();
  map.refresh();
}

// ---------------------------------------------------------------------------------------------------------------
// Sending: confirm, then a staged playback of delivery and taps

const dialog = $('aw-confirm');
$('aw-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (sending || form.size === 0) return;
  $('aw-confirm-summary').textContent =
    `${nf.format(form.size)} ${CHANNELS[form.channel]} messages imitating “${LURES[form.lure].name}” to ${describeAudience(form.filters)}.`;
  dialog.returnValue = '';
  dialog.showModal();
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'send') launch();
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStages(names, active) {
  $('r-stages').replaceChildren(...names.map((name, i) => el('li', {
    className: i < active ? 'is-done' : i === active ? 'is-active' : null,
    text: name,
  })));
}

async function launch() {
  sending = true;
  renderBuilder();
  const config = { lure: form.lure, channel: form.channel, messageLanguage: form.language, filters: structuredClone(form.filters), size: form.size };
  const id = campaigns.length + 1;
  const outcomes = simulateCampaign(people, config, 7919 * id + config.size);
  const campaign = {
    id,
    name: `Campaign ${id}: ${LURES[config.lure].name}`,
    lure: config.lure,
    channel: config.channel,
    language: config.messageLanguage,
    filters: config.filters,
    size: config.size,
    when: 'just now',
    outcomes: outcomes.map((o) => ({ ...o, delivered: false })),
    live: true,
    elapsed: 0,
  };
  campaigns.push(campaign);
  view.campaign = String(id);

  $('r-idle').hidden = true;
  $('r-live').hidden = false;
  $('r-feed').replaceChildren();
  $('r-title').textContent = campaign.name;
  const stages = ['Selecting the audience', "Writing each message in the recipient's language", 'Handing messages to the network', 'Delivering', 'Watching for taps'];
  const bar = $('r-bar');
  const sendingBadge = $('m-sending');
  sendingBadge.hidden = false;
  const counters = () => {
    const visible = campaign.outcomes.filter((o) => o.delivered);
    const t = totals(visible.map((o) => (o.clicked && o.at > campaign.elapsed ? { ...o, clicked: false, installed: false } : o)));
    $('r-delivered').textContent = nf.format(t.delivered);
    $('r-clicked').textContent = nf.format(t.clicked);
    $('r-rate').textContent = pct(t.rate);
    $('r-installed').textContent = nf.format(t.installed);
    $('r-reported').textContent = nf.format(t.reported);
  };
  refreshAll();
  counters();

  setStages(stages, 0);
  $('m-sending-text').textContent = `Selecting ${nf.format(config.size)} recipients…`;
  bar.style.width = '6%';
  await wait(900);
  setStages(stages, 1);
  $('m-sending-text').textContent = 'Personalising messages…';
  bar.style.width = '14%';
  await wait(1000);
  setStages(stages, 2);
  $('m-sending-text').textContent = 'Queueing with the network…';
  bar.style.width = '22%';
  await wait(800);

  // Delivery: messages arrive in waves over about 2.5 seconds.
  setStages(stages, 3);
  const steps = 20;
  for (let s = 1; s <= steps; s += 1) {
    const upTo = Math.round((outcomes.length * s) / steps);
    for (let i = 0; i < upTo; i += 1) campaign.outcomes[i].delivered = outcomes[i].delivered;
    $('m-sending-text').textContent = `Delivering ${nf.format(upTo)} of ${nf.format(outcomes.length)}…`;
    bar.style.width = `${22 + (s / steps) * 28}%`;
    counters();
    await wait(125);
  }

  // Taps: play the click timeline back over PLAYBACK_SECONDS.
  setStages(stages, 4);
  const taps = campaign.outcomes.filter((o) => o.clicked).sort((a, b) => a.at - b.at);
  let next = 0;
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = (now) => {
      campaign.elapsed = Math.min(PLAYBACK_SECONDS, (now - start) / 1000);
      const fresh = [];
      while (next < taps.length && taps[next].at <= campaign.elapsed) fresh.push(taps[next++]);
      for (const o of fresh.slice(-3)) {
        const c = COMMUNITY_BY_ID[o.person.community];
        $('r-feed').prepend(el('li', { className: o.installed ? 'is-install' : null, text:
          `${c.name} · ${GENDERS[o.person.gender]}, ${o.person.age} · ${NATIONALITIES[o.person.nationality]} tapped${o.installed ? ' and installed Mirsad' : ''}` }));
      }
      while ($('r-feed').children.length > 6) $('r-feed').lastElementChild.remove();
      $('m-sending-text').textContent = `Watching for taps · ${nf.format(next)} so far`;
      bar.style.width = `${50 + (campaign.elapsed / PLAYBACK_SECONDS) * 50}%`;
      counters();
      if (fresh.length) {
        map.refresh();
        renderExposure();
      }
      if (campaign.elapsed < PLAYBACK_SECONDS) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });

  campaign.live = false;
  campaign.outcomes = outcomes;
  setStages([...stages.slice(0, 4), 'Campaign complete'], 5);
  sendingBadge.hidden = true;
  bar.style.width = '100%';
  sending = false;
  counters();
  refreshAll();
  renderBuilder();
}

// ---------------------------------------------------------------------------------------------------------------
// Start: two earlier (simulated) campaigns so the map is not empty on first open

function seedHistory() {
  const earlier = [
    { name: 'Pilot: parcel fee, Abu Dhabi region', when: 'October 2026', lure: 'parcel', channel: 'sms', messageLanguage: 'auto', filters: { ...emptyFilters(), regions: ['abu-dhabi'] }, size: 9000 },
    { name: 'Pilot: bank card, Al Ain and Al Dhafra', when: 'November 2026', lure: 'bank', channel: 'sms', messageLanguage: 'auto', filters: { ...emptyFilters(), regions: ['al-ain', 'al-dhafra'] }, size: 6000 },
  ];
  for (const e of earlier) {
    const id = campaigns.length + 1;
    campaigns.push({
      id, name: e.name, lure: e.lure, channel: e.channel, language: e.messageLanguage, filters: e.filters, size: e.size,
      when: e.when, outcomes: simulateCampaign(people, e, 104729 * id), live: false, elapsed: PLAYBACK_SECONDS,
    });
  }
}

seedHistory();
renderBuilder();
refreshAll();
map.reset();
