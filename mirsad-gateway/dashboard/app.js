"use strict";
/* Mirsad website shield: operations console. No build step, no external resources.
   Everything that comes from the engine is untrusted: it is only ever inserted as text (never innerHTML). */
(() => {
  const params = new URLSearchParams(location.search);
  const MOCK = params.get("mock") === "1";
  const API = (params.get("api") || "").replace(/\/$/, "");
  const STAGES = ["reputation", "url", "page", "deep", "review"];
  const STAGE_RANK = { reputation: 0, url: 1, page: 2, deep: 3 };
  const TIMING_KEY = { reputation: "layer0_reputation", url: "layer1_url", page: "layer2_page", deep: "layer3_deep", review: "layer4_review" };
  const WARN = 35, BLOCK = 70;

  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; };
  const state = {
    lang: store("ss.lang") || ((navigator.language || "").startsWith("ar") ? "ar" : "en"),
    theme: store("ss.theme"), // null follows the system theme, as the Mirsad portal does; an explicit choice is remembered
    verdicts: new Map(),   // id -> verdict (summary or full)
    live: new Map(),       // id -> feed card state
    order: [],             // feed ids, newest first
    selected: null,
    campaigns: [],
    campSelected: null,
    benchmarks: null,
    conn: "connecting",
    pendingCheck: null,
    reviewing: new Set(),
    reviewSteps: new Map(), // verdict id -> review.step events received while a review runs
    hosts: [],
    hostsError: null,
    hostSort: { key: "last_seen", dir: -1 },
    hostFilter: "all",
    hostQuery: "",
    hostSelected: null,
    hostHistory: new Map(), // host -> {at, data}
    hostFlash: new Set(),
    evidenceCases: [],
    campHideClean: true,
    campNode: null,
    earlyAll: false,
    recentChecks: (() => { try { return JSON.parse(store("ss.recent") || "[]"); } catch (e) { return []; } })(),
    evidenceByVerdict: new Map(), // verdict id -> evidence case
    evidenceSummary: new Map(),   // verdict id -> {data} | {error, state}
    evidenceQuery: "",
    evidenceError: null,
  };

  /* ---------- helpers ---------- */
  const $ = (sel) => document.querySelector(sel);
  function h(tag, attrs, ...kids) {
    const el = document.createElementNS(tag.startsWith("svg:") ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml", tag.replace(/^svg:/, ""));
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.setAttribute("class", v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const t = (key, vars) => {
    let s = (I18N[state.lang] && I18N[state.lang][key]) ?? I18N.en[key] ?? key;
    for (const [k, v] of Object.entries(vars || {})) s = s.replace(`{${k}}`, v);
    return s;
  };
  const tOr = (key, fallback) => (I18N.en[key] !== undefined ? t(key) : fallback);
  /* Engine texts sometimes say "1 days"; fix the singular in both languages. */
  const fixPlural = (text) => (text || "")
    .replace(/\b1 (day|hour|year|minute|redirect|page)s\b/g, "1 $1")
    .replace(/(^|[^\d])1 (يوماً|يوم)/g, "$1يوم واحد");
  /* In Arabic mode, English-only engine text is shown as a left-to-right block with an "EN" tag. */
  const textBlock = (text, cls) => {
    if (!text) return null;
    if (state.lang === "ar" && !/[\u0600-\u06FF]/.test(text)) return h("div", { class: `${cls} en-block`, dir: "ltr", lang: "en" }, h("span", { class: "en-tag" }, "EN"), text);
    return h("div", { class: cls, dir: "auto" }, text);
  };
  const loc = (obj, base) => (state.lang === "ar" && obj[`${base}_ar`]) || obj[`${base}_en`] || obj[base] || obj[`${base}_ar`] || "";
  const fmtMs = (ms) => (ms == null ? "–" : ms < 1000 ? `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
  const pct = (x) => (x == null ? null : `${Math.round(x * 100)}%`);
  const toDate = (v) => (v == null ? null : typeof v === "number" ? new Date(v * 1000) : new Date(v));
  const dateFmt = () => new Intl.DateTimeFormat(state.lang === "ar" ? "ar-AE-u-nu-latn" : "en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "medium" });
  const fmtDate = (v) => { const d = toDate(v); return d && !isNaN(d) ? `${dateFmt().format(d)} ${t("tz")}` : "–"; };
  function ago(v) {
    const d = toDate(v); if (!d || isNaN(d)) return "";
    const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 60) return t("ago_s", { n: s });
    if (s < 3600) return t("ago_m", { n: Math.round(s / 60) });
    if (s < 86400) return t("ago_h", { n: Math.round(s / 3600) });
    return t("ago_d", { n: Math.round(s / 86400) });
  }
  const decisionOf = (v) => v.decision || "warn";
  const isRevoked = (v) => Boolean(v.revoked) || (v.reasons || []).some((r) => r.code === "deep.revoked");
  const sourceOf = (v) => v.source || ((v.reasons || []).some((r) => (r.code || "").startsWith("watch.")) ? "watcher" : null);
  const cacheHit = (v) => v.timings_ms && "layer0_cache_hit" in v.timings_ms;

  /* ---------- API ---------- */
  async function getJSON(path, opts) {
    const r = await fetch(API + path, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  const api = {
    list: () => (MOCK ? Mock.verdicts() : getJSON("/v1/verdicts?limit=200")).then((x) => (Array.isArray(x) ? x : x.verdicts || x.items || [])),
    get: (id) => (MOCK ? Mock.verdict(id) : getJSON(`/v1/verdicts/${encodeURIComponent(id)}`)),
    check: async (url) => (MOCK ? (await Mock.check(url)).verdict
      : getJSON("/v1/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, depth: "page", wait_ms: 8000 }) })),
    review: (id) => (MOCK ? Mock.review(id) : getJSON(`/v1/verdicts/${encodeURIComponent(id)}/review`, { method: "POST" })),
    hosts: (q) => (MOCK ? Mock.hosts(q) : getJSON(`/v1/hosts?limit=1000${q ? `&q=${encodeURIComponent(q)}` : ""}`))
      .then((x) => (Array.isArray(x) ? x : x.hosts || x.items || [])),
    history: async (host) => {
      const x = await (MOCK ? Mock.history(host) : getJSON(`/v1/hosts/${encodeURIComponent(host)}/history`));
      const row = x.row || (x.host && typeof x.host === "object" ? x.host : x);
      return { row, changes: x.changes || [], verdicts: x.verdicts || [], visits_hourly: x.visits_hourly || [] };
    },
    campaigns: () => (MOCK ? Mock.campaigns() : getJSON("/v1/campaigns")).then((x) => (Array.isArray(x) ? x : x.campaigns || [])),
    benchmarks: async () => {
      if (MOCK) return Mock.benchmarks();
      const r = await fetch(API + "/v1/benchmarks");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (r.headers.get("content-type") || "").includes("json") ? r.json() : { markdown: await r.text() };
    },
    evidenceUrl: (id) => (MOCK ? "mock/evidence-sample.zip" : `${API}/v1/verdicts/${encodeURIComponent(id)}/evidence`),
    evidenceList: (q) => (MOCK ? Mock.evidenceList() : getJSON(`/v1/evidence?limit=500${q ? `&q=${encodeURIComponent(q)}` : ""}`)),
    evidenceSummary: async (id) => {
      if (MOCK) return Mock.evidenceSummary(id);
      const r = await fetch(`${API}/v1/verdicts/${encodeURIComponent(id)}/evidence/summary`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { const d = body.detail || {}; throw Object.assign(new Error(d.reason || `HTTP ${r.status}`), { reason: d.reason, state: d.state }); }
      return body;
    },
    screenshotUrl: (id, view) => (MOCK ? Mock.screenshotUrl(id, view) : `${API}/v1/verdicts/${encodeURIComponent(id)}/screenshot?view=${view}`),
    evidenceFileUrl: (ref, name) => (MOCK ? `mock/evidence/${ref}/${name}` : `${API}/v1/evidence/${encodeURIComponent(ref)}/files/${encodeURIComponent(name)}`),
    benchExtra: () => (MOCK ? Mock.benchExtra() : getJSON("/v1/benchmarks/extra")),
    benchImageUrl: (name) => (MOCK ? `mock/img/${name}` : `${API}/v1/benchmarks/images/${encodeURIComponent(name)}`),
    thumbnailUrl: (ref) => (MOCK ? `mock/evidence/${ref}/thumb.jpg` : `${API}/v1/evidence/${encodeURIComponent(ref)}/thumbnail`),
    events(onEvent, onState) {
      if (MOCK) { onState("mock"); return Mock.start(onEvent); }
      const es = new EventSource(API + "/v1/events");
      const handle = (e) => { try { const d = JSON.parse(e.data); onEvent({ type: d.type || e.type, ...d }); } catch (err) { /* ignore keep-alives */ } };
      es.onmessage = handle;
      ["investigation.started", "layer.done", "verdict.updated", "verdict.revoked", "verdict.reviewed", "review.step", "host.updated", "evidence.ready"].forEach((n) => es.addEventListener(n, handle));
      es.onopen = () => onState("live");
      es.onerror = () => onState(es.readyState === EventSource.CLOSED ? "offline" : "connecting");
      return null;
    },
  };

  /* ---------- feed state ---------- */
  function upsertVerdict(v, { fresh = false, event = null } = {}) {
    if (!v || !v.id) return;
    const prev = state.verdicts.get(v.id);
    const merged = prev ? { ...prev, ...v } : v;
    state.verdicts.set(v.id, merged);
    let card = state.live.get(v.id);
    if (!card) {
      card = { id: v.id, first: decisionOf(merged), seenDecisions: [], enter: fresh, startedAt: merged.created_at };
      state.live.set(v.id, card);
      if (!state.order.includes(v.id)) state.order.unshift(v.id);
    }
    const d = decisionOf(merged);
    if (card.seenDecisions[card.seenDecisions.length - 1] !== d) card.seenDecisions.push(d);
    if (event === "verdict.revoked" || isRevoked(merged)) card.revoked = true;
    if (event) card.flash = event === "verdict.revoked" ? "bad" : event === "verdict.reviewed" && merged.review && merged.review.outcome === "overturned" ? "good" : null;
    card.pending = !merged.final;
  }

  /* A reused (cached) verdict keeps its own id, so the card opened by "investigation.started" is dropped
     once a verdict for the same host arrives under a different id. */
  function dropPhantoms(host, keepId) {
    let dropped = false;
    for (const id of [...state.order]) {
      const v = state.verdicts.get(id);
      if (id !== keepId && v && v.host === host && !v.decision && v.final === false) {
        state.order.splice(state.order.indexOf(id), 1); state.live.delete(id); state.verdicts.delete(id);
        if (state.selected === id) state.selected = keepId;
        dropped = true;
      }
    }
    return dropped;
  }

  function stageInfo(v, card) {
    const tm = v.timings_ms || {};
    const reached = STAGE_RANK[v.stage] ?? -1;
    const blocked = decisionOf(v) === "block" || (card && card.seenDecisions.includes("block")) || v.review;
    const cached = cacheHit(v);
    return STAGES.map((s) => {
      if (s === "review") {
        if (!blocked) return null;
        const done = Boolean(v.review);
        return { s, done, active: !done && v.final === false && reached >= 2, ms: tm.layer4_review, cls: done ? ({ overturned: "good", downgraded: "mid" }[v.review.outcome] || "bad") : "" };
      }
      if (cached) return { s, done: s === "reputation", skip: s !== "reputation", ms: s === "reputation" ? tm.layer0_cache_hit : null };
      const r = STAGE_RANK[s];
      const done = r <= reached;
      const nextActive = r === reached + 1 && !v.final;
      const skip = v.final && !done;
      const decided = v.final && decisionOf(v) === "block" && s === v.stage;
      return { s, done, active: nextActive, skip, ms: tm[TIMING_KEY[s]], cls: done && ((s === "deep" && isRevoked(v)) || decided) ? "bad" : "" };
    }).filter(Boolean);
  }

  function stageMark(s) {
    if (!s.done) return null;
    const bad = s.cls === "bad";
    return h("svg:svg", { class: `mark ${bad ? "x" : "ok"}`, viewBox: "0 0 12 12", "aria-hidden": "true" },
      h("svg:path", { d: bad ? "M3 3l6 6M9 3l-6 6" : "M2.5 6.5l2.5 2.5 4.5-5" }));
  }

  function badge(decision, extra) {
    return h("span", { class: `badge ${decision}` }, extra || t(`d_${decision}`));
  }

  function renderCard(id) {
    const v = state.verdicts.get(id); const card = state.live.get(id);
    if (!v || !card) return null;
    const d = decisionOf(v);
    const overturned = v.review && (v.review.outcome === "overturned" || v.review.outcome === "downgraded") && (card.seenDecisions.includes("block") || v.previous_decision === "block");
    const stages = stageInfo(v, card);
    const cls = ["card", card.pending ? "d-pending" : `d-${d}`, state.selected === id ? "sel" : "", card.enter ? "enter" : "",
      card.flash === "bad" ? "flash" : card.flash === "good" ? "flash-ok" : ""].filter(Boolean).join(" ");
    card.enter = false; card.flash = null;
    const flip = [];
    if (card.revoked || isRevoked(v)) flip.push(h("div", { class: "flip bad" }, h("s", {}, t("d_allow")), " → ", t("d_block"), " · ", t("revoked")));
    if (overturned) flip.push(h("div", { class: `flip ${v.review.outcome === "overturned" ? "good" : "mid"}` }, h("s", {}, t("d_block")), " → ",
      v.review.outcome === "overturned" ? t("d_cleared") : t("d_warn"), " · ", t(v.review.outcome === "overturned" ? "overturned" : "downgraded")));
    else if (v.review && v.review.outcome === "confirmed") flip.push(h("div", { class: "flip bad" }, "✓ ", t("confirmed")));
    const src = sourceOf(v);
    return h("li", { class: cls, "data-id": id, tabindex: "0", onclick: () => select(id), onkeydown: (e) => { if (e.key === "Enter") select(id); } },
      h("div", { class: "card-top" },
        card.pending && (STAGE_RANK[v.stage] ?? 0) < 1 && !cacheHit(v) ? badge("pending", t("d_pending")) : overturned && v.review.outcome === "overturned" ? badge("cleared", t("d_cleared")) : badge(d),
        h("span", { class: "host", title: v.url }, v.host || v.url),
        h("span", { class: "risk" }, card.pending && v.stage === "reputation" && !cacheHit(v) ? "…" : Math.round(v.risk_score ?? 0))),
      h("div", { class: "meta" },
        h("span", {}, ago(v.created_at || card.startedAt)),
        src === "watcher" ? h("span", { class: "chip watch" }, t("source_watcher")) : null,
        cacheHit(v) ? h("span", { class: "chip" }, t("cache_hit")) : null,
        state.evidenceByVerdict.has(id) ? h("span", { class: "chip ev-mark", title: t("ev_ready_mark") }, camera()) : null,
        v.campaign_id ? h("span", { class: "chip mono" }, v.campaign_id) : null,
        v.brand && v.brand.brand ? h("span", { class: "chip" }, state.lang === "ar" && v.brand.brand_ar ? v.brand.brand_ar : v.brand.brand) : null),
      h("div", { class: `stages${stages.length === 4 ? " four" : ""}` }, stages.map((s) => h("div", { class: ["stg", s.done ? "done" : "", s.active ? "active" : "", s.skip ? "skip" : "", s.cls || ""].join(" ") },
        h("div", { class: "bar" }),
        h("div", { class: "lbl" }, h("span", {}, stageMark(s), t(`s_${s.s}`)), h("span", { class: "ms" }, s.done && s.ms != null ? fmtMs(s.ms) : s.skip ? "–" : "\u00a0"))))),
      flip);
  }

  function renderFeed() {
    const feed = $("#feed");
    feed.replaceChildren();
    if (!state.order.length) { feed.append(h("li", { class: "empty" }, state.conn === "offline" ? t("conn_offline") : t("feed_empty"))); return; }
    for (const id of state.order.slice(0, 80)) { const el = renderCard(id); if (el) feed.append(el); }
  }
  function refreshCard(id) {
    const old = document.querySelector(`#feed [data-id="${CSS.escape(id)}"]`);
    const el = renderCard(id);
    if (!el) return;
    if (old) old.replaceWith(el); else renderFeed();
  }

  /* ---------- stats ---------- */
  function median(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function renderStats() {
    const vs = [...state.verdicts.values()];
    const blocked = vs.filter((v) => v.decision === "block").length;
    const warned = vs.filter((v) => v.decision === "warn" && v.final !== false).length;
    const firsts = vs.map((v) => {
      const tm = v.timings_ms || {};
      if (tm.layer0_cache_hit != null) return tm.layer0_cache_hit;
      if (tm.layer1_url != null) return (tm.layer0_reputation || 0) + tm.layer1_url;
      return tm.layer0_reputation ?? null;
    }).filter((x) => x != null);
    const answered = vs.filter((v) => v.final !== false);
    const fromTable = answered.filter((v) => cacheHit(v) || v.stage === "reputation").length;
    const reviewed = vs.filter((v) => v.review);
    const confirmed = reviewed.filter((v) => v.review.outcome === "confirmed").length;
    const overturned = reviewed.filter((v) => v.review.outcome === "overturned" || v.review.outcome === "downgraded").length;
    const tiles = [
      ["st_checked", vs.length, null, ""],
      ["st_blocked", blocked, null, "block"],
      ["st_warned", warned, null, "warn"],
      ["st_ttfv", fmtMs(median(firsts)), null, ""],
      ["st_cache", answered.length ? `${Math.round((fromTable / answered.length) * 100)}%` : "–", t("st_cache_sub", { n: fromTable }), ""],
      ["st_reviews", reviewed.length, t("st_reviews_sub", { c: confirmed, o: overturned }), ""],
    ];
    $("#stats").replaceChildren(...tiles.map(([k, v, sub, cls]) => h("div", { class: `stat ${cls}` }, h("div", { class: "k", title: t(k) }, t(k)), h("div", { class: "v" }, h("bdi", { dir: "ltr" }, v)), sub ? h("div", { class: "s" }, sub) : null)));
  }

  /* ---------- early warning ---------- */
  const EARLY_ROWS = 5;
  function renderEarly() {
    const vs = [...state.verdicts.values()].filter((v) => v.final !== false);
    const watcher = vs.filter((v) => sourceOf(v) === "watcher");
    const flagged = (watcher.length ? watcher : vs).filter((v) => v.decision === "block" || v.decision === "warn")
      .sort((a, b) => toDate(b.created_at) - toDate(a.created_at));
    const cleared = watcher.length - watcher.filter((v) => v.decision === "block" || v.decision === "warn").length;
    $("#early-mode").textContent = watcher.length ? t("early_watcher") : t("early_recent");
    const shown = state.earlyAll ? flagged : flagged.slice(0, EARLY_ROWS);
    const ol = $("#early");
    ol.replaceChildren(...(shown.length ? shown.map((v) => h("li", { onclick: () => select(v.id), title: v.url },
      badge(v.decision), h("span", { class: "host" }, v.host || v.url), h("span", { class: "when" }, ago(v.created_at))))
      : [h("li", { class: "empty", style: { background: "none", cursor: "default" } }, t("early_empty"))]));
    $("#early-foot").replaceChildren(...[
      watcher.length ? h("span", { class: "muted" }, t("early_cleared", { n: cleared, total: watcher.length })) : null,
      flagged.length > EARLY_ROWS ? h("button", { type: "button", class: "linkish", onclick: () => { state.earlyAll = !state.earlyAll; renderEarly(); } },
        state.earlyAll ? t("show_less") : t("show_all", { n: flagged.length })) : null].filter(Boolean));
  }

  /* ---------- verdict detail ---------- */
  function gauge(score, decision) {
    const s = Math.max(0, Math.min(100, score || 0));
    const R = 60, cx = 75, cy = 76;
    const pt = (p) => { const a = Math.PI * (1 - p / 100); return [cx + R * Math.cos(a), cy - R * Math.sin(a)]; };
    const arc = (a, b) => { const [x1, y1] = pt(a), [x2, y2] = pt(b); return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`; };
    const color = `var(--${decision === "block" ? "block" : decision === "warn" ? "warn" : decision === "allow" ? "allow" : "pending"})`;
    return h("div", { class: "gauge", role: "img", "aria-label": `${t("risk")} ${Math.round(s)}/100` },
      h("svg:svg", { viewBox: "0 0 150 92" },
        h("svg:path", { d: arc(0, 100), class: "track", fill: "none", "stroke-width": 12, "stroke-linecap": "round" }),
        h("svg:path", { d: arc(0, WARN), fill: "none", stroke: "var(--allow)", "stroke-width": 3, opacity: .55 }),
        h("svg:path", { d: arc(WARN, BLOCK), fill: "none", stroke: "var(--warn)", "stroke-width": 3, opacity: .55 }),
        h("svg:path", { d: arc(BLOCK, 100), fill: "none", stroke: "var(--block)", "stroke-width": 3, opacity: .55 }),
        s > 0.5 ? h("svg:path", { d: arc(0, s), fill: "none", stroke: color, "stroke-width": 12, "stroke-linecap": "round" }) : null,
        h("svg:text", { x: cx, y: cy - 6, "text-anchor": "middle", class: "num" }, Math.round(s)),
        h("svg:text", { x: cx, y: cy + 12, "text-anchor": "middle", class: "cap" }, `${t("risk")} / 100`)));
  }

  function facts(rows) {
    const dl = h("dl", { class: "facts" });
    for (const [label, value, mono] of rows) {
      if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) continue;
      dl.append(h("dt", {}, label), h("dd", { class: mono ? "mono" : "" }, Array.isArray(value) ? value.join(", ") : value));
    }
    return dl.childNodes.length ? dl : null;
  }
  const section = (title, ...body) => { const kids = body.flat().filter(Boolean); return kids.length ? h("section", { class: "sec" }, h("h3", {}, title), kids) : null; };

  function reasonsList(v) {
    const rs = [...(v.reasons || [])].sort((a, b) => (b.points || 0) - (a.points || 0));
    if (!rs.length) return null;
    const max = Math.max(1, ...rs.map((r) => Math.abs(r.points || 0)));
    return h("ol", { class: "reasons" }, rs.map((r) => {
      const p = r.points || 0; const w = `${(Math.abs(p) / max) * 100}%`;
      const judge = r.code === "llm.judge" && (r.title_en || "").match(/(\d+)\s*%/);
      const title = judge ? t("reason_llm", { pct: judge[1] }) : fixPlural(loc(r, "title"));
      return h("li", { class: "reason" },
        h("span", { class: `sev ${r.severity}` }, t(`sev_${r.severity}`)),
        h("div", {}, textBlock(title, "t"), textBlock(r.detail, "d")),
        h("div", { class: "contrib", title: `${p > 0 ? "+" : ""}${p}` },
          h("span", { class: "neg" }, p < 0 ? h("i", { style: { width: w } }) : null),
          h("span", { class: "pos" }, p > 0 ? h("i", { style: { width: w } }) : null),
          h("span", { class: "pts" }, Math.round(p) === 0 ? "0" : `${p > 0 ? "+" : "−"}${Math.abs(Math.round(p))}`)));
    }));
  }

  /* Engine timing keys grouped into the stages a person would name. */
  function stageTimings(tm) {
    const llm = Object.entries(tm).filter(([k]) => k === "llm" || k.startsWith("llm.")).reduce((a, [, ms]) => a + ms, 0);
    const page = tm.layer2_page;
    const fetch = tm.fetch_page;
    const first = [
      ["tg_reputation", tm.layer0_cache_hit ?? tm.layer0_reputation],
      ["tg_url", tm.layer1_url],
      ["tg_fetch", fetch != null && page != null ? Math.min(fetch, page) : null],
      ["tg_analysis", page != null ? Math.max(0, page - (fetch != null ? Math.min(fetch, page) : 0)) : null],
    ].filter(([, ms]) => ms != null);
    const background = [["tg_deep", tm.layer3_deep], ["tg_llm", llm || null], ["tg_review", tm.layer4_review]].filter(([, ms]) => ms != null && ms > 0);
    return { first, background, firstTotal: first.reduce((a, [, ms]) => a + ms, 0) };
  }
  function timingPanel(stages, raw) {
    const max = Math.max(1, ...stages.first.map((x) => x[1]), ...stages.background.map((x) => x[1]));
    return [
      stages.first.length ? h("div", { class: "tgroup" }, h("div", { class: "tg-title" }, t("tg_first"), h("bdi", { dir: "ltr", class: "num" }, fmtMs(stages.firstTotal))),
        hbars(stages.first.map(([k, ms]) => [t(k), ms]), max, fmtMs)) : null,
      stages.background.length ? h("div", { class: "tgroup" }, h("div", { class: "tg-title" }, t("tg_background")),
        hbars(stages.background.map(([k, ms]) => [t(k), ms]), max, fmtMs, () => "bg")) : null,
      h("details", { class: "ev-files" }, h("summary", {}, t("tg_details")), hbars(raw.map(([k, ms]) => [k, ms, true]), Math.max(...raw.map((x) => x[1])), fmtMs)),
    ];
  }

  function chainDiagram(v) {
    const hops = (v.redirect_chain && v.redirect_chain.length ? v.redirect_chain : (v.page && v.page.redirect_chain) || []);
    if (!hops.length) return h("div", { class: "muted" }, t("sec_chain_none"));
    const arrow = () => h("svg:svg", { viewBox: "0 0 22 12" }, h("svg:path", { d: "M1 6h18M14 1l5 5-5 5" }));
    return h("div", { class: "chain" }, hops.map((hop, i) => {
      let host = hop.url, path = "";
      try { const u = new URL(hop.url); host = u.host; path = u.pathname + u.search; } catch (e) { /* keep raw */ }
      return h("div", { class: `hop${i === hops.length - 1 ? " final" : ""}` },
        i > 0 ? h("div", { class: "arrow" }, h("div", {}, arrow(), h("div", { class: "via" }, hops[i].via || ""))) : null,
        h("div", { class: "node", title: hop.url }, h("div", { class: "h" }, host), h("div", { class: "m" }, [path.length > 40 ? path.slice(0, 40) + "…" : path, hop.status ? ` · ${hop.status}` : "", hop.ip ? ` · ${hop.ip}` : ""].join(""))));
    }));
  }

  function lcsMask(a, b) {
    const n = a.length, m = b.length; const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const keep = new Array(n).fill(false); let i = 0, j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { keep[i] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
    return keep;
  }
  function brandPanel(v) {
    const b = v.brand; if (!b) return null;
    const host = (v.registered_domain || v.host || "").toLowerCase();
    const official = b.official_domains || [];
    const closest = official.slice().sort((x, y) => lcsMask(host, y).filter(Boolean).length - lcsMask(host, x).filter(Boolean).length)[0];
    const stem = (x) => (x.includes(".") ? x.slice(0, x.lastIndexOf(".")) : x);
    const label = stem(host);
    const keep = closest && label.length < 80 ? lcsMask(label, stem(closest.toLowerCase())) : null;
    const hostEl = h("div", { class: "val" }, keep ? [...label].map((c, i) => (keep[i] ? c : h("mark", {}, c))) : label, host.slice(label.length));
    return h("div", {},
      h("div", { class: "brandbox" },
        h("div", { class: "side fake" }, h("div", { class: "lbl" }, t("brand_this")), hostEl,
          h("div", { class: "lbl", style: { marginTop: "8px" } }, t("brand_claims")),
          h("div", { class: "name" }, state.lang === "ar" && b.brand_ar ? b.brand_ar : b.brand, b.category ? h("span", { class: "muted", style: { fontWeight: 400 } }, ` · ${b.category}`) : null)),
        h("div", { class: "vs" }, "≠"),
        h("div", { class: "side real" }, h("div", { class: "lbl" }, t("brand_real")), official.length ? official.map((d) => h("div", { class: "val" }, d)) : h("div", { class: "muted" }, t("none")))),
      facts([[t("brand_technique"), b.technique], [t("brand_matched"), b.matched_on], [t("rv_confidence"), pct(b.score)]]));
  }

  function stepList(steps) {
    return h("ol", { class: "steps" }, steps.map((s) => {
      const bear = s.supports_block === true ? ["yes", t("rv_supports")] : s.supports_block === false ? ["no", t("rv_contradicts")] : ["neutral", t("rv_neutral")];
      const input = Object.entries(s.input || {}).map(([k, val]) => `${k}=${typeof val === "string" ? val : JSON.stringify(val)}`).join("  ");
      return h("li", {},
        h("div", {}, h("span", { class: "tool" }, s.tool), h("span", { class: `bear ${bear[0]}` }, bear[1]), s.elapsed_ms ? h("span", { class: "ms" }, fmtMs(s.elapsed_ms)) : null),
        input ? h("div", { class: "in" }, input) : null,
        textBlock(s.finding, "find"));
    }));
  }

  /* In Arabic, the headline is the engine's fixed wording; the model-written summary follows, labelled as such. */
  function reviewSummary(v, r) {
    if (state.lang !== "ar") return r.summary_en ? textBlock(r.summary_en, "rv-summary") : null;
    const fixed = (v.reasons || []).find((x) => (x.code || "").startsWith("review.") && x.title_ar);
    return h("div", { class: "rv-summary" },
      fixed ? h("div", { class: "rv-head", dir: "rtl" }, fixed.title_ar) : null,
      r.summary_ar ? h("div", { class: "rv-model" }, h("div", { class: "muted rv-model-label" }, t("rv_model_text")), textBlock(r.summary_ar, "rv-model-text"))
        : r.summary_en ? textBlock(r.summary_en, "rv-model-text") : null);
  }

  function reviewPanel(v) {
    const r = v.review;
    const running = state.reviewing.has(v.id);
    const live = state.reviewSteps.get(v.id) || [];
    const button = h("button", { class: "secondary", type: "button", disabled: running || null, onclick: () => runReview(v.id) },
      h("svg:svg", { viewBox: "0 0 24 24" }, h("svg:path", { d: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" })), running ? t("btn_review_running") : t("btn_review"));
    const streaming = running ? h("div", { class: "streaming" }, h("div", { class: "trail-title" }, h("span", { class: "pulse" }), t("rv_live")), live.length ? stepList(live) : null) : null;
    if (!r) return h("div", { class: "review" }, h("div", { class: "head" }, h("span", { class: "muted", style: { flex: 1 } }, running ? "" : t("sec_review_none")), button), streaming);
    return h("div", { class: "review" },
      h("div", { class: "head" },
        h("span", { class: `outcome ${r.outcome}` }, t(`rv_${r.outcome}`)),
        h("span", { class: "conf" }, t("rv_confidence"), h("span", { class: "meter" }, h("i", { style: { width: `${Math.round((r.confidence || 0) * 100)}%` } })), pct(r.confidence)),
        h("span", { class: "conf" }, t("rv_recommended"), " ", badge(r.decision)),
        h("span", { style: { marginInlineStart: "auto" } }, button)),
      streaming,
      reviewSummary(v, r),
      (r.steps || []).length ? h("div", { class: "trail-title" }, t("rv_trail")) : null,
      stepList(r.steps || []),
      r.model ? h("div", { class: "muted", style: { fontSize: "11.5px", marginTop: "6px" } }, r.model) : null);
  }

  function domainFacts(v) {
    const d = v.domain || {};
    const yn = (x) => (x ? t("yes") : null);
    return facts([
      [t("f_registrar"), d.registrar], [t("f_created"), d.created ? fmtDate(d.created) : null],
      [t("f_age"), d.age_days != null ? t("days", { n: d.age_days }) : null], [t("f_country"), d.registrant_country],
      [t("f_ns"), d.nameservers, true], [t("f_ips"), d.ips, true],
      [t("f_asn"), d.asn ? `AS${d.asn}${d.asn_org ? " · " + d.asn_org : ""}` : d.asn_org], [t("f_hosting"), d.hosting_country],
      [t("f_tls"), d.tls_issuer], [t("f_tls_age"), d.tls_age_days != null ? t("days", { n: d.tls_age_days }) : null],
      [t("f_rank"), d.popularity_rank], [t("f_allow"), d.allowlisted ? `${t("yes")}${d.allowlist_owner ? " · " + d.allowlist_owner : ""}` : null],
      [t("f_block"), d.blocklisted ? `${t("yes")}${(d.blocklist_sources || []).length ? " · " + d.blocklist_sources.join(", ") : ""}` : null],
      [t("f_shortener"), yn(d.is_shortener)], [t("f_shared"), yn(d.is_shared_hosting)],
    ]);
  }

  function pageFacts(v) {
    const p = v.page; if (!p) return null;
    const asks = [];
    for (const f of p.forms || []) for (const k of ["password", "card", "otp", "national_id"]) if (f[`asks_${k}`] && !asks.includes(t(`ask_${k}`))) asks.push(t(`ask_${k}`));
    return facts([[t("f_title"), p.title], [t("f_status"), p.status], [t("f_asks"), asks.length ? asks.join(" · ") : null], [t("f_crawled"), v.pages_crawled || null]]);
  }

  function scriptTable(v) {
    const scripts = ((v.page && v.page.scripts) || []).filter((s) => s.obfuscated || (s.endpoints || []).length || (s.suspicious_calls || []).length || (s.redirects || []).length);
    return scripts.length ? h("div", { class: "scroll-x" }, h("table", { class: "scripts" },
        h("thead", {}, h("tr", {}, h("th", {}, t("script_src")), h("th", {}, ""), h("th", {}, t("script_endpoints")), h("th", {}, t("script_calls")))),
        h("tbody", {}, scripts.map((s) => h("tr", {},
          h("td", { class: "src" }, s.src || `<${t("script_inline")}>`),
          h("td", {}, h("span", { class: "chip" }, s.first_party ? t("script_first") : t("script_third")), s.obfuscated ? h("span", { class: "chip", style: { marginInlineStart: "4px", color: "var(--block-ink)" } }, t("script_obf")) : null,
            (s.obfuscation_markers || []).length ? h("div", { class: "muted mono", style: { fontSize: "11px", marginTop: "2px" } }, s.obfuscation_markers.join(", ")) : null),
          h("td", { class: "src" }, [...(s.endpoints || []), ...(s.redirects || [])].join("\n")),
          h("td", {}, (s.suspicious_calls || []).join(", "))))))) : null;
  }

  function hbars(rows, max, fmt, colour) {
    return h("div", { class: "bars" }, rows.map(([label, val, mono]) => h("div", { class: "hbar" },
      h("span", { class: `lbl${mono ? " mono" : ""}`, title: label }, label),
      h("span", { class: "track" }, h("i", { class: colour ? colour(val) : "", style: { width: `${Math.min(100, (val / max) * 100)}%` } })),
      h("span", { class: "val" }, fmt(val)))));
  }

  function renderDetail() {
    const box = $("#detail");
    const v = state.selected && state.verdicts.get(state.selected);
    if (!v) {
      box.replaceChildren(h("div", { class: "empty-detail" }, h("div", {},
        h("svg:svg", { viewBox: "0 0 24 24" }, h("svg:path", { d: "M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" })), h("div", {}, t("detail_empty")))));
      return;
    }
    const card = state.live.get(v.id);
    const d = decisionOf(v);
    const tm = v.timings_ms || {};
    const models = [[t("m_url"), v.url_model_score], [t("m_page"), v.page_model_score], [t("m_llm"), v.llm_score]].filter(([, x]) => x != null);
    const raw = Object.entries(tm).filter(([k]) => k !== "total").sort((a, b) => b[1] - a[1]);
    const stages = stageTimings(tm);
    const overturned = v.review && v.review.outcome === "overturned";
    box.replaceChildren(...[
      h("button", { class: "secondary back", type: "button", onclick: () => document.body.classList.remove("detail-open") }, "← ", t("btn_back")),
      h("div", { class: "dhead" }, gauge(v.risk_score, d),
        h("div", { class: "dtitle" },
          h("div", { class: "host" }, v.host || v.url),
          h("div", { class: "url" }, v.final_url && v.final_url !== v.url ? `${v.url}  →  ${v.final_url}` : v.url),
          h("div", { class: "row" },
            v.final === false && !v.decision ? badge("pending", t("d_pending")) : overturned ? badge("cleared", t("d_cleared")) : badge(d),
            v.final === false ? h("span", { class: "chip" }, t("pending")) : null,
            card && card.revoked ? h("span", { class: "chip", style: { color: "var(--block-ink)", fontWeight: 700 } }, t("revoked")) : null,
            h("span", { class: "chip" }, `${t("stage")}: ${t(`s_${v.stage}`)}`),
            sourceOf(v) === "watcher" ? h("span", { class: "chip watch" }, t("source_watcher")) : null,
            v.evidence_ref ? h("span", { class: "chip mono", title: t("ev_case") }, v.evidence_ref) : null,
            v.campaign_id ? h("span", { class: "chip mono", style: { cursor: "pointer" }, onclick: () => openCampaign(v.campaign_id) }, `${t("f_campaign")} ${v.campaign_id}`) : null),
          h("div", { class: "muted", style: { fontSize: "12px", marginTop: "6px" } }, `${t("first_seen")}: ${fmtDate(v.created_at)}`))),
      loc(v, "summary") ? textBlock(fixPlural(loc(v, "summary")), "summary") : null,
      h("div", { class: "actions" },
        h("a", { class: "primary", href: api.evidenceUrl(v.id), onclick: (e) => { e.preventDefault(); downloadEvidence(v.id, e.currentTarget); } },
          h("svg:svg", { viewBox: "0 0 24 24" }, h("svg:path", { d: "M12 3v12m0 0-5-5m5 5 5-5M4 21h16" })), h("span", { class: "lbl" }, t("btn_evidence"))),
        h("span", { class: "hint", style: { margin: 0 } })),
      section(t("sec_reasons"), h("div", { class: "sub" }, t("sec_reasons_hint")), reasonsList(v)),
      d !== "allow" || state.evidenceByVerdict.has(v.id) ? section([camera(), " ", t("sec_evidence")], evidencePanel(v)) : null,
      (d === "block" || v.review || (card && card.seenDecisions.includes("block"))) ? section(t("sec_review"), reviewPanel(v)) : null,
      v.brand ? section(t("sec_brand"), brandPanel(v)) : null,
      section(t("sec_chain"), chainDiagram(v)),
      h("div", { class: "grid2" }, section(t("sec_domain"), domainFacts(v)), section(t("sec_page"), pageFacts(v))),
      section(t("scripts"), scriptTable(v)),
      h("div", { class: "grid2" },
        models.length ? section(t("sec_models"), hbars(models, 1, pct, (x) => (x >= 0.7 ? "hot" : x >= 0.35 ? "mid" : "cool"))) : null,
        raw.length ? section(t("sec_timings"), timingPanel(stages, raw)) : null),
    ].filter(Boolean));
  }

  async function select(id) {
    state.selected = id;
    document.querySelectorAll("#feed .card.sel").forEach((el) => el.classList.remove("sel"));
    const el = document.querySelector(`#feed [data-id="${CSS.escape(id)}"]`);
    if (el) el.classList.add("sel");
    document.body.classList.add("detail-open");
    renderDetail();
    if (matchMedia("(max-width: 860px)").matches) window.scrollTo({ top: 0 });
    await loadFull(id);
  }
  async function loadFull(id) {
    try { upsertVerdict(await api.get(id)); } catch (e) { return; }
    refreshCard(id);
    if (state.selected === id) renderDetail();
  }

  async function runReview(id) {
    state.reviewing.add(id);
    state.reviewSteps.delete(id);
    renderDetail();
    try {
      const result = await api.review(id);
      if (result && result.id) { state.reviewing.delete(id); upsertVerdict(result, { event: "verdict.reviewed" }); refreshCard(id); renderDetail(); renderSide(); }
    } catch (e) {
      state.reviewing.delete(id); renderDetail();
      const box = $("#detail .review"); if (box) box.prepend(h("div", { class: "hint err" }, t("review_failed", { err: e.message })));
    }
  }

  async function downloadEvidence(id, link) {
    if (link.getAttribute("aria-busy") === "true") return;
    const label = link.querySelector(".lbl"); const hint = link.parentElement.querySelector(".hint");
    link.setAttribute("aria-busy", "true"); label.textContent = t("btn_evidence_busy"); hint.textContent = ""; hint.classList.remove("err");
    try {
      const r = await fetch(api.evidenceUrl(id));
      if (!r.ok) throw new Error((await r.text()).slice(0, 200) || `HTTP ${r.status}`);
      const name = ((r.headers.get("content-disposition") || "").match(/filename="?([^";]+)"?/) || [])[1] || `mirsad-${id.slice(0, 8)}.zip`;
      const url = URL.createObjectURL(await r.blob());
      const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      hint.textContent = name;
      state.evidenceSummary.delete(id);
      loadEvidence().then(() => { refreshCard(id); if (state.selected === id) loadEvidenceSummary(id); });
    } catch (e) {
      hint.classList.add("err"); hint.textContent = t("evidence_failed", { err: e.message });
    } finally { link.removeAttribute("aria-busy"); label.textContent = t("btn_evidence"); }
  }

  /* ---------- events ---------- */
  const pendingLoads = new Map();
  function scheduleLoad(id, delay = 250) {
    clearTimeout(pendingLoads.get(id));
    pendingLoads.set(id, setTimeout(() => { pendingLoads.delete(id); loadFull(id).then(renderSide); }, delay));
  }
  function onEvent(ev) {
    if (ev.type === "host.updated") { onHostUpdated(ev); return; }
    if (ev.type === "evidence.ready") { onEvidenceReady(ev); return; }
    const id = ev.verdict_id;
    if (!id) return;
    if (ev.type === "review.step") {
      const steps = state.reviewSteps.get(id) || [];
      steps.push(ev); state.reviewSteps.set(id, steps); state.reviewing.add(id);
      if (state.selected === id) renderDetail();
      return;
    }
    if (ev.type === "investigation.started") {
      upsertVerdict({ id, url: ev.url, host: ev.host, stage: "reputation", final: false, created_at: new Date((ev.ts || Date.now() / 1000) * 1000).toISOString(), timings_ms: {} }, { fresh: true });
      if (state.pendingCheck && (ev.url === state.pendingCheck || ev.host === state.pendingCheckHost)) { state.pendingCheck = null; select(id); }
      renderFeed();
      renderSide();
      return;
    }
    const patch = { id };
    for (const k of ["url", "host", "decision", "risk_score", "stage", "final", "summary_en", "summary_ar"]) if (ev[k] !== undefined) patch[k] = ev[k];
    if (ev.type === "verdict.reviewed") { state.reviewing.delete(id); state.reviewSteps.delete(id); patch.final = true; }
    upsertVerdict(patch, { event: ev.type });
    if (ev.host && dropPhantoms(ev.host, id)) renderFeed(); else refreshCard(id);
    if (state.selected === id) renderDetail();
    scheduleLoad(id, ev.type === "layer.done" ? 400 : 100);
  }
  function renderRecentChecks() {
    const rows = state.recentChecks.map((id) => state.verdicts.get(id)).filter(Boolean);
    $("#recent-checks").replaceChildren(...(rows.length ? [h("li", { class: "rc-title muted" }, t("recent_checks"))] : []),
      ...rows.map((v) => h("li", { onclick: () => select(v.id), title: v.url }, v.decision ? badge(v.decision) : badge("pending", t("d_pending")),
        h("span", { class: "host" }, v.host || v.url), h("span", { class: "when" }, ago(v.created_at)))));
  }
  function renderSide() { renderStats(); renderEarly(); renderRecentChecks(); }

  /* ---------- check a URL ---------- */
  $("#check").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#check-url"); const msg = $("#check-msg"); const btn = $("#check button");
    const raw = input.value.trim();
    msg.classList.remove("err");
    if (!raw) { msg.textContent = t("check_empty"); return; }
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    state.pendingCheck = url;
    try { state.pendingCheckHost = new URL(url).hostname; } catch (err) { state.pendingCheckHost = null; }
    msg.textContent = t("check_running", { url: raw });
    btn.disabled = true;
    try {
      const v = await api.check(url);
      upsertVerdict(v, { fresh: !state.live.has(v.id) });
      if (v.host) dropPhantoms(v.host, v.id);
      state.recentChecks = [v.id, ...state.recentChecks.filter((x) => x !== v.id)].slice(0, 3);
      store("ss.recent", JSON.stringify(state.recentChecks));
      state.pendingCheck = null;
      renderFeed();
      select(v.id);
      msg.textContent = t("check_done");
      follow(v.id);
    } catch (err) {
      msg.classList.add("err");
      msg.textContent = t("check_error", { err: err.message });
    } finally { btn.disabled = false; renderSide(); }
  });
  /* Without live events, keep polling a checked verdict until its deeper layers finish. */
  async function follow(id) {
    for (let i = 0; i < 40 && state.conn !== "live"; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      await loadFull(id);
      const v = state.verdicts.get(id);
      if (v && v.final) break;
    }
    renderSide();
  }

  /* ---------- evidence ---------- */
  const camera = () => h("svg:svg", { class: "cam", viewBox: "0 0 24 24", "aria-hidden": "true" },
    h("svg:path", { d: "M4 8h3l2-3h6l2 3h3v11H4z" }), h("svg:circle", { cx: 12, cy: 13, r: 3.5 }));
  const shortHash = (x) => (x ? `${x.slice(0, 12)}…${x.slice(-6)}` : "–");
  const sizeOf = (n) => (n == null ? "–" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const stamp = (s) => (s ? [h("div", {}, fmtDate(s.gst || s.utc)), h("div", { class: "muted mono", style: { fontSize: "11px" } }, `${(s.utc || "").replace("T", " ").slice(0, 19)} UTC`)] : "–");

  function indexEvidence(cases) {
    state.evidenceCases = cases;
    state.evidenceByVerdict = new Map();
    for (const c of cases) for (const id of c.verdict_ids || []) state.evidenceByVerdict.set(id, c);
  }
  async function loadEvidence() {
    try { indexEvidence(await api.evidenceList()); state.evidenceError = null; } catch (e) { state.evidenceError = e.message; }
    renderEvidenceTab();
  }
  async function loadEvidenceSummary(id) {
    try {
      state.evidenceSummary.set(id, { data: await api.evidenceSummary(id) });
    } catch (e) {
      state.evidenceSummary.set(id, { error: e.reason || e.message, state: e.state || "none" });
    }
    if (state.selected === id) renderDetail();
  }
  let evidenceReload = null;
  function onEvidenceReady(ev) {
    state.evidenceSummary.delete(ev.verdict_id);
    clearTimeout(evidenceReload);
    evidenceReload = setTimeout(async () => {
      await loadEvidence();
      refreshCard(ev.verdict_id);
      if (state.selected === ev.verdict_id) loadEvidenceSummary(ev.verdict_id);
    }, 300);
  }

  function lightbox(src, caption) {
    const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const box = h("div", { class: "lightbox", role: "dialog", "aria-label": caption, onclick: close },
      h("figure", {}, h("img", { src, alt: caption }), h("figcaption", {}, caption)));
    document.addEventListener("keydown", onKey);
    document.body.append(box);
  }

  function shotFigure(id, view, info) {
    const label = t(view === "live" ? "ev_live" : "ev_engine");
    const note = t(view === "live" ? "ev_live_note" : "ev_engine_note");
    if (!info || !info.file) {
      return h("figure", { class: "shot missing" }, h("figcaption", {}, h("strong", {}, label), h("span", {}, note)),
        h("div", { class: "shot-missing" }, t("ev_not_captured"), info && info.error ? h("div", { class: "mono", dir: "ltr" }, info.error) : null));
    }
    const src = api.screenshotUrl(id, view);
    return h("figure", { class: "shot" }, h("figcaption", {}, h("strong", {}, label), h("span", {}, note)),
      h("button", { type: "button", class: "shot-btn", onclick: () => lightbox(src, `${label} · ${note}`) }, h("img", { src, alt: label, loading: "lazy" })));
  }

  function evidencePanel(v) {
    const entry = state.evidenceSummary.get(v.id);
    if (!entry) { loadEvidenceSummary(v.id); return h("div", { class: "muted" }, t("loading")); }
    if (entry.error) {
      const st = entry.state;
      return h("div", { class: "evidence empty-ev" },
        h("div", { class: st === "failed" ? "hint err" : "muted" }, st === "queued" || st === "building" ? [h("span", { class: "pulse" }), " ", t(`ev_${st}`)] : entry.error),
        h("div", { class: "muted", style: { fontSize: "12px", marginTop: "4px" } }, t("ev_capture_hint")));
    }
    const s = entry.data;
    const reg = s.registration || {}; const host = s.hosting || {}; const tls = s.tls || {}; const abuse = s.abuse_contacts || {};
    const views = s.views || {};
    const file = (name) => api.evidenceFileUrl(s.case_ref, name);
    const has = (name) => (s.files || []).some((f) => f.name === name);
    const button = (name, label) => (has(name) ? h("a", { class: "secondary", href: file(name), target: "_blank", rel: "noopener" }, label) : null);
    return h("div", { class: "evidence" },
      h("div", { class: "ev-head" },
        h("div", {}, h("div", { class: "muted ev-k" }, t("ev_case")), h("div", { class: "mono ev-ref" }, s.case_ref)),
        h("div", {}, h("div", { class: "muted ev-k" }, t("ev_captured")), stamp(s.captured_at)),
        h("div", {}, h("div", { class: "muted ev-k" }, t("ev_detected")), stamp(s.detected_at))),
      views.differs ? h("div", { class: "cloak" }, h("strong", {}, t("ev_cloak_title")), h("div", {}, t("ev_cloak_body")),
        (views.notes || []).length ? h("div", { class: "mono", dir: "ltr", style: { fontSize: "11.5px", marginTop: "4px" } }, views.notes.join(" · ")) : null)
        : views.compared ? h("div", { class: "muted", style: { fontSize: "12px", margin: "8px 0" } }, t("ev_views_match", { n: Math.round((views.similarity || 0) * 100) })) : null,
      h("div", { class: "shots" }, shotFigure(v.id, "live", (s.screenshots || {}).live), shotFigure(v.id, "engine", (s.screenshots || {}).engine)),
      h("div", { class: "actions" },
        button("report.pdf", t("ev_pdf")), button("takedown_request.txt", t("ev_takedown")), button("takedown_request_ar.txt", t("ev_takedown_ar")),
        h("a", { class: "secondary", href: api.evidenceUrl(v.id), download: "" }, t("ev_zip"))),
      h("div", { class: "grid2" },
        h("div", {}, h("h4", {}, t("ev_registration")), facts([
          [t("f_registrar"), reg.registrar ? `${reg.registrar}${reg.registrar_iana_id ? ` (IANA ${reg.registrar_iana_id})` : ""}` : null],
          [t("f_created"), reg.created ? fmtDate(reg.created) : null], [t("f_age"), reg.age_days != null ? t("days", { n: reg.age_days }) : null],
          [t("f_country"), reg.registrant_country], [t("f_ns"), reg.nameservers, true], [t("ev_abuse_registrar"), abuse.registrar, true]]) || h("div", { class: "muted" }, "–")),
        h("div", {}, h("h4", {}, t("ev_hosting")), facts([
          [t("f_ips"), host.ips, true], [t("f_asn"), host.asn ? `AS${host.asn}${host.network ? ` · ${host.network}` : ""}` : host.network],
          [t("f_hosting"), host.country], [t("f_tls"), tls.issuer], [t("ev_abuse_hosting"), abuse.hosting, true]]) || h("div", { class: "muted" }, "–"))),
      Object.keys(s.unavailable || {}).length ? h("div", { class: "ev-missing" }, h("h4", {}, t("ev_unavailable")),
        h("ul", {}, Object.entries(s.unavailable).map(([name, why]) => h("li", {}, h("span", { class: "mono" }, name), " — ", h("span", { class: "muted", dir: "auto" }, why))))) : null,
      h("details", { class: "ev-files" }, h("summary", {}, t("ev_files", { n: (s.files || []).length })),
        h("div", { class: "scroll-x" }, h("table", { class: "scripts" },
          h("thead", {}, h("tr", {}, h("th", {}, t("ev_file")), h("th", {}, t("ev_size")), h("th", {}, "SHA-256"))),
          h("tbody", {}, (s.files || []).map((f) => h("tr", {},
            h("td", { class: "src" }, h("a", { href: file(f.name), target: "_blank", rel: "noopener" }, f.name)),
            h("td", { class: "nowrap" }, sizeOf(f.bytes)),
            h("td", { class: "src", title: f.sha256 }, shortHash(f.sha256)))))))));
  }

  function renderEvidenceTab() {
    const grid = $("#ev-grid");
    if (!grid) return;
    const q = state.evidenceQuery.toLowerCase();
    const cases = (state.evidenceCases || []).filter((c) => !q || c.host.includes(q) || (c.brand || "").toLowerCase().includes(q)
      || (c.brand_ar || "").includes(q) || c.case_ref.toLowerCase().includes(q));
    $("#ev-count").textContent = t("ev_count", { n: cases.length });
    if (state.evidenceError) { grid.replaceChildren(h("div", { class: "empty" }, t("ev_list_error", { err: state.evidenceError }))); return; }
    if (!cases.length) { grid.replaceChildren(h("div", { class: "empty" }, t("ev_list_empty"))); return; }
    grid.replaceChildren(...cases.map((c) => h("button", { type: "button", class: "ev-card", onclick: () => openVerdict(c.verdict_ids[c.verdict_ids.length - 1], c.host) },
      h("div", { class: "thumb" }, c.thumbnail ? h("img", { src: api.thumbnailUrl(c.case_ref), alt: "", loading: "lazy" }) : h("div", { class: "no-thumb" }, camera(), t("ev_no_image"))),
      h("div", { class: "ev-body" },
        h("div", { class: "hhost" }, c.host),
        h("div", { class: "row" }, badge(c.decision), h("span", { class: "num" }, Math.round(c.risk_score ?? 0)),
          c.views_differ ? h("span", { class: "chip cloak-chip" }, t("ev_cloak_chip")) : null),
        c.brand ? h("div", { class: "ev-brand" }, `${t("brand_claims")}: ${state.lang === "ar" && c.brand_ar ? c.brand_ar : c.brand}`) : null,
        h("div", { class: "muted ev-when" }, `${fmtDate(c.captured_at)} · ${ago(c.captured_at)}`),
        h("div", { class: "mono muted", style: { fontSize: "11px" } }, c.case_ref)))));
  }
  $("#ev-q").addEventListener("input", (e) => { state.evidenceQuery = e.target.value.trim(); renderEvidenceTab(); });

  /* ---------- reputation table ---------- */
  const REP_ORDER = { blocked: 0, suspicious: 1, unknown: 2, established: 3, trusted: 4 };
  const OPTIONAL = new Set(["popularity_rank", "domain_age_days", "first_seen"]); // hidden while the side panel is open on narrower screens
  const HOST_COLUMNS = [
    ["host", "h_host", (r) => r.host],
    ["reputation", "h_reputation", (r) => REP_ORDER[r.reputation]],
    ["risk_score", "h_decision", (r) => r.risk_score],
    ["visits", "h_visits", (r) => r.visits],
    ["popularity_rank", "h_rank", (r) => r.popularity_rank],
    ["domain_age_days", "h_age", (r) => r.domain_age_days],
    ["first_seen", "h_first_seen", (r) => toDate(r.first_seen)?.getTime()],
    ["last_checked", "h_last_checked", (r) => toDate(r.last_checked)?.getTime()],
    ["last_changed", "h_last_changed", (r) => toDate(r.last_changed)?.getTime()],
  ];
  const dash = "–";
  const days = (n) => (n === 1 ? t("day_one") : t("days", { n: num(n) }));
  /* Arabic counts take the singular for 1, the dual for 2, the plural for 3-10 and the singular again from 11. */
  const visits = (n) => (n === 1 ? t("visit_one") : n === 2 ? t("visit_two")
    : n >= 3 && n <= 10 ? t("visits_few", { n: num(n) }) : t("n_visits", { n: num(n) }));
  const num = (n) => (n == null ? dash : new Intl.NumberFormat(state.lang === "ar" ? "ar-AE-u-nu-latn" : "en-GB").format(n));
  const repBadge = (rep) => (rep ? h("span", { class: `rep ${rep}` }, t(`rep_${rep}`)) : h("span", { class: "muted" }, dash));

  function sparkline(values, { w = 84, h: ht = 22, big = false } = {}) {
    if (!values || !values.length) return h("span", { class: "spark-empty" });
    const max = Math.max(1, ...values);
    const step = w / Math.max(values.length - 1, 1);
    const pts = values.map((v, i) => [i * step, ht - 2 - (v / max) * (ht - 4)]);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const kids = [
      h("svg:path", { d: `${line} L${w} ${ht} L0 ${ht} Z`, class: "spark-fill" }),
      h("svg:path", { d: line, class: "spark-line" }),
      h("svg:circle", { cx: pts[pts.length - 1][0], cy: pts[pts.length - 1][1], r: big ? 3 : 2, class: "spark-dot" }),
    ];
    if (big) {
      kids.unshift(h("svg:line", { x1: 0, x2: w, y1: ht - 0.5, y2: ht - 0.5, class: "spark-axis" }));
      values.forEach((v, i) => kids.push(h("svg:rect", { x: i * step - step / 2, y: 0, width: step, height: ht, fill: "transparent" }, h("svg:title", {}, `${t("hours_ago", { n: values.length - 1 - i })}: ${v}`))));
    }
    return h("svg:svg", { class: big ? "spark big" : "spark", viewBox: `0 0 ${w} ${ht}`, width: big ? null : w, height: big ? null : ht, preserveAspectRatio: "none", "aria-hidden": big ? null : "true" }, kids);
  }

  /* Sparklines need each host's hourly visits, which only the history endpoint carries: fetch them lazily. */
  const historyQueue = [];
  let historyActive = 0;
  function wantHistory(host) {
    const cached = state.hostHistory.get(host);
    if ((cached && Date.now() - cached.at < 60000) || historyQueue.includes(host)) return;
    historyQueue.push(host);
    pumpHistory();
  }
  function pumpHistory() {
    while (historyActive < 6 && historyQueue.length) {
      const host = historyQueue.shift();
      historyActive++;
      api.history(host).then((data) => {
        state.hostHistory.set(host, { at: Date.now(), data });
        const cell = document.querySelector(`#hosts-table tr[data-host="${CSS.escape(host)}"] .spark-cell`);
        if (cell) cell.replaceChildren(sparkline(data.visits_hourly));
        if (state.hostSelected === host) renderHostPanel();
      }).catch(() => state.hostHistory.set(host, { at: Date.now(), data: null }))
        .finally(() => { historyActive--; pumpHistory(); });
    }
  }

  const HOST_FILTERS = {
    all: () => true,
    blocked: (r) => r.decision === "block" || r.reputation === "blocked",
    warned: (r) => r.decision === "warn",
    trusted: (r) => r.reputation === "trusted" || r.reputation === "established",
    watcher: (r) => r.source === "watcher",
    users: (r) => r.source === "user" || r.source === "gateway",
  };
  const SORT_ONLY = { last_seen: (r) => toDate(r.last_seen)?.getTime() };
  function sortedHosts() {
    const col = HOST_COLUMNS.find((c) => c[0] === state.hostSort.key);
    const get = col ? col[2] : SORT_ONLY[state.hostSort.key] || SORT_ONLY.last_seen;
    const dir = state.hostSort.dir;
    return state.hosts.filter(HOST_FILTERS[state.hostFilter] || HOST_FILTERS.all).sort((a, b) => {
      const x = get(a), y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
  }

  function renderHosts() {
    const tableEl = $("#hosts-table");
    $("#hosts-count").textContent = t("hosts_count", { n: state.hosts.length });
    if (state.hostsError) {
      tableEl.replaceChildren(h("tbody", {}, h("tr", {}, h("td", { class: "empty" }, t("hosts_error", { err: state.hostsError })))));
      return;
    }
    const anyChange = state.hosts.some((r) => r.last_changed);
    const columns = HOST_COLUMNS.filter(([key]) => key !== "last_changed" || anyChange);
    $("#hosts-filters").replaceChildren(...Object.keys(HOST_FILTERS).map((key) => h("button", { type: "button", class: `fchip${state.hostFilter === key ? " on" : ""}`,
      "aria-pressed": String(state.hostFilter === key), onclick: () => { state.hostFilter = key; renderHosts(); } },
      t(`hf_${key}`), h("span", { class: "n" }, state.hosts.filter(HOST_FILTERS[key]).length))));
    const head = h("thead", {}, h("tr", {}, columns.map(([key, label]) => {
      const active = state.hostSort.key === key;
      return h("th", { "aria-sort": active ? (state.hostSort.dir > 0 ? "ascending" : "descending") : "none", class: key === "host" ? "c-host" : OPTIONAL.has(key) ? "opt" : "" },
        h("button", { type: "button", onclick: () => { state.hostSort = { key, dir: active ? -state.hostSort.dir : key === "host" ? 1 : -1 }; renderHosts(); } },
          t(label), h("span", { class: "arrow" }, active ? (state.hostSort.dir > 0 ? "▲" : "▼") : "")));
    })));
    const rows = sortedHosts();
    const body = h("tbody", {}, rows.length ? rows.map((r, i) => {
      const hist = state.hostHistory.get(r.host);
      if (i < 80) wantHistory(r.host);
      const flash = state.hostFlash.has(r.host);
      return h("tr", { "data-host": r.host, tabindex: "0", class: [state.hostSelected === r.host ? "sel" : "", flash ? "flash-row" : ""].join(" "),
        onclick: () => openHost(r.host), onkeydown: (e) => { if (e.key === "Enter") openHost(r.host); } },
        h("td", { class: "c-host" }, h("div", { class: "hhost" }, r.host),
          r.owner || r.campaign_id || r.source === "watcher" ? h("div", { class: "hsub" },
            r.owner ? h("span", { class: "chip" }, r.owner) : null,
            r.source === "watcher" ? h("span", { class: "chip watch" }, t("source_watcher")) : null,
            r.campaign_id ? h("span", { class: "chip mono" }, r.campaign_id) : null) : null),
        h("td", {}, repBadge(r.reputation), r.blocklisted ? h("span", { class: "chip", style: { marginInlineStart: "4px", color: "var(--block-ink)" } }, t("f_block")) : null),
        h("td", { class: "nowrap" }, r.decision ? badge(r.decision) : h("span", { class: "muted" }, dash), " ",
          h("span", { class: "num" }, r.risk_score == null ? dash : Math.round(r.risk_score))),
        h("td", { class: "nowrap" }, h("div", { class: "visits" }, h("span", { class: "spark-cell" }, hist && hist.data ? sparkline(hist.data.visits_hourly) : h("span", { class: "spark-empty" })),
          h("span", {}, h("div", { class: "num" }, visits(r.visits)), h("div", { class: "muted v24" }, t("n_24h", { n: num(r.visits_24h) }))))),
        h("td", { class: "num opt" }, r.popularity_rank == null ? dash : `#${num(r.popularity_rank)}`),
        h("td", { class: "nowrap opt" }, r.domain_age_days == null ? dash : days(r.domain_age_days)),
        h("td", { class: "nowrap muted opt", title: r.first_seen ? fmtDate(r.first_seen) : "" }, r.first_seen ? ago(r.first_seen) : dash),
        h("td", { class: "nowrap muted", title: r.last_checked ? fmtDate(r.last_checked) : "" }, r.last_checked ? ago(r.last_checked) : dash),
        anyChange ? h("td", { class: "nowrap", title: r.last_changed ? fmtDate(r.last_changed) : "" }, r.last_changed ? [h("span", { class: `kind k-${r.last_change_kind || "other"}` }, tOr(`ch_${r.last_change_kind}`, r.last_change_kind || dash)), " ", h("span", { class: "muted" }, ago(r.last_changed))] : dash) : null);
    }) : h("tr", {}, h("td", { class: "empty", colspan: columns.length }, t("hosts_empty"))));
    tableEl.replaceChildren(head, body);
    state.hostFlash.clear();
  }

  function renderHostPanel() {
    const panel = $("#host-panel");
    const host = state.hostSelected;
    document.body.classList.toggle("host-open", Boolean(host));
    if (!host) { panel.hidden = true; return; }
    panel.hidden = false;
    const row = state.hosts.find((r) => r.host === host) || { host };
    const cached = state.hostHistory.get(host);
    const hist = cached && cached.data;
    const r = { ...row, ...(hist ? hist.row : {}) };
    const changes = hist ? [...hist.changes].sort((a, b) => toDate(b.at) - toDate(a.at)) : [];
    const when = (v) => v.created_at || v.updated_at || v.at;
    const verdicts = hist ? [...hist.verdicts].sort((a, b) => toDate(when(b)) - toDate(when(a))) : [];
    const hourly = hist ? hist.visits_hourly : [];
    const recheckBusy = state.recheckBusy === host;
    panel.replaceChildren(
      h("div", { class: "hp-head" },
        h("button", { class: "tool close", type: "button", "aria-label": t("btn_close"), onclick: () => { state.hostSelected = null; renderHostPanel(); renderHosts(); } }, "×"),
        h("div", { class: "hp-host" }, r.host),
        h("div", { class: "row" }, repBadge(r.reputation), r.decision ? badge(r.decision) : null,
          r.risk_score != null ? h("span", { class: "chip" }, `${t("risk")} ${Math.round(r.risk_score)}`) : null,
          r.owner ? h("span", { class: "chip" }, r.owner) : null)),
      h("div", { class: "actions" },
        h("button", { class: "primary", type: "button", disabled: recheckBusy || null, onclick: () => recheck(host) }, recheckBusy ? t("recheck_busy") : t("btn_recheck")),
        h("span", { class: "hint", id: "recheck-msg" }, state.recheckMsg && state.recheckMsg.host === host ? state.recheckMsg.text : "")),
      section(t("hp_visits"), h("div", { class: "spark-wrap" }, hist ? sparkline(hourly, { w: 360, h: 90, big: true }) : h("div", { class: "muted" }, dash),
        h("div", { class: "spark-axis-labels" }, h("span", {}, t("hours_ago", { n: 24 })), h("span", {}, t("hours_ago", { n: 12 })), h("span", {}, t("now")))),
        facts([[t("h_visits"), num(r.visits)], [t("h_visits_24h"), num(r.visits_24h)], [t("h_peak"), hourly.length ? num(Math.max(...hourly)) : null]])),
      section(t("hp_facts"), facts([
        [t("h_rank"), r.popularity_rank == null ? dash : `#${num(r.popularity_rank)}`], [t("h_age"), r.domain_age_days == null ? dash : days(r.domain_age_days)],
        [t("h_first_seen"), r.first_seen ? fmtDate(r.first_seen) : dash], [t("h_last_seen"), r.last_seen ? fmtDate(r.last_seen) : dash],
        [t("h_last_checked"), r.last_checked ? fmtDate(r.last_checked) : dash], [t("f_campaign"), r.campaign_id || dash, true],
        [t("h_source"), r.source ? tOr(`source_${r.source}`, r.source) : dash]])),
      section(t("hp_changes"), hist ? (changes.length ? h("ol", { class: "timeline" }, changes.map((c) => h("li", { class: `k-${c.kind || "other"}` },
        h("div", { class: "tl-head" }, h("span", { class: `kind k-${c.kind || "other"}` }, tOr(`ch_${c.kind}`, c.kind || dash)), h("span", { class: "muted" }, `${fmtDate(c.at)} · ${ago(c.at)}`)),
        c.old != null || c.new != null ? h("div", { class: "tl-diff" }, h("span", { class: "old" }, c.old == null ? dash : String(c.old)), " → ", h("span", { class: "new" }, c.new == null ? dash : String(c.new))) : null)))
        : h("div", { class: "muted" }, t("hp_no_changes"))) : h("div", { class: "muted" }, t("loading"))),
      section(t("hp_verdicts"), hist ? (verdicts.length ? h("ol", { class: "hverdicts" }, verdicts.slice(0, 12).map((v) => h("li", { tabindex: "0", onclick: () => openVerdict(v.id, r.host), onkeydown: (e) => { if (e.key === "Enter") openVerdict(v.id, r.host); } },
        v.decision ? badge(v.decision) : null, h("span", { class: "num" }, v.risk_score == null ? dash : Math.round(v.risk_score)),
        v.stage ? h("span", { class: "chip" }, t(`s_${v.stage}`)) : null, v.source === "watcher" ? h("span", { class: "chip watch" }, t("source_watcher")) : null,
        h("span", { class: "muted when" }, ago(when(v))))))
        : h("div", { class: "muted" }, t("hp_no_verdicts"))) : null),
    );
  }

  function openHost(host) {
    state.hostSelected = host;
    state.hostHistory.delete(host);
    document.querySelectorAll("#hosts-table tr.sel").forEach((el) => el.classList.remove("sel"));
    const tr = document.querySelector(`#hosts-table tr[data-host="${CSS.escape(host)}"]`);
    if (tr) tr.classList.add("sel");
    renderHostPanel();
    wantHistory(host);
  }
  function openVerdict(id, host) {
    switchTab("live");
    if (!state.verdicts.has(id)) upsertVerdict({ id, host, url: host, final: true });
    renderFeed();
    select(id);
  }
  async function recheck(host) {
    state.recheckBusy = host;
    state.recheckMsg = null;
    renderHostPanel();
    try {
      const v = await api.check(`https://${host}`);
      upsertVerdict(v, { fresh: !state.live.has(v.id) });
      renderFeed(); renderSide();
      state.recheckMsg = { host, text: `${t(`d_${v.decision}`)} · ${t("risk")} ${Math.round(v.risk_score)}` };
    } catch (e) {
      state.recheckMsg = { host, text: t("check_error", { err: e.message }) };
    }
    state.recheckBusy = null;
    state.hostHistory.delete(host);
    await loadHosts();
    wantHistory(host);
  }

  async function loadHosts() {
    try { state.hosts = await api.hosts(state.hostQuery); state.hostsError = null; } catch (e) { state.hostsError = e.message; state.hosts = []; }
    renderHosts();
    renderHostPanel();
  }
  let hostReload = null;
  function onHostUpdated(ev) {
    const host = ev.host;
    if (!host) return;
    state.hostHistory.delete(host);
    const row = state.hosts.find((r) => r.host === host);
    const fields = Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "type" && k !== "ts"));
    if (row) Object.assign(row, fields);
    else if ("reputation" in ev && (!state.hostQuery || host.includes(state.hostQuery.toLowerCase()))) state.hosts.push(fields);
    else { clearTimeout(hostReload); hostReload = setTimeout(loadHosts, 1000); }
    state.hostFlash.add(host);
    if (!$("#view-hosts").hidden) {
      renderHosts();
      if (state.hostSelected === host) wantHistory(host);
    }
  }
  let searchTimer = null;
  $("#hosts-q").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.hostQuery = e.target.value.trim(); loadHosts(); }, 250);
  });

  /* ---------- campaigns ---------- */
  const LINK_KINDS = [
    [/content|structure|template|kit hash|kit/i, "cl_template"], [/favicon|icon/i, "cl_favicon"], [/\bip\b|hosting|server|asn|network/i, "cl_server"],
    [/name ?servers?|\bns\b/i, "cl_ns"], [/certificate|tls|san/i, "cl_cert"], [/exfil|endpoint|collector/i, "cl_collector"],
  ];
  /* "unattributed: 43 domains, linked by content hash" -> "43 sites built from the same page template". */
  function campaignTitle(c) {
    const raw = loc(c, "label");
    const m = (raw || "").match(/^(.*?):\s*(\d+)\s+domains?,\s*linked by\s+(.+)$/i);
    if (!m) return raw || c.id;
    const kind = (LINK_KINDS.find(([re]) => re.test(m[3])) || [null, "cl_other"])[1];
    const plain = t(kind, { n: m[2] });
    return /^unattributed$/i.test(m[1].trim()) ? plain : `${m[1].trim()} — ${plain}`;
  }
  const campDomains = (c) => (c.domains || []).map((d) => (typeof d === "string" ? { host: d } : d)).filter((d) => d.host);
  const campBlocked = (c) => campDomains(c).filter((d) => d.decision === "block").length;
  const campBranded = (c) => (c.brands || []).length > 0 || Boolean(c.brand) || !/^unattributed/i.test(c.label || "");

  function campaignGraph(c) {
    const doms = campDomains(c);
    const idx = new Map(doms.map((d, i) => [d.host, i]));
    const links = (c.links || c.edges || []).map((l) => ({ a: idx.get(l.source ?? l.a), b: idx.get(l.target ?? l.b), shared: [].concat(l.shared || l.label || []) }))
      .filter((l) => l.a != null && l.b != null);
    const nodes = doms.map((d) => ({ ...d }));
    if (!links.length) nodes.forEach((_, i) => { if (i) links.push({ a: 0, b: i, shared: (c.shared_attributes || []).map((s) => `${s.kind} ${s.value}`) }); });
    const box = $("#graph");
    const W = Math.max(320, box.clientWidth || 900);
    const H = Math.max(420, Math.min(1400, 160 + nodes.length * 22));
    box.style.height = `${H}px`;
    /* Force layout scaled to the canvas: repulsion keeps nodes apart, springs pull linked ones together. */
    const pad = 48;
    const area = (W - 2 * pad) * (H - 2 * pad);
    const k = Math.sqrt(area / Math.max(nodes.length, 1)) * 0.9;
    nodes.forEach((n, i) => { const a = (2 * Math.PI * i) / nodes.length; n.x = W / 2 + (W / 2 - pad) * 0.8 * Math.cos(a); n.y = H / 2 + (H / 2 - pad) * 0.8 * Math.sin(a); });
    const iters = nodes.length > 60 ? 220 : 320;
    for (let it = 0; it < iters; it++) {
      const temp = (W / 8) * (1 - it / iters) + 1;
      for (const n of nodes) { n.dx = 0; n.dy = 0; }
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const A = nodes[i], B = nodes[j]; let dx = A.x - B.x, dy = A.y - B.y; const d = Math.max(Math.hypot(dx, dy), 0.5);
        const f = (k * k) / d; dx /= d; dy /= d; A.dx += dx * f; A.dy += dy * f; B.dx -= dx * f; B.dy -= dy * f;
      }
      for (const l of links) {
        const A = nodes[l.a], B = nodes[l.b]; let dx = A.x - B.x, dy = A.y - B.y; const d = Math.max(Math.hypot(dx, dy), 0.5);
        const f = (d * d) / k / Math.sqrt(Math.max(1, links.length / nodes.length)); dx /= d; dy /= d; A.dx -= dx * f; A.dy -= dy * f; B.dx += dx * f; B.dy += dy * f;
      }
      for (const n of nodes) {
        const d = Math.max(Math.hypot(n.dx, n.dy), 0.5);
        n.x = Math.max(pad, Math.min(W - pad, n.x + (n.dx / d) * Math.min(d, temp)));
        n.y = Math.max(pad, Math.min(H - pad, n.y + (n.dy / d) * Math.min(d, temp)));
      }
    }
    /* Stretch the result to fill the canvas whatever shape the forces settled into. */
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    nodes.forEach((n) => {
      n.x = x1 - x0 > 1 ? pad + ((n.x - x0) / (x1 - x0)) * (W - 2 * pad) : W / 2;
      n.y = y1 - y0 > 1 ? pad + ((n.y - y0) / (y1 - y0)) * (H - 2 * pad) : H / 2;
    });
    const top = new Set(nodes.slice().sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0)).slice(0, nodes.length > 8 ? 5 : nodes.length).map((n) => n.host));
    const view = { s: 1, x: 0, y: 0 };
    const svg = h("svg:svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": c.id, direction: "ltr" });
    const scene = h("svg:g", {});
    svg.append(scene);
    const apply = () => scene.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.s})`);
    const toSvg = (e) => { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [px, py] = toSvg(e);
      const s = Math.max(0.4, Math.min(6, view.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      view.x = px - ((px - view.x) * s) / view.s; view.y = py - ((py - view.y) * s) / view.s; view.s = s; apply();
    }, { passive: false });
    let pan = null;
    svg.addEventListener("pointerdown", (e) => { if (e.target === svg) { pan = toSvg(e); svg.setPointerCapture(e.pointerId); } });
    svg.addEventListener("pointermove", (e) => { if (!pan) return; const [x, y] = toSvg(e); view.x += x - pan[0]; view.y += y - pan[1]; pan = [x, y]; apply(); });
    svg.addEventListener("pointerup", () => { pan = null; });

    const edgeEls = links.map((l) => {
      const line = h("svg:line", { class: "edge" }, h("svg:title", {}, l.shared.join(" · ")));
      scene.append(line);
      return { l, line };
    });
    const edgeLabel = h("svg:text", { class: "elabel", "text-anchor": "middle" });
    const place = () => edgeEls.forEach(({ l, line }) => {
      const A = nodes[l.a], B = nodes[l.b];
      line.setAttribute("x1", A.x); line.setAttribute("y1", A.y); line.setAttribute("x2", B.x); line.setAttribute("y2", B.y);
    });
    const focus = (host) => {
      scene.querySelectorAll(".node").forEach((g) => g.classList.toggle("show", top.has(g.dataset.host) || g.dataset.host === host || g.dataset.host === state.campNode));
      edgeEls.forEach(({ l, line }) => line.classList.toggle("hot", host != null && (nodes[l.a].host === host || nodes[l.b].host === host)));
      const first = host ? edgeEls.find(({ l }) => nodes[l.a].host === host || nodes[l.b].host === host) : null;
      if (first) {
        const A = nodes[first.l.a], B = nodes[first.l.b];
        edgeLabel.textContent = first.l.shared.join(" · ").slice(0, 60);
        edgeLabel.setAttribute("x", (A.x + B.x) / 2); edgeLabel.setAttribute("y", (A.y + B.y) / 2 - 6);
      } else edgeLabel.textContent = "";
    };
    nodes.forEach((n) => {
      const g = h("svg:g", { class: `node ${n.decision || "unknown"}`, "data-host": n.host, transform: `translate(${n.x},${n.y})` },
        h("svg:circle", { r: 6 + Math.min(6, (n.risk_score || 0) / 18) }),
        h("svg:text", { y: -12, "text-anchor": n.x < W * 0.25 ? "start" : n.x > W * 0.75 ? "end" : "middle", x: n.x < W * 0.25 ? -8 : n.x > W * 0.75 ? 8 : 0 }, n.host),
        h("svg:title", {}, `${n.host}${n.risk_score != null ? ` · ${Math.round(n.risk_score)}` : ""}`));
      let drag = null;
      g.addEventListener("pointerenter", () => focus(n.host));
      g.addEventListener("pointerleave", () => focus(state.campNode));
      g.addEventListener("pointerdown", (e) => { e.stopPropagation(); drag = { p: toSvg(e), moved: false }; g.setPointerCapture(e.pointerId); });
      g.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const p = toSvg(e);
        n.x += (p[0] - drag.p[0]) / view.s; n.y += (p[1] - drag.p[1]) / view.s; drag.p = p; drag.moved = true;
        g.setAttribute("transform", `translate(${n.x},${n.y})`); place();
      });
      g.addEventListener("pointerup", () => {
        if (drag && !drag.moved) { state.campNode = n.host; focus(n.host); highlightCampRow(n.host); }
        drag = null;
      });
      scene.append(g);
    });
    scene.append(edgeLabel);
    place();
    focus(state.campNode);
    return svg;
  }
  function highlightCampRow(host) {
    document.querySelectorAll("#camp-domains tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.host === host));
  }
  function campaignTable(c) {
    const doms = campDomains(c).sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0));
    return h("table", { class: "hosts camp-table" },
      h("thead", {}, h("tr", {}, h("th", {}, h("button", { type: "button" }, t("h_host"))), h("th", {}, h("button", { type: "button" }, t("h_decision"))))),
      h("tbody", { id: "camp-domains" }, doms.map((d) => h("tr", { "data-host": d.host, class: state.campNode === d.host ? "sel" : "",
        onclick: () => { if (d.verdict_id) openVerdict(d.verdict_id, d.host); } },
        h("td", {}, h("div", { class: "hhost" }, d.host)),
        h("td", { class: "nowrap" }, d.decision ? badge(d.decision) : "–", " ", h("span", { class: "num" }, d.risk_score == null ? "–" : Math.round(d.risk_score)))))));
  }
  function renderCampaigns() {
    const list = $("#camp-list"); const graph = $("#graph");
    const all = [...state.campaigns].sort((a, b) =>
      (campBranded(b) && campBlocked(b) > 0) - (campBranded(a) && campBlocked(a) > 0) || campBlocked(b) - campBlocked(a) || campDomains(b).length - campDomains(a).length);
    const shown = state.campHideClean ? all.filter((c) => campBlocked(c) > 0) : all;
    $("#camp-toggle").replaceChildren(h("label", { class: "toggle" },
      h("input", { type: "checkbox", checked: state.campHideClean || null, onchange: (e) => { state.campHideClean = e.target.checked; renderCampaigns(); } }),
      t("camp_hide_clean", { n: all.length - all.filter((c) => campBlocked(c) > 0).length })));
    if (!shown.length) {
      list.replaceChildren(h("li", { class: "empty", style: { cursor: "default", background: "none", border: 0 } }, t("campaigns_empty")));
      graph.replaceChildren(); $("#camp-side").replaceChildren(); return;
    }
    if (!state.campSelected || !shown.some((c) => c.id === state.campSelected)) state.campSelected = shown[0].id;
    list.replaceChildren(...shown.map((c) => h("li", { class: c.id === state.campSelected ? "sel" : "", onclick: () => { state.campSelected = c.id; state.campNode = null; renderCampaigns(); } },
      h("div", { class: "lbl", dir: "auto" }, campaignTitle(c)),
      h("div", { class: "meta" }, h("span", {}, t("camp_domains", { n: campDomains(c).length })),
        campBlocked(c) ? h("span", { class: "chip", style: { color: "var(--block-ink)" } }, t("camp_blocked", { n: campBlocked(c) })) : null,
        c.last_seen ? h("span", {}, ago(c.last_seen)) : null),
      h("div", { class: "id" }, c.id))));
    const c = shown.find((x) => x.id === state.campSelected);
    $("#graph-title").textContent = campaignTitle(c);
    graph.replaceChildren(campaignGraph(c));
    $("#camp-side").replaceChildren(campaignTable(c));
  }
  async function loadCampaigns() {
    try { state.campaigns = await api.campaigns(); } catch (e) { state.campaigns = []; }
    renderCampaigns();
  }
  function openCampaign(id) { state.campSelected = id; switchTab("campaigns"); }

  /* ---------- benchmarks ---------- */
  function table(columns, rows) {
    return h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, columns.map((c) => h("th", { dir: "auto" }, c)))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", { dir: "auto" }, c)))))));
  }
  function markdown(md) {
    const out = []; const lines = md.split(/\r?\n/); let para = [];
    const flush = () => { if (para.length) { out.push(h("p", {}, para.join(" "))); para = []; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^(#{1,4})\s+(.*)/);
      if (m) { flush(); out.push(h(m[1].length <= 1 ? "h2" : "h3", {}, m[2])); continue; }
      if (/^\s*\|/.test(line) && lines[i + 1] && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/\*\*/g, "").replace(/`/g, ""));
        const head = cells(line); const rows = []; i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        i--; out.push(table(head, rows)); continue;
      }
      if (!line.trim()) { flush(); continue; }
      para.push(line.replace(/\*\*/g, "").replace(/`/g, "").replace(/(^|\s)_([^_]+)_(?=\s|[.,;:]|$)/g, "$1$2").replace(/^[-*]\s+/, "• "));
    }
    flush();
    return out;
  }
  /* ---------- benchmarks ---------- */
  const MODEL_NAMES = {
    url_stack: ["Mirsad URL model", "نموذج الرابط من مرصاد"], url_lgbm_feats: ["URL features + LightGBM (ours)", "خصائص الرابط + LightGBM (نموذجنا)"],
    url_tfidf_lr: ["URL text + logistic regression (ours)", "نص الرابط + انحدار لوجستي (نموذجنا)"], url_mmbert_ft: ["Fine-tuned mmBERT, GPU (ours)", "mmBERT مدرَّب، GPU (نموذجنا)"],
    page_combo: ["Mirsad page model", "نموذج الصفحة من مرصاد"], page_combo_no_abstain: ["Mirsad page model, never abstains", "نموذج الصفحة دون امتناع"],
    page_gte_ft: ["Fine-tuned GTE, GPU (ours)", "GTE مدرَّب، GPU (نموذجنا)"], page_struct_lgbm: ["Page structure + LightGBM (ours)", "بنية الصفحة + LightGBM (نموذجنا)"],
    page_text_lr: ["Page text + logistic regression (ours)", "نص الصفحة + انحدار لوجستي (نموذجنا)"],
    hf_urlbert_tiny_v4: ["URLBERT-tiny (public)", "URLBERT-tiny (عام)"], hf_kmack_distilbert: ["DistilBERT phishing URLs (public)", "DistilBERT للروابط (عام)"],
    hf_ealvaradob_bert_large: ["BERT-large phishing (public)", "BERT-large للتصيّد (عام)"], hf_horizon_scam_text: ["Scam-text classifier (public)", "مصنِّف نصوص الاحتيال (عام)"],
    hf_horizon_mmbert_scam: ["mmBERT scam text (public)", "mmBERT لنصوص الاحتيال (عام)"], hf_huynq3_mbert_webpage: ["mBERT web pages (public)", "mBERT لصفحات الويب (عام)"],
    blocklist_same_day: ["Blocklists, same-day feeds (reference)", "قوائم الحظر، نفس اليوم (مرجع)"], blocklist_cross_feed: ["Blocklists, other feeds (reference)", "قوائم الحظر، مصادر أخرى (مرجع)"],
    majority_class: ["Always \"safe\" (baseline)", "دائماً «آمن» (خط أساس)"], rules_baseline: ["Hand-written rules (baseline)", "قواعد يدوية (خط أساس)"],
    keyword_baseline: ["Keyword list (baseline)", "قائمة كلمات (خط أساس)"], "llm_judge_qwen3.5-9b": ["AI judge, Qwen 3.5 9B (ours)", "المقيّم الذكي Qwen 3.5 9B (نموذجنا)"],
  };
  const DATASET_NAMES = {
    urls_fresh_test: ["Fresh URLs (held out)", "روابط حديثة (خارج التدريب)"], uae_legit: ["Real UAE sites (all legitimate)", "مواقع إماراتية حقيقية (كلها سليمة)"],
    pages_test: ["Web pages (held out)", "صفحات ويب (خارج التدريب)"], synthetic_uae: ["UAE-style scam pages", "صفحات احتيال بطابع إماراتي"],
  };
  const modelKind = (m) => (/^hf_/.test(m) ? "public" : /^blocklist/.test(m) ? "reference" : /baseline|majority/.test(m) ? "baseline" : "ours");
  function modelName(m) {
    const [base, variant] = String(m).split("@");
    const names = MODEL_NAMES[base];
    const name = names ? names[state.lang === "ar" ? 1 : 0] : base.replace(/^hf_/, "").replace(/[_-]+/g, " ");
    return variant ? `${name} · ${variant}` : name;
  }
  const datasetName = (d) => (DATASET_NAMES[d] ? DATASET_NAMES[d][state.lang === "ar" ? 1 : 0] : String(d).replace(/[_-]+/g, " "));
  const pctTxt = (x, digits = 0) => (x == null ? "–" : `${(x * 100).toFixed(digits)}%`);

  function benchBars(rows, { max, fmt, log = false }) {
    const scale = (v) => (log ? Math.log10(Math.max(v, 0.1) / 0.1) / Math.log10(max / 0.1) : v / max);
    return h("div", { class: "bchart" }, rows.map((r) => h("div", { class: `brow k-${r.kind}`, title: `${r.label}: ${fmt(r.value)}${r.note ? ` · ${r.note}` : ""}` },
      h("span", { class: "blabel", dir: "auto" }, r.label),
      h("span", { class: "btrack" }, h("svg:svg", { viewBox: "0 0 100 10", preserveAspectRatio: "none" },
        h("svg:rect", { x: 0, y: 1, height: 8, rx: 2, width: Math.max(0.6, Math.min(100, scale(r.value) * 100)), class: "bbar" }))),
      h("span", { class: "bval" }, fmt(r.value)))));
  }
  const legend = () => h("div", { class: "blegend" }, ["ours", "public", "reference", "baseline"].map((k) => h("span", {}, h("i", { class: `sw k-${k}` }), t(`bk_${k}`))));

  function renderBench() {
    const b = state.benchmarks; const box = $("#bench");
    if (!b) return;
    const results = (Array.isArray(b.results) ? b.results : []).filter((x) => x && typeof x === "object" && x.model);
    const by = (ds) => results.filter((r) => r.dataset === ds);
    const pick = (ds, model) => by(ds).find((r) => r.model === model);
    const bestPublic = (ds) => by(ds).filter((r) => modelKind(r.model) === "public").sort((a, c) => (c.recall_at_fpr_1pct || 0) - (a.recall_at_fpr_1pct || 0))[0];
    const kids = [h("h2", {}, t("bench_title")), h("p", { class: "muted" }, t("bench_intro"))];

    const ours = pick("urls_fresh_test", "url_stack"); const pub = bestPublic("urls_fresh_test");
    const oursUae = pick("uae_legit", "url_stack"); const pubUae = pub && pick("uae_legit", pub.model);
    const oursPage = pick("pages_test", "page_combo"); const pubPage = bestPublic("pages_test");
    const tile = (label, a, bText, note) => h("div", { class: "btile" }, h("div", { class: "k" }, label),
      h("div", { class: "v" }, h("bdi", {}, a)), h("div", { class: "vs" }, t("bench_vs"), " ", h("bdi", {}, bText)), note ? h("div", { class: "muted n" }, note) : null);
    if (ours && pub) {
      kids.push(h("div", { class: "btiles" },
        tile(t("bh_recall"), pctTxt(ours.recall_at_fpr_1pct), pctTxt(pub.recall_at_fpr_1pct), modelName(pub.model)),
        tile(t("bh_fpr"), pctTxt(ours.fpr, 2), pctTxt(pub.fpr, 1), t("bh_fpr_note")),
        oursUae && pubUae ? tile(t("bh_uae"), t("bh_uae_of", { n: num(oursUae.fp), total: num(oursUae.n) }), t("bh_uae_of", { n: num(pubUae.fp), total: num(pubUae.n) }), datasetName("uae_legit")) : null,
        tile(t("bh_url_time"), fmtMs(ours.latency_ms_p50), fmtMs(pub.latency_ms_p50), t("bh_per_url")),
        oursPage && pubPage ? tile(t("bh_page_time"), fmtMs(oursPage.latency_ms_p50), fmtMs(pubPage.latency_ms_p50), modelName(pubPage.model)) : null));
    }

    const accuracy = (ds) => by(ds).filter((r) => r.recall_at_fpr_1pct != null && !String(r.model).includes("@") && !/no_abstain|majority/.test(r.model))
      .sort((a, c) => c.recall_at_fpr_1pct - a.recall_at_fpr_1pct).map((r) => ({ label: modelName(r.model), value: r.recall_at_fpr_1pct, kind: modelKind(r.model) }));
    const accSets = ["urls_fresh_test", "pages_test"].filter((ds) => accuracy(ds).length);
    if (accSets.length) {
      kids.push(h("section", { class: "bsec" }, h("h3", {}, t("bc_accuracy")), h("p", { class: "muted" }, t("bc_accuracy_sub")), legend(),
        h("div", { class: "bgrid" }, accSets.map((ds) => h("div", {}, h("h4", {}, datasetName(ds)), benchBars(accuracy(ds), { max: 1, fmt: (v) => pctTxt(v) })))),
        h("p", { class: "muted bnote" }, t("bc_reference_note"))));
    }

    const speed = state.benchExtra && state.benchExtra.page_speed;
    const timeRows = [];
    if (speed) {
      const ph = speed.phases || {};
      const phase = (re) => Object.entries(ph).find(([k]) => re.test(k));
      [[/^layer 0/i, "tg_reputation"], [/^layer 1/i, "tg_url"], [/^fetch page/i, "tg_fetch"], [/^first verdict/i, "bt_first"]].forEach(([re, key]) => {
        const hit = phase(re); if (hit && hit[1] != null) timeRows.push({ label: `${t("bk_ours")}: ${t(key)}`, value: hit[1], kind: "ours" });
      });
      if (speed.llm_p50) timeRows.push({ label: `${t("bk_ours")}: ${t("tg_llm")}`, value: speed.llm_p50, kind: "ours" });
      (speed.models || []).filter((m) => m.p50_ms && modelKind(m.model) === "public").forEach((m) => timeRows.push({ label: modelName(m.model), value: m.p50_ms, kind: "public" }));
      if (speed.browser_load_p50) timeRows.push({ label: t("bt_browser"), value: speed.browser_load_p50, kind: "reference" });
      if (speed.browser_networkidle_p50) timeRows.push({ label: t("bt_browser_idle"), value: speed.browser_networkidle_p50, kind: "reference" });
    }
    if (timeRows.length) {
      timeRows.sort((a, c) => a.value - c.value);
      kids.push(h("section", { class: "bsec" }, h("h3", {}, t("bc_time")), h("p", { class: "muted" }, t("bc_time_sub", { pages: speed.pages || "–", cpu: speed.hardware || "" })), legend(),
        benchBars(timeRows, { max: Math.max(...timeRows.map((r) => r.value)), fmt: fmtMs, log: true })));
    }

    const images = (state.benchExtra && state.benchExtra.images) || [];
    if (images.length) {
      kids.push(h("section", { class: "bsec" }, h("h3", {}, t("bc_confusion")),
        h("div", { class: "bimages" }, images.map((name) => h("figure", {},
          h("button", { type: "button", class: "shot-btn", onclick: () => lightbox(api.benchImageUrl(name), name) }, h("img", { src: api.benchImageUrl(name), alt: name, loading: "lazy" })),
          h("figcaption", { class: "muted" }, name.replace(/^cm__|\.png$/g, "").split("__").map((p, i) => (i === 0 ? modelName(p) : datasetName(p))).join(" · ")))))));
    }

    const datasets = [...new Set(results.map((r) => r.dataset))];
    if (datasets.length) {
      const f = (v, d = 3) => (v == null ? "–" : Number(v).toFixed(d));
      kids.push(h("details", { class: "bsec ball" }, h("summary", {}, t("bench_all", { n: results.length })),
        datasets.map((ds) => h("div", {}, h("h4", {}, datasetName(ds), h("span", { class: "muted mono" }, ` ${ds}`)),
          table([t("bt_model"), "n", t("bt_precision"), t("bt_recall"), "F1", t("bt_fpr"), t("bt_r01"), t("bt_r1"), t("bt_p50")],
            by(ds).sort((a, c) => (c.recall_at_fpr_1pct || 0) - (a.recall_at_fpr_1pct || 0)).map((r) => [modelName(r.model), r.n ?? "–", f(r.precision), f(r.recall), f(r.f1),
              r.fpr == null ? "–" : pctTxt(r.fpr, 2), f(r["recall_at_fpr_0.1pct"], 2), f(r.recall_at_fpr_1pct, 2), r.latency_ms_p50 == null ? "–" : fmtMs(r.latency_ms_p50)]))))));
    }
    if (b.markdown) kids.push(h("details", { class: "bsec" }, h("summary", {}, t("bench_writeup")), h("div", { class: "bmd" }, markdown(b.markdown))));
    box.replaceChildren(...kids);
  }
  async function loadBench() {
    try {
      const b = await api.benchmarks();
      state.benchmarks = b && (b.markdown || (b.results || []).length || (b.tables || []).length) ? b : null;
    } catch (e) { state.benchmarks = null; }
    try { state.benchExtra = await api.benchExtra(); } catch (e) { state.benchExtra = null; }
    document.querySelector('[data-tab="bench"]').hidden = !state.benchmarks;
    renderBench();
  }

  /* ---------- chrome: tabs, language, theme, connection ---------- */
  function switchTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    if (name === "campaigns") loadCampaigns();
    if (name === "hosts") loadHosts();
    if (name === "evidence") loadEvidence();
    try { history.replaceState(null, "", `${location.search}#${name}`); } catch (e) { /* sandboxed */ }
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  function setConn(s) {
    state.conn = s;
    const el = $("#conn"); el.dataset.state = s;
    el.querySelector(".label").textContent = t(`conn_${s}`);
  }
  function applyLang() {
    const root = document.documentElement;
    root.lang = state.lang; root.dir = state.lang === "ar" ? "rtl" : "ltr";
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    $("#lang").textContent = t("lang_button");
    $("#lang").setAttribute("lang", state.lang === "ar" ? "en" : "ar");
    setConn(state.conn);
    applyTheme();
    renderAll();
  }
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const shownTheme = () => state.theme || (systemDark.matches ? "dark" : "light");
  function applyTheme() {
    if (state.theme) document.documentElement.dataset.theme = state.theme;
    else delete document.documentElement.dataset.theme;
    $("#theme").title = shownTheme() === "dark" ? t("theme_light") : t("theme_dark");
  }
  systemDark.addEventListener("change", applyTheme);
  $("#lang").addEventListener("click", () => { state.lang = state.lang === "ar" ? "en" : "ar"; store("ss.lang", state.lang); applyLang(); });
  $("#theme").addEventListener("click", () => { state.theme = shownTheme() === "dark" ? "light" : "dark"; store("ss.theme", state.theme); applyTheme(); });

  function renderAll() {
    renderStats(); renderEarly(); renderRecentChecks(); renderFeed(); renderDetail();
    if (!$("#view-campaigns").hidden) renderCampaigns();
    if (!$("#view-hosts").hidden) { renderHosts(); renderHostPanel(); }
    renderEvidenceTab();
    renderBench();
  }

  /* ---------- boot ---------- */
  async function refreshList() {
    try {
      const list = await api.list();
      list.slice().reverse().forEach((v) => upsertVerdict(v));
      state.order.sort((a, b) => toDate(state.verdicts.get(b).created_at) - toDate(state.verdicts.get(a).created_at));
      if (state.conn === "offline") setConn("connecting");
      return true;
    } catch (e) {
      if (!MOCK) setConn("offline");
      return false;
    }
  }
  async function boot() {
    const qLang = params.get("lang"); if (qLang === "ar" || qLang === "en") state.lang = qLang;
    const qTheme = params.get("theme"); if (qTheme === "dark" || qTheme === "light") state.theme = qTheme;
    applyLang();
    await refreshList();
    const first = state.order[0];
    if (first && matchMedia("(min-width: 861px)").matches) select(params.get("v") || first);
    renderAll();
    api.events(onEvent, (s) => { setConn(s); if (s === "live") refreshList().then(renderAll); });
    loadBench();
    loadCampaigns();
    loadEvidence().then(renderFeed);
    const tab = location.hash.replace("#", "");
    if (["live", "hosts", "evidence", "campaigns", "bench"].includes(tab)) switchTab(tab);
    setInterval(() => { document.querySelectorAll("#feed .meta > span:first-child").forEach((el) => { const id = el.closest(".card").dataset.id; const v = state.verdicts.get(id); if (v) el.textContent = ago(v.created_at); }); }, 10000);
    if (!MOCK) setInterval(() => refreshList().then(renderSide), 15000);
  }
  boot();
})();
