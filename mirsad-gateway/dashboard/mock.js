"use strict";
/* Offline demo backend for ?mock=1: serves dashboard/mock/*.json and replays a scripted live feed
   (including a revocation by the deep crawl and a review that overturns a block). Fictional data only. */
window.Mock = (() => {
  let data = null;
  const listeners = [];
  const STAGES = ["reputation", "url", "page", "deep"];
  const TIMING_KEY = { reputation: "layer0_reputation", url: "layer1_url", page: "layer2_page", deep: "layer3_deep", review: "layer4_review" };

  async function load() {
    if (data) return data;
    const get = (name) => fetch(`mock/${name}.json`).then((r) => r.json());
    const [verdicts, campaigns, benchmarks, hosts, history, evidence] = await Promise.all(
      [get("verdicts"), get("campaigns"), get("benchmarks"), get("hosts"), get("hosts_history"), get("evidence")]);
    data = { verdicts, campaigns, benchmarks, hosts, history, evidence, byId: new Map(verdicts.map((v) => [v.id, v])) };
    return data;
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const emit = (type, payload) => listeners.forEach((fn) => fn({ type, ts: Date.now() / 1000, ...payload }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const summary = (v) => ({ verdict_id: v.id, url: v.url, host: v.host, decision: v.decision, risk_score: v.risk_score, stage: v.stage, final: v.final, summary_en: v.summary_en, summary_ar: v.summary_ar });

  /* Replays one stored verdict as a fresh investigation, stage by stage. */
  async function replay(template, overrides = {}) {
    const final = Object.assign(clone(template), overrides, { id: newId() });
    const now = new Date();
    final.created_at = now.toISOString();
    const partial = clone(final);
    partial.final = false;
    partial.review = null;
    partial.stage = "reputation";
    partial.decision = "warn";
    partial.risk_score = 50;
    partial.timings_ms = {};
    data.byId.set(final.id, partial);
    data.verdicts.unshift(partial);
    emit("investigation.started", { verdict_id: final.id, url: final.url, host: final.host });

    const cached = "layer0_cache_hit" in (template.timings_ms || {});
    const reached = STAGES.indexOf(template.stage);
    const revoked = Boolean(template.revoked);
    const overturned = template.review && template.previous_decision === "block";
    for (let i = 0; i <= (cached ? 0 : reached); i++) {
      const stage = STAGES[i];
      const ms = cached ? template.timings_ms.layer0_cache_hit : template.timings_ms[TIMING_KEY[stage]] || 50;
      await sleep(Math.min(Math.max(ms, 350), 3200));
      partial.stage = stage;
      partial.timings_ms[cached ? "layer0_cache_hit" : TIMING_KEY[stage]] = ms;
      if (cached || i === reached || (i >= 1 && !revoked)) {
        partial.decision = template.decision;
        partial.risk_score = template.risk_score;
      }
      if (revoked && i < reached) { partial.decision = "allow"; partial.risk_score = 22; }
      if (overturned && i >= 1) { partial.decision = "block"; partial.risk_score = 78; }
      Object.assign(partial, { reasons: final.reasons.filter((r) => !r.code.startsWith("review.")), brand: final.brand, domain: final.domain, page: final.page, redirect_chain: final.redirect_chain,
        url_model_score: final.url_model_score, page_model_score: i >= 2 ? final.page_model_score : null, summary_en: final.summary_en, summary_ar: final.summary_ar,
        campaign_id: final.campaign_id, pages_crawled: i >= 3 ? final.pages_crawled : 0, source: final.source });
      const last = cached || i === reached;
      if (last && revoked) {
        partial.final = true;
        emit("verdict.revoked", summary(partial));
      } else if (last) {
        partial.final = !overturned && !(template.review && template.decision === "block");
        emit(partial.final ? "verdict.updated" : "layer.done", summary(partial));
      } else {
        emit("layer.done", summary(partial));
      }
    }
    if (template.review && !cached) {
      await sleep(2600);
      partial.review = clone(template.review);
      partial.reasons = final.reasons;
      partial.decision = template.decision;
      partial.risk_score = template.risk_score;
      partial.timings_ms.layer4_review = template.timings_ms.layer4_review;
      partial.final = true;
      emit("verdict.reviewed", { verdict_id: partial.id, host: partial.host, outcome: partial.review.outcome, decision: partial.decision });
    }
    Object.assign(partial, { timings_ms: { ...template.timings_ms }, updated_at: new Date().toISOString() });
    touchHost(partial);
    const evidence = data.evidence.find((c) => c.verdict_ids.includes(template.id));
    if (evidence) {
      await sleep(1500);
      evidence.verdict_ids.push(partial.id);
      emit("evidence.ready", { verdict_id: partial.id, host: partial.host, case_ref: evidence.case_ref, decision: evidence.decision });
    }
    return partial;
  }

  /* Keeps the reputation table in step with replayed investigations, as the engine's host.updated does. */
  function touchHost(v) {
    const now = new Date().toISOString();
    let row = data.hosts.find((r) => r.host === v.host);
    if (!row) {
      row = { host: v.host, registered_domain: v.registered_domain, visits: 0, visits_24h: 0, first_seen: now, changes: 0, last_changed: null, last_change_kind: null,
        popularity_rank: (v.domain || {}).popularity_rank ?? null, domain_age_days: (v.domain || {}).age_days ?? null, allowlisted: false, owner: null, blocklisted: false };
      data.hosts.push(row);
      data.history[v.host] = { changes: [], verdicts: [], visits_hourly: new Array(24).fill(0) };
    }
    const hist = data.history[v.host];
    hist.visits_hourly[23] += 1;
    hist.verdicts.unshift({ id: v.id, decision: v.decision, risk_score: v.risk_score, stage: v.stage, created_at: v.created_at, source: v.source });
    const reputation = v.decision === "block" ? "blocked" : v.decision === "warn" ? "suspicious" : row.reputation || "unknown";
    Object.assign(row, { decision: v.decision, risk_score: v.risk_score, stage: v.stage, reputation, verdict_id: v.id, source: v.source || "user",
      campaign_id: v.campaign_id || null, visits: row.visits + 1, visits_24h: row.visits_24h + 1, last_seen: now, last_checked: now });
    emit("host.updated", { ...row });
  }

  async function loop() {
    const script = ["e5f6a7b8c9d04e1f2a3b4c5d6e7f8a94", "a1f04c2e9b7d4e1f8a6b3c5d7e9f0a12", "1b2c3d4e5f6a41728394a5b6c7d8e927",
      "f6a7b8c9d0e14f2a3b4c5d6e7f8a9b05", "2c3d4e5f6a7b42839405b6c7d8e9fa38", "b2c3d4e5f6a74b8c9d0e1f2a3b4c5d61", "0a1b2c3d4e5f40617283940a1b2c3d16"];
    const templates = script.map((id) => data.byId.get(id)).filter(Boolean);
    for (let i = 0; ; i++) {
      replay(templates[i % templates.length]);
      await sleep(7000);
    }
  }

  return {
    async start(onEvent) {
      await load();
      listeners.push(onEvent);
      setTimeout(loop, 1500);
    },
    async verdicts() { await load(); return data.verdicts.map(clone); },
    async verdict(id) { await load(); const v = data.byId.get(id); if (!v) throw new Error("404"); return clone(v); },
    async campaigns() { await load(); return clone(data.campaigns); },
    async benchmarks() { await load(); return clone(data.benchmarks); },
    async benchExtra() { return fetch("mock/benchmarks_extra.json").then((r) => r.json()); },
    async evidenceList() { await load(); return clone(data.evidence); },
    async evidenceSummary(id) {
      await load();
      const c = data.evidence.find((x) => x.verdict_ids.includes(id));
      if (!c) throw Object.assign(new Error("no evidence captured for this verdict"), { state: "none" });
      return { ...(await fetch(`mock/evidence/${c.case_ref}/summary.json`).then((r) => r.json())), state: "ready", verdict_ids: c.verdict_ids };
    },
    screenshotUrl(id, view) {
      const c = (data ? data.evidence : []).find((x) => x.verdict_ids.includes(id));
      return c ? `mock/evidence/${c.case_ref}/${view === "live" ? "screenshot.png" : "screenshot_engine.png"}` : "";
    },
    async hosts(q) {
      await load();
      const needle = (q || "").toLowerCase();
      return data.hosts.filter((r) => !needle || r.host.includes(needle)).map(clone);
    },
    async history(host) {
      await load();
      const row = data.hosts.find((r) => r.host === host);
      if (!row) throw new Error("404");
      return { ...clone(row), ...clone(data.history[host] || { changes: [], verdicts: [], visits_hourly: [] }) };
    },
    async check(url) {
      await load();
      const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
      let host = target;
      try { host = new URL(target).hostname; } catch (e) { /* keep the raw text as the host */ }
      const scam = /(verify|secure|login|pay|fine|parcel|fee|bonus|reward|gift|kyc|update|wallet)/i.test(target);
      const template = data.byId.get(scam ? "a1f04c2e9b7d4e1f8a6b3c5d7e9f0a12" : "f6a7b8c9d0e14f2a3b4c5d6e7f8a9b05");
      const t = clone(template);
      t.url = target; t.final_url = target; t.host = host; t.registered_domain = host; t.redirect_chain = []; t.source = "user";
      if (t.page) { t.page.url = target; t.page.final_url = target; t.page.redirect_chain = []; }
      if (t.domain) { t.domain.host = host; t.domain.registered_domain = host; }
      const run = replay(t);
      await sleep(900);
      const first = data.verdicts[0];
      return { verdict: clone(first), done: run };
    },
    async review(id) {
      await load();
      const v = data.byId.get(id);
      if (!v) throw new Error("404");
      const steps = [
        { tool: "rdap_lookup", input: { domain: v.registered_domain || v.host }, finding: "Registration data unchanged since the first check.", supports_block: v.decision === "block", elapsed_ms: 520 },
        { tool: "fetch_page", input: { url: v.final_url || v.url }, finding: "Page content matches the analysed snapshot.", supports_block: null, elapsed_ms: 1400 },
      ];
      steps.forEach((step, i) => setTimeout(() => emit("review.step", { verdict_id: v.id, host: v.host, ...step }), 900 * (i + 1)));
      setTimeout(() => {
        v.review = {
          outcome: v.decision === "block" ? "confirmed" : "inconclusive", decision: v.decision, confidence: 0.81, model: "reviewer-agent (demo)",
          summary_en: "Manual re-check: the original findings still hold.", summary_ar: "إعادة تحقق يدوية: ما زالت المؤشرات الأصلية قائمة.",
          steps,
          started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
        };
        emit("verdict.reviewed", { verdict_id: v.id, host: v.host, outcome: v.review.outcome, decision: v.decision });
      }, 2500);
      return { status: "accepted", verdict_id: v.id };
    },
  };
})();
