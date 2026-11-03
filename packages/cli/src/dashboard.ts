/**
 * `flux dashboard` — a live, local web view of what FLUX is doing for you.
 *
 * Serves a self-contained page on 127.0.0.1 that polls a tiny JSON endpoint
 * every few seconds and shows your verified savings, the per-lever breakdown,
 * and what Theo is doing right now (which levers he's applying, and what he's
 * holding behind the replay-gate). It reads your own ledger at ~/.flux/ledger
 * and your Theo policy — nothing leaves the machine, and the numbers match
 * `flux verify` exactly because they are recomputed from the same ledger.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { platform } from "node:os";
import { join } from "node:path";
import { recomputeInvoice } from "../../core/src/savings-ledger.js";
import { defaultPolicy, withheldLevers, type TheoPolicy } from "../../sdk-js/src/theo-policy.js";
import { BUILD_COMMIT, DEFAULT_PORT, FLUX_HOME, readLedger } from "./start.js";

type DashArgs = { port: number; proxyPort: number; ledgerDir: string; open: boolean };

function parseArgs(argv: string[]): DashArgs {
  const args: DashArgs = { port: 8799, proxyPort: DEFAULT_PORT, ledgerDir: join(FLUX_HOME, "ledger"), open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (key === "--help" || key === "-h") {
      console.log(
        `Usage: flux dashboard [options]\n\n` +
          `  --port <n>        Port for the dashboard (default 8799).\n` +
          `  --proxy-port <n>  Proxy port to show as up/down (default ${DEFAULT_PORT}).\n` +
          `  --ledger <dir>    Ledger to read (default ~/.flux/ledger).\n` +
          `  --no-open         Don't open a browser; just print the URL.\n` +
          `  --help            Show this message.`,
      );
      process.exit(0);
    }
    if (key === "--no-open") { args.open = false; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value.`);
    i += 1;
    if (key === "--port") args.port = Number.parseInt(value, 10);
    else if (key === "--proxy-port") args.proxyPort = Number.parseInt(value, 10);
    else if (key === "--ledger") args.ledgerDir = value;
    else throw new Error(`Unknown option: ${key}. See flux dashboard --help.`);
  }
  return args;
}

function readPolicy(): TheoPolicy {
  const path = join(FLUX_HOME, "theo-policy.json");
  if (!existsSync(path)) return defaultPolicy("local", new Date().toISOString());
  try { return JSON.parse(readFileSync(path, "utf8")) as TheoPolicy; }
  catch { return defaultPolicy("local", new Date().toISOString()); }
}

function proxyUp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
    sock.setTimeout(400, () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(false));
  });
}

async function buildData(args: DashArgs): Promise<unknown> {
  const { records, chainOk, brokenAt } = readLedger(args.ledgerDir);
  const invoice = records.length ? recomputeInvoice(records.map((r) => r.event)) : null;
  const policy = readPolicy();
  const active = (policy.levers ?? []).map((l) => ({ lever: l.lever, class: l.class }));
  return {
    build: BUILD_COMMIT,
    updatedAt: new Date().toISOString(),
    chainOk,
    brokenAt: brokenAt ?? null,
    proxyUp: await proxyUp(args.proxyPort),
    savings: invoice
      ? {
          netUsd: invoice.netVerifiedSavingsUsd,
          verdict: invoice.verdict,
          eventsConsidered: invoice.eventsConsidered,
          eventsBilled: invoice.eventsBilled,
          unpricedEvents: invoice.unpricedEvents,
        }
      : { netUsd: 0, verdict: "do_not_charge", eventsConsidered: 0, eventsBilled: 0, unpricedEvents: 0 },
    lineItems: invoice?.lineItems ?? [],
    recordedUnbilled: invoice?.recordedUnbilled ?? [],
    theo: {
      qualityCeilingPercent: policy.qualityCeilingPercent,
      active,
      withheld: withheldLevers(policy),
    },
  };
}

export async function runDashboard(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/data") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(await buildData(args)));
        return;
      }
      if (req.url === "/" || req.url === "") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE);
        return;
      }
      res.writeHead(404); res.end("not found");
    } catch (error) {
      res.writeHead(500); res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(args.port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\n  FLUX dashboard  ·  ${url}`);
  console.log(`  Live view of your verified savings and what Theo is doing. Ctrl+C to stop.\n`);
  if (args.open) openBrowser(url);
  const shutdown = (): void => { server.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {});
}

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  try { spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform() === "win32" }).unref(); }
  catch { /* headless or no browser — the URL is printed */ }
}

// Self-contained page: inline styles + a poller. No external requests.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLUX — live</title>
<style>
  :root{color-scheme:light dark;--bg:#0b0f14;--panel:#121820;--line:#1f2a36;--ink:#eaf0f6;--muted:#8aa0b4;--accent:#2f6fde;--good:#2fcf8f;--warn:#e0a63a}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:28px}
  .wrap{max-width:900px;margin:0 auto}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:20px}
  h1{font-size:20px;margin:0;letter-spacing:-.01em} .sub{color:var(--muted);font-size:13px}
  .hero{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:16px}
  .saved{font-size:clamp(40px,8vw,64px);font-weight:800;letter-spacing:-.03em;line-height:1}
  .verdict{display:inline-block;margin-top:10px;font-size:13px;font-weight:700;padding:4px 12px;border-radius:999px}
  .verdict.charge{background:rgba(47,207,143,.15);color:var(--good)} .verdict.do_not_charge{background:rgba(138,160,180,.15);color:var(--muted)}
  .grid{display:grid;grid-template-columns:1fr;gap:16px} @media(min-width:700px){.grid{grid-template-columns:1fr 1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
  .panel h2{font-size:14px;margin:0 0 12px;color:var(--muted);font-weight:700;letter-spacing:.02em;text-transform:uppercase}
  .chip{display:inline-block;font-size:13px;padding:5px 11px;border-radius:999px;margin:0 6px 6px 0;background:#18222e;border:1px solid var(--line)}
  .chip.on{border-color:var(--good);color:var(--good)} .chip.held{border-color:var(--warn);color:var(--warn)}
  table{width:100%;border-collapse:collapse;font-size:14px} th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-weight:600} td.num{text-align:right;font-variant-numeric:tabular-nums}
  .muted{color:var(--muted)} .foot{margin-top:16px;font-size:12px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px}
  .dot.ok{background:var(--good)} .dot.bad{background:#e05a5a}
  .theo{font-weight:800} .empty{color:var(--muted);font-size:14px}
</style></head><body><div class="wrap">
  <header><h1>FLUX <span class="sub">— live</span></h1><span class="sub" id="build"></span></header>
  <div class="hero">
    <div class="sub">Verified savings on your own traffic</div>
    <div class="saved" id="saved">$0.0000</div>
    <span class="verdict do_not_charge" id="verdict">—</span>
    <span class="sub" id="events" style="margin-left:12px"></span>
  </div>
  <div class="grid">
    <div class="panel">
      <h2><span class="theo">⬢ Theo</span> — what he's doing</h2>
      <div class="sub" style="margin-bottom:6px">Applying now</div>
      <div id="active"><span class="empty">—</span></div>
      <div class="sub" style="margin:12px 0 6px">Held behind the replay-gate</div>
      <div id="withheld"><span class="empty">nothing held</span></div>
      <div class="sub" id="ceiling" style="margin-top:12px"></div>
    </div>
    <div class="panel">
      <h2>Savings by lever</h2>
      <table><thead><tr><th>lever</th><th>kind</th><th class="num">events</th><th class="num">saved</th></tr></thead>
      <tbody id="levers"><tr><td colspan="4" class="empty">No billable savings yet.</td></tr></tbody></table>
      <div class="sub" style="margin-top:10px" id="unbilled"></div>
    </div>
  </div>
  <div class="foot">
    <span id="proxy"><span class="dot bad"></span>proxy</span>
    <span id="chain"><span class="dot ok"></span>ledger</span>
    <span id="updated"></span>
  </div>
</div>
<script>
const $=(id)=>document.getElementById(id);
const usd=(n)=>'$'+Number(n||0).toFixed(4);
async function tick(){
  try{
    const d=await (await fetch('/data',{cache:'no-store'})).json();
    $('build').textContent='build '+d.build;
    $('saved').textContent=usd(d.savings.netUsd);
    const v=$('verdict'); v.textContent=d.savings.verdict==='charge'?'billing':'do not charge'; v.className='verdict '+d.savings.verdict;
    $('events').textContent=d.savings.eventsConsidered+' requests'+(d.savings.unpricedEvents?(' · '+d.savings.unpricedEvents+' unpriced (recorded, not billed)'):'');
    $('active').innerHTML=d.theo.active.length?d.theo.active.map(l=>'<span class="chip on">'+l.lever+'<span class="muted"> · '+l.class+'</span></span>').join(''):'<span class="empty">none</span>';
    $('withheld').innerHTML=d.theo.withheld.length?d.theo.withheld.map(w=>'<span class="chip held" title="'+(w.reason||'')+'">'+w.lever+'</span>').join(''):'<span class="empty">nothing held</span>';
    $('ceiling').textContent='Quality ceiling: '+d.theo.qualityCeilingPercent+'% — anything that could cost more than this stays off until a replay of your traffic proves it safe.';
    const rows=d.lineItems;
    $('levers').innerHTML=rows.length?rows.map(li=>'<tr><td>'+li.leverId+'</td><td class="muted">'+li.kind+(li.basis?' · '+li.basis:'')+'</td><td class="num">'+li.events+'</td><td class="num">'+usd(li.savedUsd)+'</td></tr>').join(''):'<tr><td colspan="4" class="empty">No billable savings yet — run Claude Code through FLUX and this fills in.</td></tr>';
    $('unbilled').textContent=d.recordedUnbilled.length?('Also recorded (applied, never billed): '+d.recordedUnbilled.map(u=>u.leverId+' ×'+u.events).join(', ')):'';
    $('proxy').innerHTML='<span class="dot '+(d.proxyUp?'ok':'bad')+'"></span>proxy '+(d.proxyUp?'up':'down');
    $('chain').innerHTML='<span class="dot '+(d.chainOk?'ok':'bad')+'"></span>ledger '+(d.chainOk?'verified':('BROKEN at '+d.brokenAt));
    $('updated').textContent='updated '+new Date(d.updatedAt).toLocaleTimeString();
  }catch(e){ $('updated').textContent='reconnecting…'; }
}
tick(); setInterval(tick,3000);
</script></body></html>`;
