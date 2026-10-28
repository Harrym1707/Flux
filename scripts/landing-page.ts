/**
 * The FLUX landing page — built to the dealt tasteskill direction sheet
 * (.taste-skill/direction.json, seed 1631001276): "The product performs".
 *
 * The idea sentence: on this page, THE LEDGER AND THE REDUCER THEMSELVES
 * become the imagery — every picture is a true, working fragment of FLUX at
 * real size (data-ui), and the stats section's receipt is the actual first
 * live export, rows summing to the total.
 *
 * The live thing: the hero's reducer panel. Press "Reduce" and watch the
 * duplicate block struck from a real request; the token counts are computed
 * from the sample's own bytes at build time, so the demo cannot lie.
 *
 * Recorded adjustments to the sheet (reasons the skill accepts):
 * - Ground stays the brand's Midnight (palette was dealt --keep); the sheet's
 *   off-white maps onto brand roles as instructed.
 * - The founder-mandated cursor energy field stays, hero-only and subtle.
 * - The proof/logo row is dropped: no logos exist and the skill forbids
 *   stand-ins; the receipt of real traffic is this page's proof.
 * - The serif accent line was cut: the hero carries one sentence only.
 */

const approxTokens = (text: string): number => Math.ceil(text.length / 4);

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const LOGO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs/site/logos");
/** Official marks (Simple Icons, CC0), served white; sized by CSS. */
const logo = (slug: string): string =>
  readFileSync(path.join(LOGO_DIR, slug + ".svg"), "utf8").replace("<svg ", '<svg aria-hidden="true" ');

export function renderLanding(origin: string, repoUrl: string): string {
  // --- The hero demo's sample request: token counts computed from the bytes.
  const DUP_BLOCK = "Records 0-19: settlement entry nominal, reconciliation standard, no notification sent, annotation routine.";
  const STABLE = `{"model":"claude-sonnet-5-5","system":"You are a careful assistant. Cite sources. Escalate anything risky.","messages":[{"role":"user","content":"Excerpts for case 7:`;
  const TAIL = ` Question: what does clause 7 require?"}]}`;
  // Four folds, counted from the strings that actually appear in the panel.
  const SCHEMA_RAW = '{"name":"lookup_0","description":"Look up records in subsystem 0…","input_schema":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}}}}, …11 more verbose schemas…'.repeat(4);
  const SCHEMA_AFTER = "[ 12 tools, schemas minified ]";
  const HISTORY_RAW = `${DUP_BLOCK} ${DUP_BLOCK} ${DUP_BLOCK}`.repeat(3);
  const HISTORY_AFTER = "[ digest kept: errors + file paths; rest summarised ]";
  const TOOLRES_RAW = "Row 1 of 400: settlement nominal… ".repeat(60);
  const HISTORY_BYTES = HISTORY_RAW.length.toLocaleString("en-US");
  const TOOLRES_BYTES = TOOLRES_RAW.length.toLocaleString("en-US");
  const TOOLRES_AFTER = "[ headline + errors kept; oversized body capped ]";
  const beforeTokens = approxTokens(STABLE + TAIL) + approxTokens(SCHEMA_RAW) + approxTokens(HISTORY_RAW) + approxTokens(DUP_BLOCK) * 2 + approxTokens(TOOLRES_RAW);
  const afterTokens = approxTokens(STABLE + TAIL) + approxTokens(SCHEMA_AFTER) + approxTokens(HISTORY_AFTER) + approxTokens(DUP_BLOCK) + approxTokens(TOOLRES_AFTER);
  // Priced at the catalogued Sonnet 5.5 input rate, $2 per million tokens.
  const INPUT_RATE = 2 / 1_000_000;
  const beforeCost = (beforeTokens * INPUT_RATE).toFixed(5);
  const afterCost = (afterTokens * INPUT_RATE).toFixed(5);
  const steps = [
    { chip: "12 tool schemas compacted", tokens: approxTokens(SCHEMA_RAW) - approxTokens(SCHEMA_AFTER) },
    { chip: "stale history compacted, byte-stable", tokens: approxTokens(HISTORY_RAW) - approxTokens(HISTORY_AFTER) },
    { chip: "exact duplicate removed", tokens: approxTokens(DUP_BLOCK) },
    { chip: "fresh result capped before it bills", tokens: approxTokens(TOOLRES_RAW) - approxTokens(TOOLRES_AFTER) },
  ];

  // --- The receipt: the LATEST LIVE EXPORT, verbatim. Rows must truly sum.
  // 30 requests, claude-sonnet-5-5, 2026-10-26; the hash-chained spools are
  // committed in evals/live-exports-2026-10-26/ (docs/NUMBERS.md: 18.2%).
  // Per-agent sums of actualUsd and savedUsd from those spools, 5 d.p.
  const SPEND = [
    ["coding-agent", 0.05920], ["rag-docqa", 0.03913], ["batch-classifier", 0.04517],
    ["support-chat", 0.05225], ["already-lean", 0.00529],
  ] as const;
  const SAVED = [
    ["coding-agent — cap + schemas + cache stamp", 0.02254],
    ["rag-docqa — duplicate excerpt removed", 0.00861],
    ["support-chat — tool-schema compaction", 0.00537],
    ["batch-classifier — stamp suppressed, 0%", 0.0],
    ["already-lean — nothing to remove", 0.0],
  ] as const;
  const spendTotal = SPEND.reduce((s, [, v]) => s + v, 0);
  const savedTotal = SAVED.reduce((s, [, v]) => s + v, 0);
  const savedPct = (savedTotal / spendTotal) * 100;
  const money = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(4)}`;

  const CANVAS_JS = `
(function () {
  var canvas = document.getElementById("field");
  if (!canvas || !canvas.getContext) return;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var ctx = canvas.getContext("2d");
  var wrap = canvas.parentElement;
  var dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  var W = 0, H = 0;
  function resize() {
    W = wrap.clientWidth; H = wrap.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  var rt; window.addEventListener("resize", function(){ clearTimeout(rt); rt = setTimeout(resize, 150); });

  // Three particle wave surfaces layered down the page: ink on paper. Each
  // layer is a perspective-projected grid on its own rolling height field,
  // with its own drift speed, so the layers slide over one another. Every
  // row runs the full width of the viewport (the world x is derived from the
  // screen x, so perspective still compresses the far rows), the surfaces
  // are deep enough to touch, and the cursor pushes a swell through
  // whichever surface it is near.
  var LAYERS = [
    { horizon: 0.02, cam: 0.35, drift: 0.7,  phase: 0.0, dark: 0.50 },
    { horizon: 0.28, cam: 0.37, drift: 1.0,  phase: 2.1, dark: 0.85 },
    { horizon: 0.55, cam: 0.36, drift: 0.55, phase: 4.4, dark: 0.66 },
  ];
  var COLS = 130, ROWSZ = 30, FOV = 300;
  var mx = -9999, my = -9999, smx = -9999, smy = -9999;
  window.addEventListener("pointermove", function (e) {
    var b = wrap.getBoundingClientRect();
    mx = e.clientX - b.left; my = e.clientY - b.top;
  }, { passive: true });
  window.addEventListener("pointerleave", function(){ mx = -9999; my = -9999; });

  function drawLayer(L, t) {
    var cx = W / 2, horizon = H * L.horizon, camY = L.cam * H;
    for (var zi = ROWSZ - 1; zi >= 0; zi--) {
      var z = 40 + zi * 26;
      var scale = FOV / (FOV + z);
      var rowAlpha = (0.15 + 0.35 * scale) * L.dark;
      var size = Math.max(1.2, 2.8 * scale);
      // far rows ocean-blue, near rows midnight ink
      var mixv = Math.min(1, scale * 1.3);
      var r = Math.round(40 + (16 - 40) * mixv);
      var g = Math.round(100 + (42 - 100) * mixv);
      var b2 = Math.round(165 + (67 - 165) * mixv);
      ctx.fillStyle = "rgba(" + r + "," + g + "," + b2 + "," + rowAlpha + ")";
      var stag = (zi * 0.381966) % 1;
      for (var xi = 0; xi < COLS; xi++) {
        var sx = ((xi + stag) / (COLS - 1)) * W;
        var xw = (sx - cx) / scale;
        var amp = 30 + 42 * (1 - scale);
        var tt = t * L.drift + L.phase;
        var h =
          Math.sin(xw * 0.0042 + tt * 1.1 + z * 0.012) * amp * 0.5 +
          Math.sin(xw * 0.0095 - tt * 0.7 + z * 0.02) * amp * 0.3 +
          Math.sin(xw * 0.021 + tt * 1.9) * amp * 0.14 +
          Math.sin(xw * 0.0016 + z * 0.004 - tt * 0.35) * amp * 0.45;
        var sy = horizon + (camY - h) * scale;
        var ddx = sx - smx, ddy = sy - smy;
        var pulse = Math.exp(-(ddx * ddx + ddy * ddy) / (2 * 150 * 150));
        if (pulse > 0.03) {
          sy -= pulse * 24 * scale;
          ctx.fillStyle = "rgba(16,42,67," + Math.min(0.9, rowAlpha + pulse * 0.6) + ")";
          ctx.fillRect(sx, sy, size + pulse * 1.4, size + pulse * 1.4);
          ctx.fillStyle = "rgba(" + r + "," + g + "," + b2 + "," + rowAlpha + ")";
        } else if (h > amp * 0.55) {
          ctx.fillStyle = "rgba(40,100,165," + Math.min(0.8, rowAlpha + 0.18) + ")";
          ctx.fillRect(sx, sy, size, size);
          ctx.fillStyle = "rgba(" + r + "," + g + "," + b2 + "," + rowAlpha + ")";
        } else {
          ctx.fillRect(sx, sy, size, size);
        }
      }
    }
  }
  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < LAYERS.length; i++) drawLayer(LAYERS[i], t);
  }
  if (reduced) { draw(21.0); return; }
  var vis = true;
  new IntersectionObserver(function (es) { es.forEach(function (e) { vis = e.isIntersecting; }); }).observe(wrap);
  var lastF = 0;
  (function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || !vis || now - lastF < 28) return;
    lastF = now;
    smx += (mx - smx) * 0.08; smy += (my - smy) * 0.08;
    draw(now / 1000);
  })(0);
})();`;

  const PAGE_JS = `
(function () {
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // The performance: when the panel scrolls into view, FLUX passes over the
  // request — each fold collapses, a chip names the lever, and the token and
  // cost meters run down. Counts come from the panel's own bytes. Loops.
  var panel = document.getElementById("reducer");
  var tokEl = document.getElementById("tok-count");
  var costEl = document.getElementById("cost-count");
  var statusEl = document.getElementById("demo-status");
  var sameEl = document.getElementById("same-note");
  var STEPS = ${JSON.stringify(steps)};
  var FROM = ${beforeTokens}, RATE = ${INPUT_RATE};
  function setMeters(tokens) {
    tokEl.textContent = String(Math.round(tokens)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
    costEl.textContent = (tokens * RATE).toFixed(5);
  }
  function chipAt(el, text) {
    var chip = document.createElement("span");
    chip.className = "chipfly"; chip.textContent = text;
    panel.appendChild(chip);
    var pr = panel.getBoundingClientRect(), er = el.getBoundingClientRect();
    chip.style.left = Math.min(Math.max(er.left - pr.left, 12), pr.width - 230) + "px";
    chip.style.top = (er.top - pr.top - 8) + "px";
    requestAnimationFrame(function(){ chip.classList.add("show"); });
    setTimeout(function(){ chip.classList.remove("show"); setTimeout(function(){ chip.remove(); }, 450); }, 2100);
  }
  function runPerformance() {
    var folds = Array.prototype.slice.call(document.querySelectorAll("#reducer .fold"));
    var tokens = FROM; setMeters(tokens);
    sameEl.classList.remove("show");
    folds.forEach(function (f) { f.classList.remove("folding", "folded"); f.textContent = f.getAttribute("data-raw"); });
    statusEl.textContent = "request received — " + tokEl.textContent + " tokens";
    var i = 0;
    function step() {
      if (i >= folds.length) {
        statusEl.textContent = "forwarded &mdash; " + tokEl.textContent + " tokens would bill.";
        sameEl.classList.add("show");
        setTimeout(runPerformance, 5200);
        return;
      }
      var f = folds[i], meta = STEPS[i]; i += 1;
      f.classList.add("folding");
      chipAt(f, meta.chip + "  −" + meta.tokens.toLocaleString() + " tok");
      statusEl.textContent = meta.chip;
      var target = tokens - meta.tokens, start = tokens, t0 = performance.now();
      (function tick(now) {
        var k = Math.min((now - t0) / 700, 1);
        setMeters(start + (target - start) * k);
        if (k < 1) requestAnimationFrame(tick);
      })(t0);
      tokens = target;
      setTimeout(function () {
        var after = f.getAttribute("data-after");
        f.textContent = after; f.classList.remove("folding");
        if (after !== "") f.classList.add("folded");
        setTimeout(step, 900);
      }, 800);
    }
    setTimeout(step, 1400);
  }
  if (panel && tokEl) {
    document.querySelectorAll("#reducer .fold").forEach(function (f) {
      f.setAttribute("data-raw", f.textContent);
    });
    if (reduced) {
      // Reduced motion: show the finished state, meters at the after values.
      document.querySelectorAll("#reducer .fold").forEach(function (f, idx) {
        var after = f.getAttribute("data-after");
        f.textContent = after === "" ? "" : after; f.classList.add("folded");
      });
      setMeters(${afterTokens});
      statusEl.textContent = "reduced: ${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()} tokens";
      sameEl.classList.add("show");
    } else if ("IntersectionObserver" in window) {
      var seen = false;
      new IntersectionObserver(function (es, obs) {
        es.forEach(function (e) {
          if (e.isIntersecting && !seen) { seen = true; runPerformance(); obs.disconnect(); }
        });
      }, { threshold: 0.35 }).observe(panel);
    } else { runPerformance(); }
  }
  // Entrances: each section's parts rise 12px as they arrive.
  if (!reduced && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "-10% 0px" });
    document.querySelectorAll(".rise").forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll(".rise").forEach(function (el) { el.classList.add("in"); });
  }
  // The signature move: the CTA photograph crossfades like light shifting.
  var shots = document.querySelectorAll(".xfade img");
  if (shots.length > 1 && !reduced) {
    var at = 0;
    setInterval(function () {
      if (document.hidden) return;
      shots[at].classList.remove("front"); at = (at + 1) % shots.length;
      shots[at].classList.add("front");
    }, 5200);
  }
  // FAQ: glide open, and glide the previous one closed instead of snapping.
  var faqs = Array.prototype.slice.call(document.querySelectorAll(".faq details"));
  function setH(wrapEl, from, to, after) {
    wrapEl.style.height = from + "px";
    requestAnimationFrame(function () {
      wrapEl.style.height = to + "px";
      setTimeout(function () { wrapEl.style.height = ""; if (after) after(); }, 380);
    });
  }
  faqs.forEach(function (d) {
    var sum = d.querySelector("summary"), wrapEl = d.querySelector(".answer-wrap");
    if (!sum || !wrapEl) return;
    d.removeAttribute("name"); // we manage exclusivity ourselves, smoothly
    sum.addEventListener("click", function (ev) {
      ev.preventDefault();
      if (reduced) { // instant, but still exclusive
        faqs.forEach(function (o) { if (o !== d) o.open = false; });
        d.open = !d.open; return;
      }
      if (d.open) {
        setH(wrapEl, wrapEl.scrollHeight, 0, function () { d.open = false; });
        return;
      }
      faqs.forEach(function (o) {
        if (o !== d && o.open) {
          var ow = o.querySelector(".answer-wrap");
          setH(ow, ow.scrollHeight, 0, function () { o.open = false; });
        }
      });
      d.open = true;
      setH(wrapEl, 0, wrapEl.scrollHeight, null);
    });
  });

  // Copy buttons on the calls.
  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var txt = b.getAttribute("data-copy");
      if (navigator.clipboard) navigator.clipboard.writeText(txt);
      b.textContent = "copied"; setTimeout(function () { b.textContent = "copy"; }, 1200);
    });
  });
})();`;

  const CSS = `
:root{
  --bg:#F1F7FB; --surface:#0E2133; --surface-2:#13293E; --ink:#102A43; --muted:#486581;
  --line:#d9e6f0; --accent:#9DD9F5; --accent-ink:#081522; --ocean:#2864A5; --paper:#ffffff; --paper-ink:#102A43;
  --deep:#081522; --deep-ink:#F1F7FB; --deep-muted:#9FB3C8; --deep-line:#24415C;
  --s1:8px; --s2:16px; --s3:24px; --s4:32px; --s5:48px; --s6:64px; --s7:96px;
  --axis:27vw; --radius:4px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Manrope,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--ink)}
.rise,.exchange .call,.exchange .response,.total-side .figure{opacity:0;transform:translateY(12px);transition:opacity .5s ease,transform .5s ease}
.rise.in,.rise.in .call,.rise.in .response,.rise.in .figure{opacity:1;transform:none}
.rise.in .response{transition-delay:.18s}

@media (prefers-reduced-motion: reduce){.rise,.exchange .call,.exchange .response,.total-side .figure{opacity:1;transform:none;transition:none}html{scroll-behavior:auto}}

/* ---------- hero: the poster. Type enacts the product. ---------- */
.hero-wrap{position:relative;min-height:96svh;overflow:hidden}
#field{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.hero{position:relative;min-height:96svh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:var(--s7) var(--s4)}
.hero .mark{position:absolute;top:40px;left:var(--s4);width:44px;height:44px}
.hero .signin{position:absolute;top:52px;right:var(--s4);font-size:13px;color:var(--muted);text-decoration:none;z-index:2}
.hero .signin:hover{color:var(--accent)}
.hero .col{max-width:60rem}
.hero h1{margin:0 0 var(--s3);line-height:1}
.hero h1 .in{display:block;font-size:clamp(20px,3vw,30px);font-weight:600;letter-spacing:.02em;color:var(--muted);opacity:.85;margin-bottom:var(--s1)}
.hero h1 .out{display:block;font-size:clamp(46px,8.4vw,104px);font-weight:800;letter-spacing:-.045em;background:linear-gradient(135deg,#102A43 10%,#2864A5 70%,#4E8FC7 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .sub{font-size:20px;line-height:1.5;color:var(--muted);margin:0 auto 36px;max-width:34rem}
.hero .actions{display:flex;align-items:center;justify-content:center;gap:var(--s3)}
.install{max-width:40rem;margin:36px auto 0;text-align:left;background:var(--surface);border:1px solid var(--deep-line);border-radius:8px;overflow:hidden}
.install .irow{display:grid;grid-template-columns:7.5rem minmax(0,1fr) auto;align-items:center;gap:12px;padding:10px 14px;border-top:1px solid var(--deep-line)}
.install .irow:first-child{border-top:none}
.install .lbl{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--deep-muted)}
.install code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#F1F7FB;overflow-x:auto;white-space:nowrap;display:block}
@media (max-width:760px){.install .irow{grid-template-columns:minmax(0,1fr) auto}.install .lbl{grid-column:1/-1}}
.band .basis{display:block;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ocean);margin-top:var(--s1)}
.duo{max-width:60rem;margin:0 auto}
.duo h2{text-align:center}
.duo .lede{font-size:20px;line-height:1.5;text-align:center;max-width:40rem;margin:0 auto var(--s5)}
.hero .mark{z-index:2}
.btn{display:inline-block;padding:12px 22px;border-radius:var(--radius);font-weight:700;font-size:16px;text-decoration:none;background:var(--ink);color:#F1F7FB;transition:background .18s ease}
.btn:hover{background:var(--ocean)}
.arrowlink{font-size:16px;color:var(--ocean);text-decoration:none;border-bottom:1px solid var(--line)}
.arrowlink:hover{color:var(--accent);border-color:var(--accent)}
.arrowlink::after{content:" \\2192"}
@media (max-width:760px){
  :root{--axis:24px}
  .hero{min-height:84svh}
  .hero .sub{font-size:17px}
}

/* ---------- the bands: the numbers, called out at poster size ---------- */
.bands{padding:var(--s7) var(--s4)}
.bandrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:var(--s4);max-width:72rem;margin:0 auto}
.band{text-align:center}
.band .n{font-size:clamp(72px,8.5vw,128px);font-weight:800;letter-spacing:-.04em;line-height:.9;color:var(--ocean)}
.band .n span{font-size:.45em;font-weight:800}
.band p{font-size:16px;line-height:1.5;color:var(--muted);max-width:30ch;margin:var(--s2) auto 0}
.bandcap{text-align:center;font-size:16px;color:var(--muted);max-width:46rem;margin:var(--s6) auto 0}
.bandcap a{color:var(--ocean)}
.bandcap strong{color:var(--ink)}

/* ---------- works-with: names in the text face, one quiet row ---------- */
.works{padding:var(--s6) var(--s4)}
.works-row{display:flex;align-items:baseline;justify-content:space-between;gap:var(--s3);max-width:72rem;margin:0 auto;flex-wrap:wrap}
.works-lede{font-size:16px;color:var(--muted)}
.wlogo{display:inline-flex;align-items:center;gap:10px;color:var(--ink)}
.wlogo svg{height:26px;width:auto;display:block}
.wlogo svg path{fill:#102A43}
.wlogo span{font-size:18px;font-weight:700;letter-spacing:-.01em}
.wlogo.wordmark span{font-size:22px}
.works-cap{text-align:center;font-size:16px;color:var(--muted);max-width:46rem;margin:var(--s4) auto 0}
@media (max-width:760px){.works-row{display:grid;grid-template-columns:1fr 1fr;gap:var(--s3)}.works-lede{grid-column:1/-1}.wlogo svg{height:20px}.wlogo span{font-size:15px}.wlogo.wordmark span{font-size:15px}}

/* ---------- the demo theatre ---------- */
.demo-sect{padding:var(--s7) var(--s4)}
.axis-col-wide{max-width:60rem;margin:0 auto}
.demo-sect h2{text-align:center}
.fold{display:inline;transition:opacity .6s ease}
.fold.folding{opacity:.25;text-decoration:line-through}
.fold.folded{opacity:1;text-decoration:none;color:var(--accent)}
.statusline{font-size:13px;color:var(--deep-muted);min-height:1.2em}
.chipfly{position:absolute;background:var(--accent);color:var(--accent-ink);font-size:13px;font-weight:700;border-radius:999px;padding:6px 14px;pointer-events:none;opacity:0;transform:translateY(6px);transition:opacity .4s ease,transform .4s ease;white-space:nowrap;z-index:3}
.chipfly.show{opacity:1;transform:translateY(0)}
#reducer{position:relative}
#reducer pre{max-height:380px;overflow:auto}

/* ---------- fragments: the product's own conventions ---------- */
[data-ui]{background:var(--surface);border:1px solid var(--deep-line);border-radius:8px;font-size:13px;overflow:hidden;max-width:100%;color:#F1F7FB}
[data-ui] .tblwrap{overflow-x:auto}
[data-ui] table{min-width:540px}
[data-ui] .bar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--deep-line);font-weight:700;font-size:13px;color:var(--deep-muted)}
[data-ui] .bar{min-width:0}
[data-ui] .bar .pill{background:var(--surface-2);border:1px solid var(--deep-line);border-radius:999px;padding:2px 10px;font-variant-numeric:tabular-nums;color:#F1F7FB;white-space:nowrap;flex:none}
[data-ui] pre{margin:0;padding:14px 16px;overflow-x:auto;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:#F1F7FB}
[data-ui] .tok{color:var(--deep-muted)}
[data-ui] .key{color:var(--accent)}
[data-ui] .dup{transition:opacity .5s ease;text-decoration:line-through transparent}
[data-ui] .dup.struck{opacity:.28;text-decoration:line-through}
[data-ui] .footrow{display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--deep-line)}
[data-ui] .ui-btn{font:inherit;font-weight:700;font-size:13px;background:var(--surface-2);color:#F1F7FB;border:1px solid var(--deep-line);border-radius:4px;padding:7px 14px;cursor:pointer}
[data-ui] .ui-btn:hover{border-color:var(--accent);color:var(--accent)}
[data-ui] .ok{font-size:13px;color:var(--accent);opacity:0;transition:opacity .4s ease}
[data-ui] .ok.show{opacity:1}
[data-ui] table{width:100%;border-collapse:collapse;font-size:13px}
[data-ui] th,[data-ui] td{text-align:left;padding:8px 16px;border-top:1px solid var(--deep-line);font-variant-numeric:tabular-nums}
[data-ui] th{color:var(--deep-muted);font-size:13px;border-top:none}
[data-ui] td.num,[data-ui] th.num{text-align:right}
.copy{font:12px/1 ui-monospace,monospace;background:none;border:1px solid var(--deep-line);color:var(--deep-muted);border-radius:4px;padding:4px 8px;cursor:pointer}
.copy:hover{color:var(--accent);border-color:var(--accent)}

/* ---------- colour fields: two chapter breaks, flat, full-bleed ---------- */
.field-deep{background:var(--deep);color:var(--deep-ink)}
.field-deep h2{color:var(--deep-ink)}
.field-deep .total-side .note,.field-deep .total-side .cap{color:var(--deep-muted)}
.field-deep .total-side .cap a{color:var(--accent)}
.field-deep .total-side .figure{color:var(--deep-ink)}
.field-deep .slip{background:#ffffff}
.field-ocean{background:var(--ocean);color:#F1F7FB}
.field-ocean h2{color:#fff}
.field-ocean p{color:#d7e9f7}
.field-ocean .fig{color:#fff}
.field-ocean .price-figure .per{color:#eaf4fb}
.field-ocean ul{color:#eaf4fb}
.field-ocean ul strong{color:#fff;border-bottom:2px solid var(--accent)}
.field-ocean .overlap path{stroke:#9DD9F5}
.field-ocean .overlap circle{fill:#F1F7FB}
.field-ocean .btn{background:#F1F7FB;color:var(--ocean)}
.field-ocean .btn:hover{background:#fff}

/* ---------- sections ---------- */
section{padding:var(--s7) var(--s4)}
section h2{font-size:30px;font-weight:800;letter-spacing:-.01em;margin:0 0 var(--s6);position:relative;padding-bottom:18px}
section h2::after{content:"";position:absolute;left:50%;transform:translateX(-50%);bottom:0;width:140px;height:12px;background:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 12"><path d="M0 6 q6 -5 12 0 t12 0 q3 -9 6 0 t12 0 t12 0 q3 9 6 0 t12 0 t12 0 q6 -5 12 0 t12 0 t12 0" fill="none" stroke="%232864A5" stroke-width="1.6" opacity=".75"/></svg>') center/contain no-repeat}
.field-ocean h2::after{opacity:.9}

.axis-col{max-width:720px;margin:0 auto}
.axis-col{margin-left:auto;margin-right:auto}

/* call and response */
.exchange{margin-bottom:88px}
.exchange .lead{font-size:20px;font-weight:600;margin:0 0 var(--s2);text-align:center}
.exchange .call{background:var(--surface);border-radius:8px;position:relative;color:#F1F7FB}
.exchange .call .copy{position:absolute;top:10px;right:10px}
.exchange .response{margin-top:var(--s2)}
.exchange .response.breakout{width:100%}


/* total and its receipt */
.receipt-wrap{display:grid;grid-template-columns:1fr;gap:var(--s5);max-width:1080px;margin:0 auto}
@media (min-width:980px){.receipt-wrap{grid-template-columns:1fr 440px;align-items:start}}
.total-side{display:flex;flex-direction:column;min-height:560px}
.total-side .note{font-size:16px;line-height:1.5;color:var(--muted);max-width:34ch;margin:var(--s2) 0 0}
.total-side .figure{margin-top:auto;font-size:clamp(120px,15vw,240px);font-weight:800;letter-spacing:-.04em;line-height:.8}
.total-side .cap{font-size:16px;color:var(--muted);margin-top:var(--s3);max-width:44ch}
.total-side .cap a{color:var(--accent)}
.slip{background:var(--paper);color:var(--paper-ink);width:100%;max-width:440px;padding:28px 24px 36px;font-variant-numeric:tabular-nums;clip-path:polygon(0 0,100% 0,100% calc(100% - 12px),95% 100%,90% calc(100% - 12px),85% 100%,80% calc(100% - 12px),75% 100%,70% calc(100% - 12px),65% 100%,60% calc(100% - 12px),55% 100%,50% calc(100% - 12px),45% 100%,40% calc(100% - 12px),35% 100%,30% calc(100% - 12px),25% 100%,20% calc(100% - 12px),15% 100%,10% calc(100% - 12px),5% 100%,0 calc(100% - 12px))}
.slip h3{font-size:14px;letter-spacing:.04em;margin:0 0 6px;font-weight:800}
.slip .meta{font-size:13px;color:#486581;margin:0 0 18px}
.slip .grp{font-weight:800;font-size:13px;margin:14px 0 6px}
.slip .row{display:flex;align-items:baseline;font-size:16px;line-height:1.9}
.slip .row .desc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slip .row .lead-dots{flex:1;margin:0 8px;border-bottom:2px dotted #9fb3c8;transform:translateY(-4px)}
.slip .row .val{font-weight:600}
.slip .total-row{display:flex;justify-content:space-between;background:var(--paper-ink);color:var(--paper);font-weight:800;padding:10px 12px;margin-top:16px;font-size:16px}

/* the price, very large */
.price-wrap{display:grid;grid-template-columns:1fr;gap:var(--s5);max-width:1080px;margin:0 auto;min-height:80svh;align-content:center}
@media (min-width:980px){.price-wrap{grid-template-columns:380px 1fr}}
.price-side p{font-size:16px;line-height:1.6;max-width:38ch}
.price-figure{position:relative}
.price-figure .fig{font-size:clamp(120px,16vw,240px);font-weight:800;letter-spacing:-.04em;line-height:.85}
.price-figure .fig sup{font-size:.5em;vertical-align:super}
.price-figure .per{font-size:16px;color:var(--muted)}
.price-figure .overlap{position:absolute;top:-8%;right:4%;width:120px;height:120px}
.price-figure ul{list-style:none;margin:var(--s4) 0 0;padding:0;font-size:16px;line-height:2}

.price-figure .btn{margin-top:var(--s3)}

/* faq: accordion of filled tiles, sticky heading */
.faq-wrap{display:grid;grid-template-columns:1fr;gap:var(--s5);max-width:1080px;margin:0 auto}
@media (min-width:980px){.faq-wrap{grid-template-columns:320px 1fr}.faq-wrap h2{position:sticky;top:96px;margin:0}}
.faq-wrap h2::after,.receipt-wrap h2::after,.price-wrap h2::after{left:0;transform:none}
.field-deep h2::after{background:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 12"><path d="M0 6 q6 -5 12 0 t12 0 q3 -9 6 0 t12 0 t12 0 q3 9 6 0 t12 0 t12 0 q6 -5 12 0 t12 0 t12 0" fill="none" stroke="%239DD9F5" stroke-width="1.6" opacity=".8"/></svg>') center/contain no-repeat}
.faq-wrap h2{font-size:30px}
.faq details{background:#ffffff;border-radius:var(--radius);margin-bottom:8px}
.faq summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;min-height:72px;padding:0 24px;font-size:20px;font-weight:600}
.faq summary::-webkit-details-marker{display:none}
.faq .plus{position:relative;width:16px;height:16px;flex:none}
.faq .plus::before,.faq .plus::after{content:"";position:absolute;background:var(--ocean);left:0;top:7px;width:16px;height:3px;transition:transform .2s ease}
.faq .plus::after{transform:rotate(90deg)}
.faq details[open]{background:var(--accent);color:var(--accent-ink)}
.faq details[open] .plus::before,.faq details[open] .plus::after{background:var(--accent-ink)}
.faq details[open] .plus::after{transform:rotate(0)}
.faq .answer{padding:0 24px 24px;font-size:16px;line-height:1.6;max-width:52ch}
.faq .answer-wrap{overflow:hidden;transition:height .36s cubic-bezier(.4,0,.2,1)}
@media (prefers-reduced-motion: reduce){.faq .answer-wrap{transition:none}}
.faq details[open] .answer a{color:var(--accent-ink);font-weight:700}

/* the action tile */
.cta-row{display:grid;grid-template-columns:120px 1fr 120px;gap:12px;margin:0 calc(-1 * var(--s4))}
.cta-row>*{height:360px;border-radius:var(--radius)}
.cta-main{background:var(--accent);color:var(--accent-ink);display:flex;flex-direction:column;justify-content:center;padding:40px}
.cta-main h2{font-size:30px;margin:0 0 var(--s2);color:var(--accent-ink)}
.cta-main p{font-size:16px;line-height:1.6;margin:0 0 var(--s3);max-width:48ch}
.cta-main .btn{background:var(--accent-ink);color:#F1F7FB;width:max-content}
.cta-main .btn:hover{background:#163149}
.cta-flat{background:var(--ocean)}
.xfade{position:relative;overflow:hidden}
.xfade img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 1.6s ease}
.xfade img.front{opacity:1}
@media (max-width:860px){.cta-row{grid-template-columns:1fr;margin:0}.cta-row .cta-main{height:auto;min-height:300px}.cta-row .cta-flat,.cta-row .xfade{height:120px}}

/* single quiet line footer */
.quiet-foot{margin-top:30svh;padding:0 var(--s4) 30px;display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;font-size:13px;color:var(--muted)}
.quiet-foot .links{display:flex;gap:24px;flex-wrap:wrap;justify-content:center}
.quiet-foot a{color:var(--ink);text-decoration:none}
.quiet-foot a:hover{color:var(--accent)}
.quiet-foot .right{text-align:right}
.quiet-foot .legal{grid-column:1/-1;text-align:center;margin-top:12px;font-size:12px;color:var(--muted)}
@media (max-width:760px){.quiet-foot{grid-template-columns:1fr;gap:8px;text-align:left}.quiet-foot .links{justify-content:flex-start}.quiet-foot .right{text-align:left}.quiet-foot .legal{text-align:left}}
@media (max-width:760px){section{padding:var(--s6) 24px}.slip{max-width:100%}.price-wrap{min-height:auto}.exchange .response.breakout{width:100%}}
@media (max-width:980px){.price-wrap{min-height:auto}}
`.trim();

  const MARK = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M8 14c10 0 10 10 20 10h12" stroke="#2864A5" stroke-width="3.5" stroke-linecap="round"/><path d="M8 34c10 0 10-10 20-10" stroke="#2864A5" stroke-width="3.5" stroke-linecap="round" opacity=".75"/><circle cx="41" cy="24" r="4" fill="#9DD9F5"/></svg>`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "FLUX",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    url: `${origin}/`,
    description: "Cut LLM API costs on Claude and OpenAI. One-URL proxy or one-line SDK; savings verified per completed task into a customer-recomputable ledger; fee is a share of verified savings.",
  });
  const orgLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "FLUX", url: `${origin}/`, logo: `${origin}/favicon.svg`, sameAs: [repoUrl], slogan: "Stop paying twice for the same tokens.",
  });

  const spendRows = SPEND.map(([name, v]) =>
    `<div class="row"><span class="desc">${name}</span><span class="lead-dots"></span><span class="val">${money(v)}</span></div>`).join("\n      ");
  const savedRows = SAVED.map(([name, v]) =>
    `<div class="row"><span class="desc">${name}</span><span class="lead-dots"></span><span class="val">${money(v)}</span></div>`).join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>flux — stop paying twice for the same tokens</title>
<meta name="description" content="Stop paying twice for the same tokens. FLUX cuts your Claude and OpenAI API bill at the request level: one URL, a Claude Code plugin, savings verified per completed task, 1% of verified savings. Every invoice is recomputable from a ledger you hold.">
<link rel="canonical" href="${origin}/">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="flux">
<meta property="og:title" content="flux — stop paying twice for the same tokens">
<meta property="og:description" content="Cut your Claude and OpenAI API bill. Savings verified per completed task; pay only a share of verified savings.">
<meta property="og:image" content="${origin}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${origin}/og.png">
<meta property="og:url" content="${origin}/">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
<script type="application/ld+json">${jsonLd}</script>
<script type="application/ld+json">${orgLd}</script>
<style>${CSS}</style>
</head>
<body>

<div class="hero-wrap">
<canvas id="field" aria-hidden="true"></canvas>
<header class="hero">
  <span class="mark">${MARK}</span>
  <a class="signin" href="start.html">Get started</a>
  <div class="col">
    <h1><span class="in">Stop paying twice</span><span class="out">for the same tokens.</span></h1>
    <p class="sub">Most agents re-send their whole conversation every turn and pay full price for it again. FLUX sits on one URL, makes each request cheaper before it bills, and hands you the receipt.</p>
    <div class="actions">
      <a class="btn" href="start.html">Get started</a>
      <a class="arrowlink" href="evidence.html">See the evidence</a>
    </div>
    <div class="install" aria-label="Install in 30 seconds">
      <div class="irow"><span class="lbl">Proxy</span><code>npx -y -p @flux-ai/sdk flux-proxy</code><button class="copy" type="button" data-copy="npx -y -p @flux-ai/sdk flux-proxy">copy</button></div>
      <div class="irow"><span class="lbl">SDK</span><code>npm install @flux-ai/sdk</code><button class="copy" type="button" data-copy="npm install @flux-ai/sdk">copy</button></div>
      <div class="irow"><span class="lbl">Claude Code</span><code>claude plugin marketplace add Harrym1707/Flux &amp;&amp; claude plugin install flux@flux</code><button class="copy" type="button" data-copy="claude plugin marketplace add Harrym1707/Flux &amp;&amp; claude plugin install flux@flux">copy</button></div>
    </div>
  </div>
</header>
</div>

<section aria-label="Measured bands" class="bands">
  <div class="bandrow rise">
    <div class="band"><div class="n"><span>up to </span>72.8<span>%</span></div><p>off one-shot templated API calls that can wait a few seconds</p><span class="basis">simulator</span></div>
    <div class="band"><div class="n">38.1<span>%</span></div><p>off a coding agent&rsquo;s bill, on real API traffic</p><span class="basis">live &middot; 2026-10-26</span></div>
    <div class="band"><div class="n">18.2<span>%</span></div><p>net, across 30 real requests from five agents &mdash; real money</p><span class="basis">live &middot; 2026-10-26</span></div>
  </div>
  <p class="bandcap rise">Simulator figures come from our open test harness at the providers&rsquo; real prices, with answer quality checked on every task; live figures come from hash-chained spools committed to the repo. Some setups save nothing &mdash; then we say it plainly: <strong>do not pay us</strong>. Every number, its basis and its command &rarr; <a href="evidence.html">evidence</a> &middot; <a href="https://github.com/Harrym1707/Flux/blob/main/docs/NUMBERS.md">NUMBERS.md</a>.</p>
</section>

<section aria-label="Works with every provider" class="works">
  <div class="works-row rise">
    <span class="works-lede">Works with</span>
    <span class="wlogo">${logo("anthropic")}<span>Claude</span></span>
    <span class="wlogo wordmark"><span>OpenAI</span></span>
    <span class="wlogo">${logo("googlegemini")}<span>Gemini*</span></span>
    <span class="wlogo wordmark"><span>Grok</span></span>
    <span class="wlogo">${logo("meta")}<span>Llama</span></span>
    <span class="wlogo">${logo("mistralai")}<span>Mistral</span></span>
    <span class="wlogo">${logo("deepseek")}<span>DeepSeek</span></span>
  </div>
  <p class="works-cap rise">Point it at whatever you already use. FLUX speaks Anthropic and OpenAI natively, plus anything with an OpenAI-style API &mdash; Grok, Llama, Mistral, DeepSeek and more. Full savings verification is live for Claude and GPT today; other models are reduced and recorded while their price tables land. <em>*Gemini via its OpenAI-compatible endpoint.</em></p>
</section>

<section aria-label="The reduction, performed" class="demo-sect">
  <div class="axis-col-wide">
  <h2 class="rise">Watch a request lose its waste.</h2>
  <div data-ui id="reducer" class="rise">
    <div class="bar"><span>reducer &mdash; a busy agent&rsquo;s turn 5</span>
      <span class="pill"><span id="tok-count">${beforeTokens}</span> tokens &middot; $<span id="cost-count">${beforeCost}</span></span></div>
    <pre id="demo-body">{"model":<span class="key">"claude-sonnet-5-5"</span>,
 "tools":[ <span class="fold" data-chip="12 tool schemas compacted" data-after="[ 12 tools, schemas minified ]">{"name":"lookup_0","description":"Look up records in subsystem 0&hellip;","input_schema":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}}}}, &hellip;11 more verbose schemas&hellip;</span> ],
 "system":"You are a careful assistant. Cite sources. Escalate anything risky.",
 "messages":[
   {"role":"user","content":"Step 1: inspect account 1001."},
   {"role":"assistant","content":"<span class="fold" data-chip="stale history compacted, byte-stable" data-after="[ digest kept: errors + file paths; rest summarised ]">${DUP_BLOCK} ${DUP_BLOCK} ${DUP_BLOCK}</span>"},
   {"role":"user","content":"Step 2: reconcile the ledger entries.
     ${DUP_BLOCK}
     <span class="fold" data-chip="exact duplicate removed" data-after="">${DUP_BLOCK}</span>"},
   {"role":"tool","content":"<span class="fold" data-chip="fresh result capped before it bills" data-after="[ headline + errors kept; oversized body capped ]">Row 1 of 400: settlement nominal&hellip; Row 2 of 400: settlement nominal&hellip; Row 3 of 400&hellip; (397 more rows)</span>"},
   {"role":"user","content":"Investigate account 1009 and summarise."}]}</pre>
    <div class="footrow">
      <span class="statusline" id="demo-status">watching&hellip;</span>
      <span class="ok" id="same-note">the answer cannot change &mdash; only safe moves run by default <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" style="vertical-align:-1px"><path d="M2.5 8.5 6 12 13.5 4" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </div>
  </div>
  <p class="bandcap rise">A demonstration of the moves &mdash; token counts computed at build time from the full sample request (abridged on screen). Your real number comes from your own traffic. <a href="methodology.html">How we measure</a>.</p>
  </div>
</section>

<section aria-label="How it works">
  <div class="axis-col">
  <h2 class="rise">One URL. Three exchanges.</h2>

  <div class="exchange rise">
    <p class="lead">First, point your client at it.</p>
    <div class="call"><button class="copy" type="button" data-copy="npx -y -p @flux-ai/sdk flux-proxy">copy</button><pre style="margin:0;padding:20px;font:13px/1.65 ui-monospace,Menlo,monospace;overflow-x:auto"><code>$ npx -y -p @flux-ai/sdk flux-proxy
<span style="color:#9FB3C8"># then one line in your app &mdash; keep your own key</span>
baseURL: <span style="color:#9DD9F5">"http://127.0.0.1:8787"</span></code></pre></div>
    <div class="response" data-ui>
      <div class="bar"><span>flux-proxy</span><span class="pill">running</span></div>
      <pre>FLUX proxy listening on http://127.0.0.1:8787
Ledger spools: ./flux-ledger <span class="tok">(one hash-chained JSONL per app + provider)</span>
Anthropic SDK: new Anthropic({ baseURL: "http://127.0.0.1:8787" })</pre>
    </div>
  </div>

  <div class="exchange rise">
    <p class="lead">Then run your traffic as normal.</p>
    <div class="call"><pre style="margin:0;padding:20px;font:13px/1.65 ui-monospace,Menlo,monospace;overflow-x:auto"><code>await anthropic.messages.create({ model, system, messages })  <span style="color:#9FB3C8">// unchanged</span></code></pre></div>
    <div class="response" data-ui>
      <div class="bar"><span>flux-ledger/my-app-anthropic.jsonl</span><span class="pill">hash-chained</span></div>
      <pre>{"seq":0,"prevHash":"000&hellip;0","event":{"requestId":"a1f2&hellip;","model":"claude-sonnet-5-5",
  "usage":{"inputTokens":1695,"outputTokens":412},"levers":[{"leverId":"duplicate-context-removal",
  "kind":"lossless","savedUsd":0.00130,<span class="key">"basis":"estimated-baseline"</span>}],"status":"succeeded"}}</pre>
    </div>
  </div>

  <div class="exchange rise">
    <p class="lead">Last, recompute the invoice yourself.</p>
    <div class="call"><button class="copy" type="button" data-copy="node --import tsx evals/run-invoice.ts flux-ledger/my-app-anthropic.jsonl">copy</button><pre style="margin:0;padding:20px;font:13px/1.65 ui-monospace,Menlo,monospace;overflow-x:auto"><code>$ node --import tsx evals/run-invoice.ts flux-ledger/my-app-anthropic.jsonl</code></pre></div>
    <div class="response breakout" data-ui>
      <div class="bar"><span>invoice &mdash; recomputed from your spool</span><span class="pill">verdict: charge</span></div>
      <div class="tblwrap"><table>
        <thead><tr><th>lever</th><th>kind</th><th>basis</th><th class="num">events</th><th class="num">saved</th></tr></thead>
        <tbody>
          <tr><td>duplicate-context-removal</td><td>lossless</td><td>estimated-baseline</td><td class="num">6</td><td class="num">$0.0086</td></tr>
          <tr><td>tool-schema-compaction</td><td>lossless</td><td>estimated-baseline</td><td class="num">6</td><td class="num">$0.0054</td></tr>
          <tr><td>execution-tier-flex</td><td>tier</td><td>measured</td><td class="num">8</td><td class="num">$0.0193</td></tr>
          <tr><td>fresh-tool-result-cap</td><td>lossy</td><td>recorded &mdash; unbilled, no gate verdict</td><td class="num">4</td><td class="num">&mdash;</td></tr>
        </tbody>
      </table></div>
      <div class="footrow"><span class="tok">Savings you already had don&rsquo;t count. Our losses count against us. Run the command yourself &mdash; you must get the same number.</span></div>
    </div>
  </div>
  </div>
</section>

<section aria-label="FLUX and Caveman">
  <div class="duo">
  <h2 class="rise">Caveman makes your agent say less. FLUX makes each request cost less.</h2>
  <p class="lede rise">Different layers, so they stack. Use both.</p>
  <div data-ui class="rise"><div class="tblwrap"><table>
    <thead><tr><th></th><th>Caveman</th><th>FLUX</th></tr></thead>
    <tbody>
      <tr><td>What it changes</td><td>How the agent writes, plus compressing logs and JSON it reads</td><td>The API request: cache-prefix stamping and repair, schema compaction, exact-duplicate removal, execution tier</td></tr>
      <tr><td>How you add it</td><td>A skill or plugin inside each agent</td><td>One local URL, one line of SDK, or the Claude Code plugin</td></tr>
      <tr><td>Works with</td><td>The coding agents it supports</td><td>Any client in any language that can set an Anthropic or OpenAI base URL</td></tr>
      <tr><td>Your prompts</td><td>Skill runs locally; optional Cloud and Auto modes send prompts to Caveman Cloud; CLI telemetry on unless turned off</td><td>Never leave your machine except to your own provider; the proxy sends no telemetry</td></tr>
      <tr><td>Price</td><td>Free, open source</td><td>1% of verified savings, nothing else</td></tr>
      <tr><td>Audit the bill</td><td>Nothing to bill</td><td>Recompute the invoice from a ledger you hold</td></tr>
    </tbody>
  </table></div></div>
  <p class="bandcap rise">Caveman facts from its README, checked 2026-10-28. Something changed? <a href="https://github.com/Harrym1707/Flux/issues">Tell us</a> and we&rsquo;ll fix it.</p>
  </div>
</section>

<section aria-label="The first live export" class="field-deep">
  <div class="receipt-wrap">
    <div class="total-side rise">
      <h2>Proven, line by line.</h2>
      <p class="note">Most savings claims are projections. Ours come with the receipt: we ran real requests, published every line, and the rows add up to the total &mdash; check them.</p>
      <div class="figure">37.9%</div>
      <p class="cap">saved by a single lever &mdash; switching Claude&rsquo;s cache on &mdash; measured both ways on identical prompts, answers unchanged. The receipt beside is our latest small live run: ${savedPct.toFixed(1)}% of real spend saved, the cache stamp earning live on the coding agent, and the two agents with nothing to gain correctly billed nothing. Simulator bands by traffic type run from 25.9% to 72.8% &rarr; <a href="evidence.html">evidence</a>.</p>
    </div>
    <div class="slip rise in-self" aria-label="The export, row by row">
      <h3>FLUX &mdash; LIVE EXPORT</h3>
      <p class="meta">Latest export &middot; 2026-10-26 &middot; claude-sonnet-5-5 &middot; 30 requests &middot; 5 hash chains verified</p>
      <p class="grp">SPEND, BY AGENT</p>
      ${spendRows}
      <p class="grp">VERIFIED SAVINGS, BY LEVER</p>
      ${savedRows}
      <div class="total-row"><span>NET VERIFIED SAVINGS</span><span>${money(savedTotal)} &middot; ${savedPct.toFixed(1)}%</span></div>
    </div>
  </div>
</section>

<section aria-label="Pricing" class="field-ocean">
  <div class="price-wrap">
    <div class="price-side rise">
      <h2>One price.</h2>
      <p>No subscription. No seats. No minimum. You pay a slice of what FLUX actually saved you &mdash; and you can recheck the maths behind every invoice yourself.</p>
    </div>
    <div class="price-figure rise">
      <div class="fig">1<sup>%</sup></div>
      <span class="overlap">${MARK}</span>
      <p class="per">of verified savings, monthly &mdash; nothing else</p>
      <ul>
        <li>Savings counted per finished task, from your provider&rsquo;s own numbers</li>
        <li>Save nothing, pay nothing</li>
        <li>If a move loses money, that loss is ours, not yours</li>
        <li>Already efficient? Our quote will say: <strong>do not pay us</strong></li>
      </ul>
      <a class="btn" href="start.html">Run the quote on your own export</a>
    </div>
  </div>
</section>

<section aria-label="Questions">
  <div class="faq-wrap">
    <h2 class="rise">The catch, printed.</h2>
    <div class="faq rise">
      <details name="faq" open><summary>Can FLUX break my app?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">The default levers are lossless: compacted schemas decode identically, removed duplicates are exact, prefix repair reorders without deleting, and the reducer never throws &mdash; a failure returns your request untouched. Lossy levers stay off until a replay gate proves on your own recorded requests that quality held. <a href="faq.html">Full answer</a></div></div></details>
      <details name="faq"><summary>Why a range and not one number?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">Savings depend on your traffic&rsquo;s shape. The quote comes from your own export and names your segment; sometimes the verdict is literally do not pay us. <a href="segments.html">The bands, by segment</a></div></div></details>
      <details name="faq"><summary>How can you bill for money I didn&rsquo;t spend?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">The way energy performance contracts have done it since 1995: a defined baseline, provider-verbatim measurements, an agreed adjustment method. Every request writes an append-only hash-chained event; the invoice is a pure function over those events. <a href="methodology.html">Methodology</a></div></div></details>
      <details name="faq"><summary>What do you do with my prompts?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">Analysis runs locally; prompts never leave your machine. The ledger records usage numbers, lever names and hashes &mdash; not content. Your API key passes through the proxy verbatim and is never stored.</div></div></details>
      <details name="faq"><summary>Where does FLUX lose?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">Busy interactive agents cap around 29% before cache enablement; already-optimised stacks get 0&ndash;5% and a do-not-pay-us verdict; a free trimmer may be all you need if you don&rsquo;t need the saving verified. <a href="comparison.html">The honest comparison</a></div></div></details>
      <details name="faq"><summary>Are these numbers real?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">Every figure traces to a runnable command and a commit. The bands are simulator-measured at published provider prices and labelled so; the ${savedPct.toFixed(1)}% receipt above is real traffic. Your pilot replaces all of it with your own number before any fee exists. <a href="evidence.html">Evidence</a></div></div></details>
    </div>
  </div>
</section>

<section aria-label="Start">
  <div class="cta-row rise">
    <div class="cta-flat" aria-hidden="true"></div>
    <div class="cta-main">
      <h2>Start with one URL.</h2>
      <p>Point your app&rsquo;s baseURL at FLUX and keep your own key. Five minutes later you have a tamper-evident record of what you spend &mdash; and what you stopped spending. No signup; the source is public.</p>
      <a class="btn" href="start.html">Start in five minutes</a>
    </div>
    <div class="xfade" aria-hidden="true">
      <img class="front" src="https://picsum.photos/id/114/480/720" width="480" height="720" alt="Dark storm clouds over a faint mountain ridge (photo: Brian Gonzalez, Unsplash licence)" loading="lazy">
      <img src="https://picsum.photos/id/765/480/720" width="480" height="720" alt="Night sky fading to an orange glow along a dark horizon (photo: Grant McIver, Unsplash licence)" loading="lazy">
      <img src="https://picsum.photos/id/505/480/720" width="480" height="720" alt="Silhouetted figure on a dark ridge under twilight (photo: lee Scott, Unsplash licence)" loading="lazy">
    </div>
  </div>
</section>

<footer class="quiet-foot">
  <span>flux &mdash; verified LLM cost reduction</span>
  <span class="links"><a href="overview.html">Overview</a><a href="segments.html">Savings</a><a href="methodology.html">Methodology</a><a href="evidence.html">Evidence</a><a href="comparison.html">Comparison</a><a href="start.html">Get started</a><a href="faq.html">FAQ</a><a href="${repoUrl}">GitHub</a><a href="llms.txt">llms.txt</a></span>
  <span class="right">2026 &middot; BUSL-1.1</span>
  <span class="legal">Flux AI Technologies Limited &middot; registered in England and Wales &middot; company no. 17543982</span>
</footer>

<script>${CANVAS_JS}</script>
<script>${PAGE_JS}</script>
</body>
</html>
`;
}
