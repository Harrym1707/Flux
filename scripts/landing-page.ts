/**
 * The FLUX landing page — hand-built, zero dependencies.
 *
 * Design synthesis (Evil Martians' study of 100 dev-tool pages; Landingi /
 * daily.dev 2026 practice guides) + the FLUX brand catalogue:
 * - ONE promise in the hero, impossible to miss, one primary CTA.
 * - Show the product, not an illustration: the real one-line install.
 * - Benefits as scannable icon tiles, not paragraphs.
 * - Motion that is purposeful and calm: a water-ripple field that answers
 *   the cursor — the brand's "two streams resolve into one" made literal.
 *   Fully disabled under prefers-reduced-motion; tap-driven on touch.
 * - Numbers near the CTA as social proof — labelled honestly, linking to
 *   the evidence page, because our credibility IS the verification story.
 * - Fast: no libraries, one Google Fonts request, inline SVG icons.
 */

export function renderLanding(origin: string, repoUrl: string): string {
  const CANVAS_JS = `
(function () {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var canvas = document.getElementById("ripples");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var dark = true; // the landing is dark-first: always the additive glow path

  // Height-field energy: two buffers, wave equation, damping. Half resolution
  // + smooth alpha ramps + a blurred upscale keep it fluid, not pixelated.
  // Keep the simulation under ~250k cells so big displays stay smooth.
  var SCALE = 2;
  var W = 0, H = 0, cur, prev, img, off, offCtx;

  var wrap = canvas.parentElement;
  function resize() {
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    W = Math.max(2, Math.ceil(canvas.width / SCALE));
    H = Math.max(2, Math.ceil(canvas.height / SCALE));
    cur = new Float32Array(W * H);
    prev = new Float32Array(W * H);
    off = document.createElement("canvas");
    off.width = W; off.height = H;
    offCtx = off.getContext("2d");
    img = offCtx.createImageData(W, H);
  }
  resize();
  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150);
  });

  function drop(clientX, clientY, strength, radius) {
    var r = wrap.getBoundingClientRect();
    var lx = clientX - r.left, ly = clientY - r.top;
    if (lx < 0 || ly < 0 || lx > r.width || ly > r.height) return;
    var cx = Math.round(lx / SCALE), cy = Math.round(ly / SCALE);
    for (var y = -radius; y <= radius; y++) {
      for (var x = -radius; x <= radius; x++) {
        var d = Math.sqrt(x * x + y * y);
        if (d > radius) continue;
        var px = cx + x, py = cy + y;
        if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) continue;
        prev[py * W + px] += strength * Math.cos((d / radius) * Math.PI * 0.5);
      }
    }
  }

  // --- The cursor stirs the field ------------------------------------------
  var lastMove = 0, mx = -99, my = -99;
  window.addEventListener("pointermove", function (e) {
    var now = performance.now();
    if (now - lastMove < 24) return;
    lastMove = now;
    var dx = e.clientX - mx, dy = e.clientY - my;
    mx = e.clientX; my = e.clientY;
    var speed = Math.min(Math.sqrt(dx * dx + dy * dy), 60);
    drop(e.clientX, e.clientY, 60 + speed * 4, 2);
  }, { passive: true });

  // --- Clicks strike: a surge plus a lightning bolt -------------------------
  var bolts = [];
  function makeBolt(x, y) {
    var angle = Math.random() * Math.PI * 2;
    var points = [[x, y]];
    var px = x, py = y;
    for (var i = 0; i < 9; i++) {
      angle += (Math.random() - 0.5) * 1.1;
      px += Math.cos(angle) * (18 + Math.random() * 16);
      py += Math.sin(angle) * (18 + Math.random() * 16);
      points.push([px, py]);
    }
    bolts.push({ points: points, born: performance.now() });
  }
  window.addEventListener("pointerdown", function (e) {
    var r = wrap.getBoundingClientRect();
    if (e.clientY - r.top > r.height) return;
    drop(e.clientX, e.clientY, 600, 5);
    makeBolt(e.clientX - r.left, e.clientY - r.top);
  }, { passive: true });

  // --- Call-outs radiate from their own centre ------------------------------
  // Hovering a CTA, tile or stat pulses energy outward from the BOX, not the
  // cursor: the element becomes the source.
  function centerOf(el) {
    var r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }
  Array.prototype.forEach.call(document.querySelectorAll(".hero .btn, .hero .term"), function (el) {
    var pulse = null;
    el.addEventListener("pointerenter", function () {
      if (pulse) clearInterval(pulse); // a re-enter must never stack intervals
      var c = centerOf(el);
      drop(c[0], c[1], 520, 5);
      pulse = setInterval(function () {
        var c2 = centerOf(el);
        drop(c2[0], c2[1], 240, 4);
      }, 900);
    });
    el.addEventListener("pointerleave", function () {
      if (pulse) { clearInterval(pulse); pulse = null; }
    });
  });

  var ambient = setInterval(function () {
    if (document.hidden) return;
    var rr = wrap.getBoundingClientRect();
    drop(rr.left + Math.random() * rr.width, rr.top + Math.random() * rr.height, 200, 4);
  }, 2800);
  window.addEventListener("pagehide", function () { clearInterval(ambient); });
  (function(){ var rr = wrap.getBoundingClientRect(); drop(rr.left + rr.width * 0.18, rr.top + rr.height * 0.25, 600, 6); })();

  // --- Dramatic brand rendering ---------------------------------------------
  // Light mode paints with the DARK inks (Open Ocean waves, Midnight filaments,
  // Sky Signal troughs); dark mode glows additively in Sky Signal and white.
  var waveC = [157, 217, 245];
  var filC = [255, 255, 255];
  var troughC = [40, 100, 165];
  var boltC = "rgba(157,217,245,";

  var lastFrame = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (ts - lastFrame < 28 || document.hidden) return;
    lastFrame = ts;

    for (var y = 1; y < H - 1; y++) {
      var row = y * W;
      for (var x = 1; x < W - 1; x++) {
        var i = row + x;
        cur[i] = ((prev[i - 1] + prev[i + 1] + prev[i - W] + prev[i + W]) * 0.5 - cur[i]) * 0.981;
      }
    }
    var tmp = prev; prev = cur; cur = tmp;

    // Smooth ramps, no hard threshold: alpha grows continuously with slope,
    // and steep interference lines ignite as bright filaments.
    var data = img.data;
    for (var y2 = 1; y2 < H - 1; y2++) {
      var row2 = y2 * W;
      for (var x2 = 1; x2 < W - 1; x2++) {
        var i2 = row2 + x2;
        var shade = (prev[i2 - 1] - prev[i2 + 1]) + (prev[i2 - W] - prev[i2 + W]);
        var p = i2 * 4;
        var mag = shade < 0 ? -shade : shade;
        if (mag < 0.5) { data[p + 3] = 0; continue; }
        if (mag > 22) {
          // Filament: the electric core where waves collide — a whisper now.
          var fa = Math.min((mag - 22) * 2.2, 80);
          data[p] = filC[0]; data[p + 1] = filC[1]; data[p + 2] = filC[2]; data[p + 3] = fa;
        } else if (shade > 0) {
          var a = Math.min(shade * 3, 64);
          data[p] = waveC[0]; data[p + 1] = waveC[1]; data[p + 2] = waveC[2]; data[p + 3] = a;
        } else {
          var a2 = Math.min(mag * 2, 44);
          data[p] = troughC[0]; data[p + 1] = troughC[1]; data[p + 2] = troughC[2]; data[p + 3] = a2;
        }
      }
    }
    offCtx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    // Lightning bolts flicker for a quarter second, re-jittered every frame.
    var now = performance.now();
    for (var b = bolts.length - 1; b >= 0; b--) {
      var bolt = bolts[b];
      var age = (now - bolt.born) / 260;
      if (age >= 1) { bolts.splice(b, 1); continue; }
      var alpha = (1 - age) * 0.4;
      ctx.beginPath();
      ctx.moveTo(bolt.points[0][0], bolt.points[0][1]);
      for (var k = 1; k < bolt.points.length; k++) {
        ctx.lineTo(bolt.points[k][0] + (Math.random() - 0.5) * 6, bolt.points[k][1] + (Math.random() - 0.5) * 6);
      }
      ctx.strokeStyle = boltC + alpha + ")";
      ctx.lineWidth = 2;
      ctx.shadowColor = boltC + "0.8)";
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.globalCompositeOperation = "source-over";
  }
  requestAnimationFrame(frame);
})();
`;

  const CSS = `
:root{
  /* Dark-first: Midnight Tide is the ground; Sky Signal is the energy. */
  --bg:#081522; --surface:#102A43; --fg:#F1F7FB; --muted:#9fb3c8;
  --line:#24415c; --brand:#9DD9F5; --brand-deep:#c9ecfc; --signal:#9DD9F5; --signal-soft:#16314a; --code:#060f19;
  --s1:8px; --s2:16px; --s3:24px; --s4:32px; --s5:48px; --s6:64px; --s7:96px; --s8:128px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 Manrope,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.hero-wrap{position:relative;overflow:hidden}
#ripples{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;filter:blur(0.8px);-webkit-mask-image:radial-gradient(ellipse 85% 62% at 50% 46%, transparent 44%, black 78%);mask-image:radial-gradient(ellipse 85% 62% at 50% 46%, transparent 44%, black 78%)}
.shell{position:relative;z-index:1}
nav{display:flex;flex-wrap:wrap;gap:var(--s3);align-items:baseline;padding:var(--s3) var(--s4);font-size:.95rem;max-width:72rem;margin:0 auto}
nav a{color:var(--muted);text-decoration:none;font-weight:600;padding:var(--s1) 0;border-bottom:2px solid transparent;transition:color .15s ease,border-color .15s ease}
nav a:hover{color:var(--brand);border-bottom-color:var(--signal)}
nav .brand{font-weight:800;font-size:1.4rem;color:var(--brand);letter-spacing:-.02em;border-bottom:none}
nav .spacer{flex:1}
.hero{position:relative;z-index:1;min-height:88vh;display:flex;flex-direction:column;justify-content:center;align-items:center;max-width:56rem;margin:0 auto;padding:var(--s7) var(--s3);text-align:center}
.kicker{font-size:.82rem;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:var(--signal);margin:0 0 var(--s4)}
.hero h1{margin:0 0 var(--s3);line-height:1}
.hero h1 .in{display:block;font-size:clamp(1.4rem,3.2vw,2rem);font-weight:600;letter-spacing:.02em;color:var(--muted);opacity:.75;margin-bottom:var(--s1)}
.hero h1 .out{display:block;font-size:clamp(4rem,11vw,7.5rem);font-weight:800;letter-spacing:-.045em;background:linear-gradient(135deg,#FFFFFF 20%,#9DD9F5 80%);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:none}
.accent{font-family:Fraunces,Georgia,serif;font-style:italic;font-weight:500;font-size:1.3rem;color:#c9d9e8;margin:0 0 var(--s3)}
.hero p.sub{font-size:1.1rem;line-height:1.6;color:var(--muted);max-width:30rem;margin:0 0 var(--s5)}
.cta{display:flex;gap:var(--s2);justify-content:center;flex-wrap:wrap;margin:0 0 var(--s6)}
.btn{display:inline-block;padding:var(--s2) var(--s4);border-radius:10px;font-weight:700;text-decoration:none;transition:background .18s ease,color .18s ease,border-color .18s ease,transform .15s ease,box-shadow .15s ease}
.btn:hover{transform:translateY(-2px)}
.btn.primary{background:var(--signal);color:#081522;box-shadow:0 0 28px rgba(157,217,245,.35)}
.btn.primary:hover{background:var(--brand-deep);box-shadow:0 0 44px rgba(157,217,245,.55)}
.btn.ghost{color:var(--brand);border:1.5px solid var(--line);background:rgba(16,42,67,.6)}
.btn.ghost:hover{background:var(--signal-soft);border-color:var(--brand)}
.term{width:min(30rem,100%);margin:0 auto;background:var(--code);color:#9DD9F5;border:1px solid var(--line);border-radius:12px;padding:var(--s3) var(--s4);text-align:left;font:0.95rem/1.8 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 0 36px rgba(157,217,245,.12)}
.term .c{color:#5f7d9c}
.term .w{color:#F1F7FB}
section{padding:var(--s7) var(--s3)}
section > .inner{max-width:64rem;margin:0 auto}
section h2{text-align:center;font-size:1rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);font-weight:700;margin:0 0 var(--s5)}
/* The colour journey: deep focus to bright signal, section by section. */
.band-lift{background:linear-gradient(180deg,#081522 0%,#0B1D2E 18%,#0B1D2E 100%)}
.band-light{background:linear-gradient(180deg,#EAF4FB 0%,#F1F7FB 30%,#F1F7FB 100%);color:#102A43}
.band-light h2{color:#2864A5}
.band-light .muted,.band-light p{color:#486581}
.band-ocean{background:linear-gradient(180deg,#0E2133 0%,#123150 60%,#0E2133 100%)}
.band-deep{background:#081522}
/* --- The savings flow infographic (Cloud White band) --- */
.flow-wrap{overflow-x:auto}
.flow{display:block;width:100%;max-width:58rem;min-width:40rem;margin:0 auto}
.flow text{font-family:Manrope,sans-serif}
.flow .lbl{font-size:12px;font-weight:700;fill:#486581}
.flow .big{font-size:14px;font-weight:800;fill:#102A43}
.flow .money{font-size:16px;font-weight:800}
.flow-caption{text-align:center;font-size:.88rem;color:#486581;max-width:40rem;margin:var(--s3) auto 0}
.flow-caption a{color:#2864A5}
@media (prefers-reduced-motion: reduce){.flow .ani{display:none}.flow .static-note{display:block}}
.flow .static-note{display:none}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:var(--s3)}
.tile{background:#0E2133;border:1.5px solid var(--line);border-radius:16px;padding:var(--s4) var(--s3);text-align:center;transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.tile:hover{transform:translateY(-4px);border-color:var(--signal);box-shadow:0 0 32px rgba(157,217,245,.22)}
.tile svg{width:56px;height:56px;margin:0 0 var(--s2)}
.tile h3{margin:0 0 var(--s1);font-size:1.1rem;font-weight:800}
.tile p{margin:0;color:var(--muted);font-size:.95rem;line-height:1.5}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:var(--s3);text-align:center}
.stat{background:#0E2133;border:1.5px solid var(--line);border-radius:16px;padding:var(--s4) var(--s2);transition:border-color .18s ease,box-shadow .18s ease}
.stat:hover{border-color:var(--signal);box-shadow:0 0 32px rgba(157,217,245,.22)}
.stat .n{font-size:2.5rem;font-weight:800;letter-spacing:-.02em;color:var(--signal);line-height:1}
.stat .l{color:var(--muted);font-size:.9rem;line-height:1.5;margin-top:var(--s2)}
.fineprint{text-align:center;color:var(--muted);font-size:.88rem;margin:var(--s4) auto 0;max-width:40rem}
.fineprint a{color:var(--brand)}
.honest{max-width:40rem;margin:0 auto;text-align:center;background:rgba(22,49,74,.8);border:1.5px solid var(--line);border-radius:16px;padding:var(--s4)}
.honest strong{color:var(--brand)}
footer{border-top:2px solid var(--signal);margin:var(--s7) auto 0;max-width:64rem;padding:var(--s4) var(--s3) var(--s7);font-size:.9rem;line-height:2;color:var(--muted)}
footer a{color:var(--brand)}
@media (prefers-reduced-motion: reduce){.btn,.tile,.stat,nav a{transition:none}.btn:hover,.tile:hover{transform:none}html{scroll-behavior:auto}}
@media (max-width:640px){.hero{min-height:72vh;padding:var(--s6) var(--s3)}section{padding:var(--s6) var(--s3)}}
`.trim();

  // Inline SVG icons, brand palette, stroke-led, decorative (aria-hidden; the
  // tile headings carry the meaning for screen readers and crawlers).
  const ICON_PLUG = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M6 24h10" stroke="#2864A5" stroke-width="3" stroke-linecap="round"/><path d="M32 24h10" stroke="#9DD9F5" stroke-width="3" stroke-linecap="round"/><rect x="16" y="14" width="16" height="20" rx="5" stroke="#2864A5" stroke-width="3"/><path d="M22 20v8M26 20v8" stroke="#9DD9F5" stroke-width="3" stroke-linecap="round"/></svg>`;
  const ICON_WAVES = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M6 18c6-6 12-6 18 0s12 6 18 0" stroke="#2864A5" stroke-width="3" stroke-linecap="round"/><path d="M6 30c6-6 12-6 18 0s12 6 18 0" stroke="#9DD9F5" stroke-width="3" stroke-linecap="round"/></svg>`;
  const ICON_LEDGER = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="10" y="6" width="28" height="36" rx="4" stroke="#2864A5" stroke-width="3"/><path d="M17 15h14M17 22h14M17 29h8" stroke="#9DD9F5" stroke-width="3" stroke-linecap="round"/><path d="M28 31l3 3 6-6" stroke="#2864A5" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const ICON_PERCENT = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="5" stroke="#2864A5" stroke-width="3"/><circle cx="32" cy="32" r="5" stroke="#2864A5" stroke-width="3"/><path d="M36 12 12 36" stroke="#9DD9F5" stroke-width="3" stroke-linecap="round"/></svg>`;
  const ICON_SHIELD = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M24 5l15 6v11c0 9.5-6.3 17-15 21C15.3 39 9 31.5 9 22V11l15-6z" stroke="#2864A5" stroke-width="3" stroke-linejoin="round"/><path d="M17 23l5 5 9-10" stroke="#9DD9F5" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const ICON_STREAMS = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M8 14c10 0 10 10 20 10h12" stroke="#2864A5" stroke-width="3" stroke-linecap="round"/><path d="M8 34c10 0 10-10 20-10" stroke="#2864A5" stroke-width="3" stroke-linecap="round"/><circle cx="41" cy="24" r="3.5" fill="#9DD9F5"/></svg>`;

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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>flux — less in, more out</title>
<meta name="description" content="Cut your Claude and OpenAI API bill. One URL in, savings verified per completed task, pay only a share of verified savings. Every invoice is recomputable from a ledger you hold.">
<link rel="canonical" href="${origin}/">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&family=Fraunces:ital,wght@1,500&display=swap" rel="stylesheet">
<meta property="og:type" content="website">
<meta property="og:site_name" content="flux">
<meta property="og:title" content="flux — less in, more out">
<meta property="og:description" content="Cut your Claude and OpenAI API bill. One URL in, savings verified per completed task, pay only a share of verified savings.">
<meta property="og:url" content="${origin}/">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${jsonLd}</script>
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "FLUX",
    url: `${origin}/`,
    logo: `${origin}/favicon.svg`,
    sameAs: [repoUrl],
    slogan: "Less in. More out.",
  })}</script>
<style>${CSS}</style>
</head>
<body>
<div class="shell">
<nav>
  <a class="brand" href="index.html">flux</a>
  <span class="spacer"></span>
  <a href="overview.html">Overview</a>
  <a href="segments.html">Savings</a>
  <a href="evidence.html">Evidence</a>
  <a href="faq.html">FAQ</a>
  <a href="${repoUrl}">GitHub</a>
</nav>

<div class="hero-wrap">
<canvas id="ripples" aria-hidden="true"></canvas>
<header class="hero">
  <p class="kicker">Verified LLM cost reduction</p>
  <h1><span class="in">Less in.</span><span class="out">More out.</span></h1>
  <p class="accent">Signal, clarified.</p>
  <p class="sub">Cut your Claude and OpenAI API bill. Pay only a share of savings you can verify yourself.</p>
  <div class="cta">
    <a class="btn primary" href="${repoUrl}">Get started on GitHub</a>
    <a class="btn ghost" href="evidence.html">See the evidence</a>
  </div>
  <div class="term" role="img" aria-label="Terminal: npx flux-proxy, then point your client's base URL at it">
    <div><span class="c">$</span> <span class="w">npx flux-proxy</span></div>
    <div><span class="c"># then change one line — keep your own key</span></div>
    <div>baseURL<span class="c">:</span> <span class="w">"http://127.0.0.1:8787"</span></div>
  </div>
</header>
</div>

<section class="band-lift" aria-label="What FLUX does">
  <div class="inner">
  <h2>What it does</h2>
  <div class="tiles">
    <div class="tile">${ICON_PLUG}<h3>One URL in</h3><p>No SDK adoption. Any language. Your key passes through — never stored.</p></div>
    <div class="tile">${ICON_STREAMS}<h3>Signal kept</h3><p>Duplicates, schema bloat and stale context removed before the model bills you.</p></div>
    <div class="tile">${ICON_WAVES}<h3>Cache switched on</h3><p>Claude's cache is opt-in; most agents never opt in. FLUX stamps the stable prefix.</p></div>
  </div>
  </div>
</section>

<section class="band-light" aria-label="How FLUX saves money">
  <div class="inner">
  <h2>Same response. Smaller bill.</h2>
  <div class="flow-wrap">
  <svg class="flow" viewBox="0 0 960 330" role="img" aria-label="Tokens flow into the flux funnel; waste is removed before billing; the model returns the same response; the bill shrinks from $1.00 to $0.62">
    <!-- lane labels -->
    <text class="lbl" x="40" y="86">YOUR REQUEST</text>
    <text class="lbl" x="440" y="60" text-anchor="middle">FLUX</text>
    <text class="lbl" x="700" y="86" text-anchor="middle">MODEL</text>
    <text class="lbl" x="860" y="86" text-anchor="middle">RESPONSE</text>

    <!-- the funnel: the brand's two streams resolving into one -->
    <path d="M 330 110 C 400 110 420 150 480 155" fill="none" stroke="#2864A5" stroke-width="5" stroke-linecap="round"/>
    <path d="M 330 200 C 400 200 420 160 480 155" fill="none" stroke="#2864A5" stroke-width="5" stroke-linecap="round"/>
    <path d="M 480 155 H 560" fill="none" stroke="#2864A5" stroke-width="5" stroke-linecap="round"/>
    <circle cx="566" cy="155" r="7" fill="#9DD9F5" stroke="#2864A5" stroke-width="2"/>

    <!-- removed-waste bin -->
    <path d="M 420 238 h 120 a6 6 0 0 1 6 6 v 40 a6 6 0 0 1 -6 6 h -120 a6 6 0 0 1 -6 -6 v -40 a6 6 0 0 1 6 -6 z" fill="#E4F4FD" stroke="#9DD9F5" stroke-width="2"/>
    <text class="lbl" x="480" y="262" text-anchor="middle">removed before</text>
    <text class="lbl" x="480" y="278" text-anchor="middle">it bills you</text>

    <!-- model chip -->
    <rect x="660" y="120" width="80" height="70" rx="12" fill="#102A43"/>
    <circle cx="700" cy="145" r="10" fill="none" stroke="#9DD9F5" stroke-width="3"/>
    <path d="M 685 172 h 30" stroke="#9DD9F5" stroke-width="3" stroke-linecap="round"/>

    <!-- response card: the SAME response either way -->
    <rect x="805" y="104" width="120" height="74" rx="12" fill="#ffffff" stroke="#d9e6f0" stroke-width="2"/>
    <path d="M 822 128 h 86 M 822 142 h 66 M 822 156 h 76" stroke="#9fb3c8" stroke-width="4" stroke-linecap="round"/>
    <path d="M 896 148 l 7 8 l 14 -16" fill="none" stroke="#2864A5" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <text class="big" x="865" y="200" text-anchor="middle">Same response</text>

    <!-- the bill shrinking -->
    <text class="lbl" x="660" y="232">THE BILL</text>
    <rect x="660" y="242" width="180" height="14" rx="7" fill="#d9e6f0"/>
    <rect x="660" y="242" width="180" height="14" rx="7" fill="#2864A5">
      <animate class="ani" attributeName="width" values="180;180;112;112" keyTimes="0;0.2;0.6;1" dur="4s" repeatCount="indefinite"/>
    </rect>
    <text class="money" x="660" y="286" fill="#486581" style="text-decoration:line-through">$1.00</text>
    <text class="money" x="740" y="286" fill="#2864A5">$0.62</text>

    <!-- animated tokens: the kept stream -->
    <g class="ani">
      <circle r="6" fill="#2864A5"><animateMotion dur="3.2s" begin="0s" repeatCount="indefinite" path="M 40 110 C 200 110 280 112 330 118 C 420 128 430 150 560 155 L 650 155"/></circle>
      <circle r="6" fill="#2864A5"><animateMotion dur="3.2s" begin="0.8s" repeatCount="indefinite" path="M 40 150 C 200 150 300 152 480 155 L 650 155"/></circle>
      <circle r="6" fill="#2864A5"><animateMotion dur="3.2s" begin="1.6s" repeatCount="indefinite" path="M 40 195 C 200 195 300 190 420 172 C 480 162 520 156 650 155"/></circle>
      <circle r="6" fill="#2864A5"><animateMotion dur="3.2s" begin="2.4s" repeatCount="indefinite" path="M 40 132 C 200 132 300 136 480 153 L 650 155"/></circle>
      <!-- the waste: diverted into the bin and gone -->
      <circle r="6" fill="#9fb3c8"><animateMotion dur="3.2s" begin="0.4s" repeatCount="indefinite" path="M 40 170 C 200 170 330 180 420 210 C 450 222 465 234 470 252"/><animate attributeName="opacity" values="1;1;0" keyTimes="0;0.8;1" dur="3.2s" begin="0.4s" repeatCount="indefinite"/></circle>
      <circle r="6" fill="#9fb3c8"><animateMotion dur="3.2s" begin="1.2s" repeatCount="indefinite" path="M 40 215 C 200 215 330 210 430 226 C 460 232 480 242 488 254"/><animate attributeName="opacity" values="1;1;0" keyTimes="0;0.8;1" dur="3.2s" begin="1.2s" repeatCount="indefinite"/></circle>
      <circle r="6" fill="#9fb3c8"><animateMotion dur="3.2s" begin="2s" repeatCount="indefinite" path="M 40 95 C 200 95 320 120 410 190 C 440 214 455 232 462 250"/><animate attributeName="opacity" values="1;1;0" keyTimes="0;0.8;1" dur="3.2s" begin="2s" repeatCount="indefinite"/></circle>
      <!-- the response pulse: same answer, every loop -->
      <circle r="6" fill="#9DD9F5" stroke="#2864A5" stroke-width="2"><animateMotion dur="3.2s" begin="0s" repeatCount="indefinite" path="M 745 155 L 800 150"/></circle>
    </g>
    <text class="static-note lbl" x="480" y="40" text-anchor="middle">Tokens that carry no information are removed before they bill; the response is unchanged.</text>

    <!-- token labels under the inflow -->
    <text class="lbl" x="40" y="236">schema bloat &#183; duplicates &#183; stale history &#8594; removed</text>
  </svg>
  </div>
  <p class="flow-caption">An illustration of the mechanism, not a measurement — the measured bands are
  26&ndash;73% by traffic segment, every one traced to a runnable command &rarr; <a href="evidence.html">evidence</a>.</p>
  </div>
</section>

<section class="band-ocean" aria-label="How you pay">
  <div class="inner">
  <h2>How you pay</h2>
  <div class="tiles">
    <div class="tile">${ICON_LEDGER}<h3>Verified per task</h3><p>Every request writes a hash-chained ledger event from the provider's own usage.</p></div>
    <div class="tile">${ICON_PERCENT}<h3>A share of savings</h3><p>Recompute the invoice from your own spool — you must get our number.</p></div>
    <div class="tile">${ICON_SHIELD}<h3>Or nothing</h3><p>Already optimised? The verdict is <strong>do not pay us</strong> — printed on the quote.</p></div>
  </div>
  </div>
</section>

<section class="band-deep" aria-label="Measured savings">
  <div class="inner">
  <h2>Measured, not promised</h2>
  <div class="stats">
    <div class="stat"><div class="n">37.6%</div><div class="l">Claude cache switched on &mdash; same answers, quality unchanged</div></div>
    <div class="stat"><div class="n">57.7%</div><div class="l">batch &amp; latency-tolerant work, net</div></div>
    <div class="stat"><div class="n">45&ndash;73%</div><div class="l">one-shot templated traffic</div></div>
    <div class="stat"><div class="n">0&ndash;5%</div><div class="l">already-optimised: do not pay us</div></div>
  </div>
  <p class="fineprint">Simulator-measured at published provider prices, quality gated per completed task.
  Every number traces to a command and a commit &rarr; <a href="evidence.html">evidence</a></p>
  </div>
</section>

<section class="band-deep" aria-label="The honest line">
  <div class="inner">
  <div class="honest">
    <strong>The catch, printed up front:</strong> savings depend on your traffic's shape.
    The first thing FLUX does is tell you which number is yours — from your own logs,
    in five minutes, before any contract exists.
  </div>
  </div>
</section>

<footer>
  <strong>flux</strong> — spend tokens where they matter.
  <a href="overview.html">Overview</a> · <a href="segments.html">Savings by segment</a> ·
  <a href="methodology.html">Methodology</a> · <a href="evidence.html">Evidence</a> ·
  <a href="comparison.html">Honest comparison</a> · <a href="faq.html">FAQ</a> ·
  <a href="${repoUrl}">Source</a> · <a href="llms.txt">llms.txt</a>
</footer>
</div>
<script>${CANVAS_JS}</script>
</body>
</html>
`;
}
