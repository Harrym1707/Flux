export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>FLUX · Local inference activity</title>
  <style>
    :root { font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; color: #17191e; background: #f7f7f5; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { background: #0a0a0a; color: #fff; padding: 22px max(24px, calc((100vw - 1200px) / 2)); display: flex; align-items: center; justify-content: space-between; }
    .brand { font-weight: 750; letter-spacing: .12em; }
    .local { color: #b5bac4; font-size: 13px; }
    main { max-width: 1200px; padding: 36px 24px 64px; margin: auto; }
    h1 { font-size: clamp(28px, 4vw, 38px); letter-spacing: -.04em; margin: 0; }
    .sub { color: #626875; margin: 6px 0 26px; }
    .cards { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card, .panel { background: #fff; border: 1px solid #e3e5e8; border-radius: 10px; }
    .card { padding: 16px; }
    .label { color: #686f7b; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    .value { font-size: 24px; font-weight: 650; margin-top: 4px; }
    .panel { overflow: hidden; }
    .panelHead { padding: 16px 18px; border-bottom: 1px solid #e8e9ec; display: flex; justify-content: space-between; align-items: center; }
    h2 { margin: 0; font-size: 16px; }
    #updated { color: #747b86; font-size: 12px; }
    .scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 740px; }
    th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #eff0f2; white-space: nowrap; }
    th { color: #747b86; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
    td { font-size: 13px; }
    .status { font-weight: 650; }
    .ok { color: #18794e; }
    .bad { color: #b42318; }
    #empty { display: none; text-align: center; color: #737985; padding: 38px 16px; }
    .note { color: #777e89; font-size: 12px; margin-top: 14px; }
    @media (max-width: 900px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } .cards .card:last-child { grid-column: span 2; } }
  </style>
</head>
<body>
  <header><div class="brand">FLUX</div><div class="local">LOCAL DEVELOPMENT · METADATA ONLY</div></header>
  <main>
    <h1>Inference activity</h1>
    <p class="sub">Recent provider requests observed by the FLUX SDK.</p>
    <section class="cards" aria-label="Request summary">
      <div class="card"><div class="label">Requests</div><div class="value" id="requests">0</div></div>
      <div class="card"><div class="label">Successful</div><div class="value" id="successful">0</div></div>
      <div class="card"><div class="label">Tokens</div><div class="value" id="tokens">0</div></div>
      <div class="card"><div class="label">Known cost · priced requests</div><div class="value" id="cost">—</div></div>
      <div class="card"><div class="label">Mean latency</div><div class="value" id="latency">—</div></div>
    </section>
    <section class="panel">
      <div class="panelHead"><h2>Latest requests</h2><span id="updated">Connecting…</span></div>
      <div class="scroll"><table><thead><tr><th>Time</th><th>Application</th><th>Model</th><th>Route</th><th>Task</th><th>Context profile</th><th>Tokens in/out</th><th>Cache read/write</th><th>Cost</th><th>Latency</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></div>
      <div id="empty">No requests yet. Run <code>corepack pnpm example:mock</code> in another terminal.</div>
    </section>
    <p class="note">This local demo keeps the latest 500 metadata events in memory. Prompts and model outputs are not collected.</p>
  </main>
  <script>
    const text = (id, value) => { document.getElementById(id).textContent = value; };
    const fmtCost = (value) => value == null ? "—" : "$" + value.toFixed(6);
    async function refresh() {
      try {
        const response = await fetch("/v1/telemetry?limit=100", { cache: "no-store" });
        if (!response.ok) throw new Error("Telemetry request failed");
        const events = await response.json();
        const good = events.filter((event) => event.status === "succeeded").length;
        const tokenSum = events.reduce((sum, event) => sum + (event.inputTokens || 0) + (event.outputTokens || 0), 0);
        const costKnown = events.some((event) => typeof event.costUsd === "number");
        const costSum = events.reduce((sum, event) => sum + (event.costUsd || 0), 0);
        const latencyEvents = events.filter((event) => typeof event.latencyMs === "number");
        const latencyMean = latencyEvents.length ? latencyEvents.reduce((sum, event) => sum + event.latencyMs, 0) / latencyEvents.length : null;
        text("requests", String(events.length));
        text("successful", good + " / " + events.length);
        text("tokens", tokenSum.toLocaleString());
        text("cost", costKnown ? fmtCost(costSum) : "—");
        text("latency", latencyMean == null ? "—" : latencyMean.toFixed(0) + " ms");
        const rows = document.getElementById("rows");
        rows.replaceChildren();
        for (const event of events) {
          const row = document.createElement("tr");
          const route = event.cacheHit ? "exact cache" : event.fallbackUsed ? "fallback to baseline" : event.requestedModel && event.requestedModel !== event.model ? "candidate" : "baseline";
          const profile = event.contextProfileId ? event.contextProfileId + (event.contextProfileVersion ? " v" + event.contextProfileVersion : "") : "—";
          const values = [new Date(event.timestamp).toLocaleTimeString(), event.applicationId, event.model, route, event.taskClass || "—", profile, (event.inputTokens ?? "—") + " / " + (event.outputTokens ?? "—"), (event.cachedInputTokens ?? 0) + " / " + (event.cacheWriteInputTokens ?? 0), fmtCost(event.costUsd), typeof event.latencyMs === "number" ? event.latencyMs.toFixed(0) + " ms" : "—", event.status];
          for (let index = 0; index < values.length; index += 1) {
            const cell = document.createElement("td");
            cell.textContent = values[index];
            if (index === values.length - 1) cell.className = "status " + (event.status === "succeeded" ? "ok" : "bad");
            row.append(cell);
          }
          rows.append(row);
        }
        document.getElementById("empty").style.display = events.length ? "none" : "block";
        text("updated", "Updated " + new Date().toLocaleTimeString());
      } catch {
        text("updated", "Waiting for local FLUX API…");
      }
    }
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
