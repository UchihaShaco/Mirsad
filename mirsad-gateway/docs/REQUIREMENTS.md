# Mirsad's website shield (مرصاد) — design brief and requirements

The design brief from the team lead, and the hackathon rules it has to satisfy. Every component is
checked against this file.

## 1. The idea

We pretend to be an Internet Service Provider. A Docker container is the ISP; a phone sends its
traffic through it. When the user opens a website, the ISP **holds the user**, investigates the
site, and then either lets the user continue or blocks the site. Early detection comes from this
hold-and-investigate step itself: a scam is stopped at the first visit, before any victim has
reported it.

External feeds and APIs are **not** the detection method. They only pre-fill the reputation table
and help decide when a crawl is needed and when it is not.

## 2. What the system must do

### Gateway (the pretend ISP)
- R1. A Docker container acts as the ISP. The phone connects over a WireGuard-style tunnel.
- R2. The phone may not be on the same Wi-Fi as the server, so the tunnel must work across networks
  (Tailscale exit node).
- R3. Seeing the hostname (domain and every subdomain level) is enough; the path after `/` is not required.
- R4. The user is held until the investigation of the first page and its immediate redirects is done.

### Reputation and when to investigate
- R5. Keep our own reputation table per website.
- R6. On a visit, look up DNS and compare with what we stored: has the destination IP changed?
- R7. Hash each page efficiently and re-investigate only when the page has changed. The hash must
  ignore minor, irrelevant differences (timestamps, tokens) — or compare by percentage similarity.
- R8. Investigate when the site is new, its reputation is low, or something has changed. Do not
  slow down sites that are known and unchanged.
- R9. A dashboard shows, per website: reputation, traffic volume, the last-changed record and
  similar facts. As close as practical; not every record is needed.

### Investigation engine (the crawler)
- R10. No Playwright, Selenium or automated Chrome. Nothing that triggers automation, bot or agent
  flags — a site must not be able to hide because it knows a crawler is visiting.
- R11. Our own engine fetches the site as a person's browser would, and it must be fast; a full
  browser is too slow.
- R12. It must see the site as it truly is, including content that only loads later.
- R13. JavaScript is read, not run: crawl the scripts and iterate through them. Run code only if
  there is a real need.
- R14. If deliberate scrambling is detected on a site that already looks risky, block without running it.
- R15. Redirects are followed and every destination is explored.

### Order of checks
- R16. Layer 1: the first page, as fast as possible, including what it would execute.
- R17. Layer 2: any immediate redirects from it.
- R18. When layers 1 and 2 are clean the user is let through.
- R19. The crawl then continues in the background across further redirects and as much of the site
  as it can reach. A finding at any point blocks the site from then on.
- R20. After a block (risk 70 or more), a heavier agent re-validates it: it starts from the flags
  and evidence that caused the block, re-checks them, looks at other elements of the site and runs
  searches, without re-crawling everything. If the block was a false positive it unblocks the site.

### The AI
- R21. A mix of rule-based algorithms and AI models. Speed matters most on the held path.
- R22. Try several models and approaches, learn from papers and from how existing companies do it,
  and keep the best. Training, fine-tuning and local inference on the team's GPU are all allowed.
- R23. Language-model parts run on a small local model on the GPU rather than on paid API keys.
- R24. The verdict is a clear answer with a rating: allow, warn or block.

### Benchmarks
- R25. Collect every dataset we can get.
- R26. Compare our solution with existing state-of-the-art solutions on the same data, with a
  confusion matrix for each.
- R27. Compare speed **per page** (not per website) for ours and for the state of the art.
- R28. The best model found goes into the live crawler.
- R30. The comparison must be as legitimate as possible: every system is scored on the same rows,
  each given the inputs it was designed for (URL, HTML, screenshot), and differences in pipeline are
  stated. Different benchmarks that give different insights are welcome.
- R31. No relevant state-of-the-art method is left out because its model is not public. If it can be
  recreated from the paper or code, recreate it and say that it is a recreation.

### No hardcoding
- R32. Nothing is hardcoded to make a result come out right. The engine has no special cases for
  demo sites, test sites or particular hostnames; verdicts come from the same general logic
  everywhere. Lists (brands, official domains, hosting platforms, lure words), thresholds and weights
  live in data and configuration files, not inside the logic, and nothing depends on one machine's paths.

### Scope
- R29. This is a competition demo, not a production product. Concerns that only matter in
  production (bypass routes, hardening, scale) are out of scope unless they break the demo.

## 3. Hackathon rules (ScamShield AI Hackathon, 42 Abu Dhabi × Abu Dhabi Police)

### Dates
- **Submission deadline: 08:00, 25 November 2026**, through Podium+. Late submissions are not considered.
- 26 November 2026: presentations, 10:00–15:00. Tell the organisers by 08:00 that day if not presenting.
- 30 November 2026: awarding ceremony.

### What to submit
- A GitHub repository on `master` containing the MVP / prototype and `README.md`.
- `README.md` must cover: the problem and the solution; technical choices, tools, APIs and data;
  how to build and run the project.
- On Podium+: the repository link, a PPT presentation, and a one-minute demo video.
- Clean up anything that adds no value: useless files, empty tests, commented-out code.
- Double-check the group name, member names and the link.

### Presentation
- A 10-minute slot: 5 minutes of demo and 5 minutes of questions, timed strictly. (Another slide in
  the guidelines says 3 minutes of demo and 2 of questions — plan the demo to fit 3 minutes.)
- Open with the problem and the solution in at most one minute, then demo the prototype's core features.

### Judging criteria

| # | Criterion | Weight | What the judges look for | How we answer it |
|---|---|---|---|---|
| 1 | Detection accuracy | 30% | Precision and recall on a hidden test set of fraud and legitimate URLs. Low false positives, so real banks and government sites are not flagged. Resists redirects, URL shorteners and cloaking. | Layered verdict (R16–R19); official-domain list in front of every model; the review agent clears false positives (R20); redirects and shorteners expanded (R15); person-like fetching and cloaking comparison (R10–R12); batch scoring of a URL list. |
| 2 | Early detection and coverage | 25% | Catches threats before victims report them, e.g. newly registered domains, look-alike domains, fresh ads. Covers search results and Maps listings (fake business pages, fake helpline numbers). | Blocking at the first visit needs no prior report (R4). Domain age, look-alike and brand checks. Feeds of new domains and certificates pre-fill the reputation table. Helpline-number mismatch check. |
| 3 | Explainability and actionability | 20% | Each flag has a risk score with clear reasons. Output is usable as police evidence (screenshots, WHOIS and hosting data, timestamps) and exportable for takedown. | Risk score 0–100 with per-reason contributions; evidence pack with report, screenshot, registration and hosting data, hashes and a takedown request. |
| 4 | UAE relevance and innovation | 15% | Arabic and bilingual content. Impersonation of local brands (UAE banks, TAMM, UAE PASS, traffic fine payments). A novel technique, e.g. visual page similarity, LLM analysis, linking scam domains as a network. | Arabic and English reasons, pages and reports; UAE brand registry; ISP-level hold-and-investigate; no-browser engine; review agent; campaign linking. |
| 5 | Feasibility and presentation | 10% | A working live demo, a scalable design and a realistic route to a police pilot. Clear pitch, honest about limitations. | Live phone demo through the gateway; one-command Docker start; regulator-to-ISP blocking as the pilot route; limitations stated in the README and benchmarks. |
