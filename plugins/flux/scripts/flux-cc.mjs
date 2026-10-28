#!/usr/bin/env node
// FLUX for Claude Code: route Claude Code through the local FLUX proxy, show
// what it saved, and switch it off again. Zero dependencies; Node 18+.
//
//   flux-cc.mjs on     [--user] [--port 8787] [--force] [--no-start]
//   flux-cc.mjs off    [--user] [--stop]
//   flux-cc.mjs status
//   flux-cc.mjs start  [--port 8787]
//   flux-cc.mjs stop
//   flux-cc.mjs stats  [--json] [--dir <ledger-dir>]...
//   flux-cc.mjs ensure          (SessionStart hook: restart the proxy if FLUX is on)
//
// Safety rules this script keeps:
// - It never points Claude Code at a proxy that isn't answering: `on` starts
//   the proxy first and only writes settings once the health check passes.
// - It never silently replaces a base URL someone else set (a corporate
//   gateway, say). FLUX's proxy forwards to api.anthropic.com, so taking over
//   would bypass that gateway; `--force` is required, and `off` restores it.
// - It never reads or stores prompts or keys. The proxy passes your auth
//   header through verbatim; the ledger holds usage numbers and hashes.
//
// Environment overrides (used by the tests; you rarely need them):
//   FLUX_HOME             state, log and ledger root   (default ~/.flux)
//   FLUX_CC_USER_SETTINGS user settings file           (default ~/.claude/settings.json)
//   CLAUDE_PROJECT_DIR    project whose .claude/settings.local.json is edited (default cwd)
//   FLUX_CC_PROXY_CMD     command that starts the proxy (default: npx -y -p @flux-ai/sdk flux-proxy)
//   FLUX_CC_NO_EXTERNAL   "1" skips the external `flux stats` lookup
//   FLUX_CC_HEALTH_WAIT   seconds to wait for the proxy to answer (default 60)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOME = process.env.FLUX_HOME ?? join(homedir(), ".flux");
const STATE_FILE = join(HOME, "claude-code.json");
const LEDGER_DIR = join(HOME, "ledger");
const LOG_FILE = join(HOME, "proxy.log");
const DEFAULT_PORT = 8787;
const PROXY_CMD = process.env.FLUX_CC_PROXY_CMD ?? "npx -y -p @flux-ai/sdk flux-proxy";
const HEALTH_WAIT_S = Number(process.env.FLUX_CC_HEALTH_WAIT ?? 60);

const argv = process.argv.slice(2);
const command = argv[0] ?? "status";
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const options = (name) => argv.flatMap((value, index) => (value === name && argv[index + 1] ? [argv[index + 1]] : []));

const fluxUrl = (port) => `http://127.0.0.1:${port}`;
const projectDir = () => resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const settingsPath = (user) =>
  user ? (process.env.FLUX_CC_USER_SETTINGS ?? join(homedir(), ".claude", "settings.json")) : join(projectDir(), ".claude", "settings.local.json");

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return fallback;
  return JSON.parse(text); // a malformed settings file aborts; we never overwrite what we can't read
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.flux-tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

const readState = () => readJson(STATE_FILE, {});
const writeState = (state) => writeJson(STATE_FILE, state);

async function healthy(port) {
  try {
    const res = await fetch(`${fluxUrl(port)}/`, { signal: AbortSignal.timeout(1500) });
    return (await res.text()).includes("FLUX proxy");
  } catch {
    return false;
  }
}

async function waitHealthy(port, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await healthy(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startProxy(port) {
  if (await healthy(port)) {
    console.log(`FLUX proxy already running on ${fluxUrl(port)}`);
    return true;
  }
  mkdirSync(LEDGER_DIR, { recursive: true });
  const log = openSync(LOG_FILE, "a");
  const child = spawn(PROXY_CMD, {
    shell: true,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, FLUX_PROXY_PORT: String(port), FLUX_PROXY_LEDGER_DIR: LEDGER_DIR },
  });
  child.unref();
  writeState({ ...readState(), pid: child.pid, port });
  console.log(`Starting FLUX proxy: ${PROXY_CMD}  (log: ${LOG_FILE})`);
  // First run downloads @flux-ai/sdk through npx; give it a minute.
  const ok = await waitHealthy(port, HEALTH_WAIT_S);
  console.log(ok ? `FLUX proxy listening on ${fluxUrl(port)}` : `FLUX proxy did not answer on ${fluxUrl(port)} within ${HEALTH_WAIT_S}s; see ${LOG_FILE}`);
  return ok;
}

function stopProxy() {
  const state = readState();
  if (state.pid === undefined) {
    console.log("No FLUX proxy started by this plugin is on record.");
    return;
  }
  try {
    process.kill(-state.pid); // the whole detached group (npx and node)
  } catch {
    try { process.kill(state.pid); } catch { /* already gone */ }
  }
  const { pid: _pid, ...rest } = state;
  writeState(rest);
  console.log(`Stopped FLUX proxy (pid ${state.pid}).`);
}

async function on() {
  const user = flag("--user");
  const port = Number(option("--port", readState().port ?? DEFAULT_PORT));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`--port must be a port number, got ${port}`);
  const file = settingsPath(user);
  const settings = readJson(file, {});
  const current = settings.env?.ANTHROPIC_BASE_URL;
  const url = fluxUrl(port);
  if (current !== undefined && current !== url && !flag("--force")) {
    console.error(
      `Claude Code is already routed to ${current} (${file}).\n` +
        "FLUX's proxy forwards to api.anthropic.com, so switching would bypass that endpoint.\n" +
        "Re-run with --force to switch anyway; /flux-off restores the previous value.",
    );
    process.exitCode = 2;
    return;
  }
  if (!flag("--no-start") && !(await startProxy(port))) {
    console.error("Settings left unchanged: Claude Code is never pointed at a proxy that isn't answering.");
    process.exitCode = 1;
    return;
  }
  const state = readState();
  const previous = current !== undefined && current !== url ? current : state.targets?.[file]?.previous;
  settings.env = { ...(settings.env ?? {}), ANTHROPIC_BASE_URL: url };
  writeJson(file, settings);
  writeState({ ...state, port, targets: { ...(state.targets ?? {}), [file]: { previous } } });
  console.log(`FLUX on: ANTHROPIC_BASE_URL=${url} written to ${file}`);
  console.log("Restart Claude Code (exit and run `claude` again) for the new base URL to take effect.");
  console.log("Savings: /flux-stats   Undo: /flux-off");
}

function off() {
  const user = flag("--user");
  const file = settingsPath(user);
  const state = readState();
  const settings = readJson(file, undefined);
  const current = settings?.env?.ANTHROPIC_BASE_URL;
  const isFlux = typeof current === "string" && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(current);
  if (settings === undefined || !isFlux) {
    console.log(`FLUX is not set in ${file}; nothing to undo.`);
  } else {
    const previous = state.targets?.[file]?.previous;
    if (previous !== undefined) settings.env.ANTHROPIC_BASE_URL = previous;
    else delete settings.env.ANTHROPIC_BASE_URL;
    if (Object.keys(settings.env).length === 0) delete settings.env;
    writeJson(file, settings);
    const targets = { ...(state.targets ?? {}) };
    delete targets[file];
    writeState({ ...state, targets });
    console.log(previous !== undefined ? `FLUX off: ANTHROPIC_BASE_URL restored to ${previous} in ${file}` : `FLUX off: ANTHROPIC_BASE_URL removed from ${file}`);
    console.log("Restart Claude Code to go direct to the API again.");
  }
  if (flag("--stop")) stopProxy();
}

async function status() {
  const state = readState();
  const port = state.port ?? DEFAULT_PORT;
  for (const [label, file] of [["project", settingsPath(false)], ["user", settingsPath(true)]]) {
    let value;
    try { value = readJson(file, {}).env?.ANTHROPIC_BASE_URL; } catch { value = "(unreadable settings file)"; }
    console.log(`${label.padEnd(8)} ${file}: ANTHROPIC_BASE_URL=${value ?? "(unset)"}`);
  }
  console.log(`session  ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL ?? "(unset)"}`);
  console.log(`proxy    ${fluxUrl(port)}: ${(await healthy(port)) ? "answering" : "not running"}`);
}

// ---- stats -----------------------------------------------------------------

/** Prefer the real `flux stats` once it ships; refuse other tools named flux (e.g. Flux CD). */
function externalStats() {
  if (process.env.FLUX_CC_NO_EXTERNAL === "1") return false;
  const help = spawnSync("flux", ["stats", "--help"], { encoding: "utf8", timeout: 15_000 });
  if (help.error || help.status !== 0) return false;
  if (!/ledger|savings/i.test(`${help.stdout}${help.stderr}`)) return false;
  const run = spawnSync("flux", ["stats", ...argv.slice(1)], { stdio: "inherit", timeout: 120_000 });
  return run.status === 0;
}

function tallySpool(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
  const out = { file, requests: 0, failed: 0, spentUsd: 0, savedUsd: 0, unbilledUsd: 0, levers: {}, chainOk: true };
  let prev;
  for (const [index, line] of lines.entries()) {
    let record;
    try { record = JSON.parse(line); } catch { out.chainOk = false; continue; }
    if (record.seq !== index || (prev !== undefined && record.prevHash !== prev)) out.chainOk = false;
    prev = record.eventHash;
    const event = record.event ?? {};
    out.requests += 1;
    if (event.status !== "succeeded") { out.failed += 1; continue; }
    out.spentUsd += typeof event.actualUsd === "number" ? event.actualUsd : 0;
    for (const lever of event.levers ?? []) {
      if (typeof lever.savedUsd !== "number") continue;
      const billable = lever.kind !== "lossy" || lever.gateVerdict?.verdict === "approved";
      if (billable) {
        out.savedUsd += lever.savedUsd;
        out.levers[lever.leverId] = (out.levers[lever.leverId] ?? 0) + lever.savedUsd;
      } else {
        out.unbilledUsd += lever.savedUsd;
      }
    }
  }
  return out;
}

function localStats() {
  const dirs = options("--dir");
  const candidates = dirs.length > 0 ? dirs.map((d) => resolve(d)) : [LEDGER_DIR, join(projectDir(), "flux-ledger")];
  const spools = candidates
    .filter((d) => existsSync(d))
    .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".jsonl")).map((f) => join(d, f)));
  if (spools.length === 0) {
    console.log(`No FLUX ledger yet (looked in ${candidates.join(", ")}).`);
    console.log("Run /flux to route Claude Code through the proxy; every request then writes one ledger event.");
    return;
  }
  const rows = spools.map(tallySpool);
  const total = rows.reduce((t, r) => ({
    requests: t.requests + r.requests, spentUsd: t.spentUsd + r.spentUsd,
    savedUsd: t.savedUsd + r.savedUsd, unbilledUsd: t.unbilledUsd + r.unbilledUsd,
  }), { requests: 0, spentUsd: 0, savedUsd: 0, unbilledUsd: 0 });
  const pct = (saved, spent) => (spent > 0 ? `${((saved / spent) * 100).toFixed(1)}%` : "n/a");
  if (flag("--json")) {
    console.log(JSON.stringify({ basis: "local-tally-not-an-invoice", total, spools: rows }, null, 2));
    return;
  }
  const money = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(4)}`;
  console.log("FLUX savings (local tally of your ledger, not an invoice)\n");
  for (const r of rows) {
    console.log(`${r.file}`);
    console.log(`  ${r.requests} requests  spent ${money(r.spentUsd)}  saved ${money(r.savedUsd)} (${pct(r.savedUsd, r.spentUsd)})  chain ${r.chainOk ? "linked" : "BROKEN"}`);
    for (const [lever, usd] of Object.entries(r.levers).sort((a, b) => b[1] - a[1])) console.log(`    ${lever.padEnd(28)} ${money(usd)}`);
  }
  console.log(`\nTOTAL  ${total.requests} requests  spent ${money(total.spentUsd)}  saved ${money(total.savedUsd)}  = ${pct(total.savedUsd, total.spentUsd)} of spend`);
  if (total.unbilledUsd !== 0) console.log(`       plus ${money(total.unbilledUsd)} recorded by lossy levers without an approved replay gate (never billed)`);
  console.log("\nThe billable number is the invoice recomputed from these spools:");
  console.log(`  npx -y -p @flux-ai/sdk flux-report ${spools.map((s) => JSON.stringify(s)).join(" ")}`);
}

function stats() {
  if (!externalStats()) localStats();
}

async function ensure() {
  // SessionStart hook: if this machine has FLUX switched on, make sure the
  // proxy is up before Claude Code's first request. Never fails the session.
  try {
    const state = readState();
    const port = state.port ?? DEFAULT_PORT;
    const targets = state.targets ?? {};
    const routed = process.env.ANTHROPIC_BASE_URL === fluxUrl(port) || settingsPath(false) in targets || settingsPath(true) in targets;
    if (routed && !(await healthy(port))) await startProxy(port);
  } catch (error) {
    console.error(`flux ensure: ${error.message}`);
  }
}

const commands = {
  on, off, status, stats, ensure,
  start: async () => { process.exitCode = (await startProxy(Number(option("--port", readState().port ?? DEFAULT_PORT)))) ? 0 : 1; },
  stop: stopProxy,
};
const run = commands[command];
if (run === undefined) {
  console.error(`Unknown command ${JSON.stringify(command)}. Use: on | off | status | start | stop | stats | ensure`);
  process.exitCode = 1;
} else {
  try {
    await run();
  } catch (error) {
    console.error(`flux: ${error.message}`);
    process.exitCode = 1;
  }
}
