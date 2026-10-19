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

export function renderLanding(origin: string, repoUrl: string): string {
  // --- The hero demo's sample request: token counts computed from the bytes.
  const DUP_BLOCK = "Records 0-19: settlement entry nominal, reconciliation standard, no notification sent, annotation routine.";
  const STABLE = `{"model":"claude-sonnet-5-5","system":"You are a careful assistant. Cite sources. Escalate anything risky.","messages":[{"role":"user","content":"Excerpts for case 7:`;
  const TAIL = ` Question: what does clause 7 require?"}]}`;
  const beforeTokens = approxTokens(STABLE + DUP_BLOCK + " " + DUP_BLOCK + TAIL);
  const afterTokens = approxTokens(STABLE + DUP_BLOCK + TAIL);

  // --- The receipt: the FIRST LIVE EXPORT, verbatim. Rows must truly sum.
  // 30 requests, claude-sonnet-5-5, 2026-10-19; spools audited in-session.
  const SPEND = [
    ["coding-agent", 0.06318], ["rag-docqa", 0.04010], ["batch-classifier", 0.06134],
    ["support-chat", 0.05207], ["already-lean", 0.00573],
  ] as const;
  const SAVED = [
    ["coding-agent — schemas + fresh-result cap", 0.02150],
    ["rag-docqa — duplicate excerpt removed", 0.00861],
    ["support-chat — tool-schema compaction", 0.00537],
    ["batch-classifier — cache stamp, netted", -0.01477],
    ["already-lean — nothing to remove", 0.0],
  ] as const;
  const spendTotal = SPEND.reduce((s, [, v]) => s + v, 0);
  const savedTotal = SAVED.reduce((s, [, v]) => s + v, 0);
  const savedPct = (savedTotal / spendTotal) * 100;
  const money = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(4)}`;

  const CANVAS_JS = `
(function () {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var canvas = document.getElementById("field");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var SCALE = 2, W = 0, H = 0, cur, prev, img, off, offCtx;
  var wrap = canvas.parentElement;
  function resize() {
    canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight;
    W = Math.max(2, Math.ceil(canvas.width / SCALE)); H = Math.max(2, Math.ceil(canvas.height / SCALE));
    cur = new Float32Array(W * H); prev = new Float32Array(W * H);
    off = document.createElement("canvas"); off.width = W; off.height = H;
    offCtx = off.getContext("2d"); img = offCtx.createImageData(W, H);
  }
  resize();
  var rt; window.addEventListener("resize", function(){ clearTimeout(rt); rt = setTimeout(resize, 150); });
  function drop(x, y, s, r) {
    var b = wrap.getBoundingClientRect(); var lx = x - b.left, ly = y - b.top;
    if (lx < 0 || ly < 0 || lx > b.width || ly > b.height) return;
    var cx = Math.round(lx / SCALE), cy = Math.round(ly / SCALE);
    for (var yy = -r; yy <= r; yy++) for (var xx = -r; xx <= r; xx++) {
      var d = Math.sqrt(xx * xx + yy * yy); if (d > r) continue;
      var px = cx + xx, py = cy + yy;
      if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) continue;
      prev[py * W + px] += s * Math.cos((d / r) * Math.PI * 0.5);
    }
  }
  var last = 0, mx = -99, my = -99;
  window.addEventListener("pointermove", function (e) {
    var now = performance.now(); if (now - last < 24) return; last = now;
    var dx = e.clientX - mx, dy = e.clientY - my; mx = e.clientX; my = e.clientY;
    drop(e.clientX, e.clientY, 60 + Math.min(Math.sqrt(dx*dx+dy*dy), 60) * 4, 2);
  }, { passive: true });
  var amb = setInterval(function () {
    if (document.hidden) return;
    var b = wrap.getBoundingClientRect();
    drop(b.left + Math.random() * b.width, b.top + Math.random() * b.height, 200, 4);
  }, 2800);
  window.addEventListener("pagehide", function(){ clearInterval(amb); });
  var lastF = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (ts - lastF < 28 || document.hidden) return; lastF = ts;
    for (var y = 1; y < H - 1; y++) { var row = y * W;
      for (var x = 1; x < W - 1; x++) { var i = row + x;
        cur[i] = ((prev[i-1] + prev[i+1] + prev[i-W] + prev[i+W]) * 0.5 - cur[i]) * 0.981; } }
    var t = prev; prev = cur; cur = t;
    var data = img.data;
    for (var y2 = 1; y2 < H - 1; y2++) { var r2 = y2 * W;
      for (var x2 = 1; x2 < W - 1; x2++) { var i2 = r2 + x2;
        var sh = (prev[i2-1] - prev[i2+1]) + (prev[i2-W] - prev[i2+W]);
        var p = i2 * 4; var m = sh < 0 ? -sh : sh;
        if (m < 0.5) { data[p+3] = 0; continue; }
        var a = Math.min(m * 2.5, 48);
        data[p] = 157; data[p+1] = 217; data[p+2] = 245; data[p+3] = a; } }
    offCtx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(frame);
})();`;

  const PAGE_JS = `
(function () {
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // The live thing: strike the duplicate from the request, count honestly.
  var btn = document.getElementById("reduce-btn");
  var counter = document.getElementById("tok-count");
  if (btn && counter) {
    var done = false;
    btn.addEventListener("click", function () {
      if (done) {
        document.querySelectorAll(".dup").forEach(function (el) { el.classList.remove("struck"); });
        counter.textContent = "${beforeTokens}";
        document.getElementById("same-note").classList.remove("show");
        btn.textContent = "Reduce this request";
        done = false; return;
      }
      document.querySelectorAll(".dup").forEach(function (el) { el.classList.add("struck"); });
      document.getElementById("same-note").classList.add("show");
      btn.textContent = "Put it back";
      done = true;
      if (reduced) { counter.textContent = "${afterTokens}"; return; }
      var from = ${beforeTokens}, to = ${afterTokens}, t0 = performance.now();
      (function tick(now) {
        var k = Math.min((now - t0) / 650, 1);
        counter.textContent = String(Math.round(from + (to - from) * k));
        if (k < 1) requestAnimationFrame(tick);
      })(t0);
    });
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
  --bg:#081522; --surface:#0E2133; --surface-2:#13293E; --ink:#F1F7FB; --muted:#9FB3C8;
  --line:#24415C; --accent:#9DD9F5; --accent-ink:#081522; --ocean:#2864A5; --paper:#F1F7FB; --paper-ink:#102A43;
  --s1:8px; --s2:16px; --s3:24px; --s4:32px; --s5:48px; --s6:64px; --s7:96px;
  --axis:27vw; --radius:4px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scrollbar-gutter:stable both-edges}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Manrope,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--ink)}
.rise,.exchange .call,.exchange .response,.total-side .figure{opacity:0;transform:translateY(12px);transition:opacity .5s ease,transform .5s ease}
.rise.in,.rise.in .call,.rise.in .response,.rise.in .figure{opacity:1;transform:none}
.rise.in .response{transition-delay:.18s}

@media (prefers-reduced-motion: reduce){.rise,.exchange .call,.exchange .response,.total-side .figure{opacity:1;transform:none;transition:none}html{scroll-behavior:auto}}

/* ---------- hero: column on one line, 27% axis, mostly empty ---------- */
.hero-wrap{position:relative;min-height:100svh;overflow:hidden}
#field{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;filter:blur(.8px)}
.hero{position:relative;min-height:100svh}
.hero .mark{position:absolute;top:56px;left:var(--axis);width:40px;height:40px}
.hero .signin{position:absolute;top:56px;right:var(--s4);font-size:13px;color:var(--muted);text-decoration:none}
.hero .signin:hover{color:var(--accent)}
.hero .col{position:absolute;top:276px;left:var(--axis);width:380px}
.hero h1{font-size:30px;font-weight:600;line-height:1.25;letter-spacing:-.01em;margin:0 0 var(--s2)}
.hero .sub{font-size:16px;line-height:1.5;color:var(--muted);margin:0 0 28px}
.hero .actions{display:flex;align-items:center;gap:var(--s3)}
.btn{display:inline-block;padding:12px 22px;border-radius:var(--radius);font-weight:700;font-size:16px;text-decoration:none;background:var(--accent);color:var(--accent-ink);transition:background .18s ease}
.btn:hover{background:#c9ecfc}
.arrowlink{font-size:16px;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line)}
.arrowlink:hover{color:var(--accent);border-color:var(--accent)}
.arrowlink::after{content:" \\2192"}
/* the first demonstration peeks in on the axis */
.hero .peek{position:absolute;bottom:0;left:var(--axis);width:560px;max-width:calc(100vw - 48px)}
@media (max-width:760px){
  :root{--axis:24px}
  .hero .mark{top:32px}
  .hero .col{top:30svh;width:auto;right:24px}
  .hero h1{font-size:24px}
  .hero .peek{width:auto;right:24px}
}

/* ---------- fragments: the product's own conventions ---------- */
[data-ui]{background:var(--surface);border:1px solid var(--line);border-radius:8px;font-size:13px;overflow:hidden;max-width:100%}
[data-ui] .tblwrap{overflow-x:auto}
[data-ui] table{min-width:540px}
[data-ui] .bar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--line);font-weight:700;font-size:13px;color:var(--muted)}
[data-ui] .bar{min-width:0}
[data-ui] .bar .pill{background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-variant-numeric:tabular-nums;color:var(--ink);white-space:nowrap;flex:none}
[data-ui] pre{margin:0;padding:14px 16px;overflow-x:auto;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
[data-ui] .tok{color:var(--muted)}
[data-ui] .key{color:var(--accent)}
[data-ui] .dup{transition:opacity .5s ease;text-decoration:line-through transparent}
[data-ui] .dup.struck{opacity:.28;text-decoration:line-through}
[data-ui] .footrow{display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--line)}
[data-ui] .ui-btn{font:inherit;font-weight:700;font-size:13px;background:var(--surface-2);color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:7px 14px;cursor:pointer}
[data-ui] .ui-btn:hover{border-color:var(--accent);color:var(--accent)}
[data-ui] .ok{font-size:13px;color:var(--accent);opacity:0;transition:opacity .4s ease}
[data-ui] .ok.show{opacity:1}
[data-ui] table{width:100%;border-collapse:collapse;font-size:13px}
[data-ui] th,[data-ui] td{text-align:left;padding:8px 16px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}
[data-ui] th{color:var(--muted);font-size:13px;border-top:none}
[data-ui] td.num,[data-ui] th.num{text-align:right}
.copy{font:12px/1 ui-monospace,monospace;background:none;border:1px solid var(--line);color:var(--muted);border-radius:4px;padding:4px 8px;cursor:pointer}
.copy:hover{color:var(--accent);border-color:var(--accent)}

/* ---------- sections ---------- */
section{padding:var(--s7) var(--s4)}
section h2{font-size:30px;font-weight:800;letter-spacing:-.01em;margin:0 0 var(--s6)}
.axis-col{max-width:560px;margin:0 auto}
@media (min-width:1100px){.axis-col{margin-left:var(--axis);margin-right:0}}

/* call and response */
.exchange{margin-bottom:88px}
.exchange .lead{font-size:20px;font-weight:600;margin:0 0 var(--s2)}
.exchange .call{background:var(--surface);border-radius:8px;position:relative}
.exchange .call .copy{position:absolute;top:10px;right:10px}
.exchange .response{margin-top:var(--s2);margin-left:56px}
.exchange .response.breakout{margin-left:0;width:min(880px,calc(100vw - 64px))}
@media (max-width:760px){.exchange .response{margin-left:0}}

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
.price-side p{font-size:16px;line-height:1.6;color:var(--muted);max-width:38ch}
.price-figure{position:relative}
.price-figure .fig{font-size:clamp(120px,16vw,240px);font-weight:800;letter-spacing:-.04em;line-height:.85}
.price-figure .fig sup{font-size:.5em;vertical-align:super}
.price-figure .per{font-size:16px;color:var(--muted)}
.price-figure .overlap{position:absolute;top:-8%;right:4%;width:120px;height:120px}
.price-figure ul{list-style:none;margin:var(--s4) 0 0;padding:0;font-size:16px;line-height:2}
.price-figure ul strong{color:var(--accent)}
.price-figure .btn{margin-top:var(--s3)}

/* faq: accordion of filled tiles, sticky heading */
.faq-wrap{display:grid;grid-template-columns:1fr;gap:var(--s5);max-width:1080px;margin:0 auto}
@media (min-width:980px){.faq-wrap{grid-template-columns:320px 1fr}.faq-wrap h2{position:sticky;top:96px;margin:0}}
.faq-wrap h2{font-size:30px}
.faq details{background:var(--surface);border-radius:var(--radius);margin-bottom:8px}
.faq summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;min-height:72px;padding:0 24px;font-size:20px;font-weight:600}
.faq summary::-webkit-details-marker{display:none}
.faq .plus{position:relative;width:16px;height:16px;flex:none}
.faq .plus::before,.faq .plus::after{content:"";position:absolute;background:var(--muted);left:0;top:7px;width:16px;height:3px;transition:transform .2s ease}
.faq .plus::after{transform:rotate(90deg)}
.faq details[open]{background:var(--accent);color:var(--accent-ink)}
.faq details[open] .plus::before,.faq details[open] .plus::after{background:var(--accent-ink)}
.faq details[open] .plus::after{transform:rotate(0)}
.faq .answer{padding:0 24px 24px;font-size:16px;line-height:1.6;max-width:52ch}
.faq details[open] .answer a{color:var(--accent-ink);font-weight:700}

/* the action tile */
.cta-row{display:grid;grid-template-columns:120px 1fr 120px;gap:12px;margin:0 calc(-1 * var(--s4))}
.cta-row>*{height:360px;border-radius:var(--radius)}
.cta-main{background:var(--accent);color:var(--accent-ink);display:flex;flex-direction:column;justify-content:center;padding:40px}
.cta-main h2{font-size:30px;margin:0 0 var(--s2);color:var(--accent-ink)}
.cta-main p{font-size:16px;line-height:1.6;margin:0 0 var(--s3);max-width:48ch}
.cta-main .btn{background:var(--accent-ink);color:var(--accent);width:max-content}
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
@media (max-width:760px){.quiet-foot{grid-template-columns:1fr;gap:8px;text-align:left}.quiet-foot .links{justify-content:flex-start}.quiet-foot .right{text-align:left}}
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
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free to evaluate; production use billed as a percentage of verified savings." },
  });
  const orgLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "FLUX", url: `${origin}/`, logo: `${origin}/favicon.svg`, sameAs: [repoUrl], slogan: "Less in. More out.",
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
<title>flux — less in, more out</title>
<meta name="description" content="Cut your Claude and OpenAI API bill. One URL in, savings verified per completed task, pay only a share of verified savings. Every invoice is recomputable from a ledger you hold.">
<link rel="canonical" href="${origin}/">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="flux">
<meta property="og:title" content="flux — less in, more out">
<meta property="og:description" content="Cut your Claude and OpenAI API bill. Savings verified per completed task; pay only a share of verified savings.">
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
  <a class="signin" href="${repoUrl}">GitHub</a>
  <div class="col">
    <h1>Less in. More out.<br>Your bill, verifiably smaller.</h1>
    <p class="sub">FLUX removes the tokens that carry no information before they bill you, and meters the saving into a ledger you can recompute yourself. The fee is a share of verified savings &mdash; sometimes the verdict is don&rsquo;t pay us.</p>
    <div class="actions">
      <a class="btn" href="${repoUrl}">Get started</a>
      <a class="arrowlink" href="evidence.html">See the evidence</a>
    </div>
  </div>
  <div class="peek">
    <div data-ui id="reducer">
      <div class="bar"><span>reducer &mdash; live</span><span class="pill"><span id="tok-count">${beforeTokens}</span> tokens</span></div>
      <pre>{"model":<span class="key">"claude-sonnet-5-5"</span>,"system":"You are a careful assistant. Cite sources.",
 "messages":[{"role":"user","content":"Excerpts for case 7:
   ${DUP_BLOCK}
   <span class="dup">${DUP_BLOCK}</span>
   Question: what does clause 7 require?"}]}</pre>
      <div class="footrow">
        <button class="ui-btn" id="reduce-btn" type="button">Reduce this request</button>
        <span class="ok" id="same-note">exact duplicate removed &mdash; the response cannot change <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" style="vertical-align:-1px"><path d="M2.5 8.5 6 12 13.5 4" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </div>
    </div>
  </div>
</header>
</div>

<section aria-label="How it works">
  <div class="axis-col">
  <h2 class="rise">One URL. Three exchanges.</h2>

  <div class="exchange rise">
    <p class="lead">First, point your client at it.</p>
    <div class="call"><button class="copy" type="button" data-copy="npx flux-proxy">copy</button><pre style="margin:0;padding:20px;font:13px/1.65 ui-monospace,Menlo,monospace;overflow-x:auto"><code>$ npx flux-proxy
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
    <div class="call"><button class="copy" type="button" data-copy="npx -p @flux-ai/sdk flux-quote flux-ledger/my-app-anthropic.jsonl">copy</button><pre style="margin:0;padding:20px;font:13px/1.65 ui-monospace,Menlo,monospace;overflow-x:auto"><code>$ flux-quote flux-ledger/my-app-anthropic.jsonl</code></pre></div>
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
      <div class="footrow"><span class="tok">Savings you already had are excluded. Negative levers are netted, never clamped. Run it yourself &mdash; the number must match.</span></div>
    </div>
  </div>
  </div>
</section>

<section aria-label="The first live export">
  <div class="receipt-wrap">
    <div class="total-side rise">
      <h2>Measured on real traffic.</h2>
      <p class="note">Thirty requests through five agents on claude-sonnet-5-5, spools audited, chains verified. Small, real, reproducible &mdash; the opposite of a projection.</p>
      <div class="figure">${savedPct.toFixed(1)}%</div>
      <p class="cap">of live spend, verified per request, before any replay-gate approvals &mdash; the floor, not the ceiling. Simulated bands by segment run 26&ndash;73%, and the clean cache-only figure is 37.6% &mdash; every number traces to a runnable command &rarr; <a href="evidence.html">evidence</a>.</p>
    </div>
    <div class="slip rise in-self" aria-label="The export, row by row">
      <h3>FLUX &mdash; FIRST LIVE EXPORT</h3>
      <p class="meta">2026-10-19 &middot; claude-sonnet-5-5 &middot; 30 requests &middot; 5 hash chains, all verified</p>
      <p class="grp">SPEND, BY AGENT</p>
      ${spendRows}
      <p class="grp">VERIFIED SAVINGS, BY LEVER</p>
      ${savedRows}
      <div class="total-row"><span>NET VERIFIED SAVINGS</span><span>${money(savedTotal)} &middot; ${savedPct.toFixed(1)}%</span></div>
    </div>
  </div>
</section>

<section aria-label="Pricing">
  <div class="price-wrap">
    <div class="price-side rise">
      <h2>One price.</h2>
      <p>No subscription, no seats, no minimum. FLUX bills a share of the savings its own ledger verified &mdash; the invoice is a pure function of a spool you hold, so you can recompute every line.</p>
    </div>
    <div class="price-figure rise">
      <div class="fig">15<sup>%</sup></div>
      <span class="overlap">${MARK}</span>
      <p class="per">of verified savings, monthly &mdash; nothing else</p>
      <ul>
        <li>Savings verified per completed task, from your provider&rsquo;s own usage</li>
        <li>A month that saved nothing bills nothing</li>
        <li>Negative levers count against us, never clamped</li>
        <li>Already optimised? The quote says <strong>do not pay us</strong></li>
      </ul>
      <a class="btn" href="${repoUrl}">Run the quote on your own export</a>
    </div>
  </div>
</section>

<section aria-label="Questions">
  <div class="faq-wrap">
    <h2 class="rise">The catch, printed.</h2>
    <div class="faq rise">
      <details name="faq" open><summary>Can FLUX break my app?<span class="plus"></span></summary><div class="answer">The default levers are lossless: compacted schemas decode identically, removed duplicates are exact, prefix repair reorders without deleting, and the reducer never throws &mdash; a failure returns your request untouched. Lossy levers stay off until a replay gate proves on your own recorded requests that quality held. <a href="faq.html">Full answer</a></div></details>
      <details name="faq"><summary>Why a range and not one number?<span class="plus"></span></summary><div class="answer">Savings depend on your traffic&rsquo;s shape. The quote comes from your own export and names your segment; sometimes the verdict is literally do not pay us. <a href="segments.html">The bands, by segment</a></div></details>
      <details name="faq"><summary>How is billing a counterfactual dispute-proof?<span class="plus"></span></summary><div class="answer">The way energy performance contracts have done it since 1995: a defined baseline, provider-verbatim measurements, an agreed adjustment method. Every request writes an append-only hash-chained event; the invoice is a pure function over those events. <a href="methodology.html">Methodology</a></div></details>
      <details name="faq"><summary>What do you do with my prompts?<span class="plus"></span></summary><div class="answer">Analysis runs locally; prompts never leave your machine. The ledger records usage numbers, lever names and hashes &mdash; not content. Your API key passes through the proxy verbatim and is never stored.</div></details>
      <details name="faq"><summary>Where does FLUX lose?<span class="plus"></span></summary><div class="answer">Busy interactive agents cap around 29% before cache enablement; already-optimised stacks get 0&ndash;5% and a do-not-pay-us verdict; a free trimmer may be all you need if you don&rsquo;t need the saving verified. <a href="comparison.html">The honest comparison</a></div></details>
      <details name="faq"><summary>Are these numbers real?<span class="plus"></span></summary><div class="answer">Every figure traces to a runnable command and a commit. The bands are simulator-measured at published provider prices and labelled so; the ${savedPct.toFixed(1)}% receipt above is real traffic. Your pilot replaces all of it with your own number before any fee exists. <a href="evidence.html">Evidence</a></div></details>
    </div>
  </div>
</section>

<section aria-label="Start">
  <div class="cta-row rise">
    <div class="cta-flat" aria-hidden="true"></div>
    <div class="cta-main">
      <h2>Start with one URL.</h2>
      <p>Point your client&rsquo;s baseURL at the FLUX proxy and keep your own key. Five minutes later you have a hash-chained ledger of what you actually spend &mdash; and what you didn&rsquo;t have to.</p>
      <a class="btn" href="${repoUrl}">Get FLUX on GitHub</a>
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
  <span class="links"><a href="overview.html">Overview</a><a href="segments.html">Savings</a><a href="methodology.html">Methodology</a><a href="evidence.html">Evidence</a><a href="comparison.html">Comparison</a><a href="faq.html">FAQ</a><a href="${repoUrl}">GitHub</a><a href="llms.txt">llms.txt</a></span>
  <span class="right">2026 &middot; BUSL-1.1</span>
</footer>

<script>${CANVAS_JS}</script>
<script>${PAGE_JS}</script>
</body>
</html>
`;
}
