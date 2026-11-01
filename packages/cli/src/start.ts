/**
 * `flux start` — the one-command, frictionless deploy for Claude Code.
 *
 * What it does, in order:
 *   1. Starts the REAL FLUX proxy (the same `startFluxProxy` the test suite
 *      covers) on a local port, writing a hash-chained ledger under ~/.flux.
 *   2. Points Claude Code at it by writing ANTHROPIC_BASE_URL into
 *      ~/.claude/settings.json — and REVERTS that on exit, so Claude Code is
 *      never left pointing at a stopped proxy.
 *   3. Runs Theo alongside you: he applies only gate-proven levers, watches the
 *      ledger, and reports savings that are verified from your provider's own
 *      usage — never an estimate, never a number he can't prove.
 *
 * It never reads, stores or forwards your API key: your own credential stays in
 * Claude Code and is passed straight through to Anthropic. FLUX only sets the
 * base URL.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { recomputeInvoice, verifyLedgerChain, type LedgerRecord } from "../../core/src/index.js";
import {
  startFluxProxy,
  defaultPolicy,
  policyToReductionConfig,
  withheldLevers,
} from "../../sdk-js/src/index.js";

declare const __FLUX_BUILD_COMMIT__: string | undefined;
export const BUILD_COMMIT =
  typeof __FLUX_BUILD_COMMIT__ !== "undefined" ? __FLUX_BUILD_COMMIT__ : (process.env.FLUX_BUILD_COMMIT ?? "dev");

const FLUX_HOME = join(homedir(), ".flux");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");

type StartArgs = { port: number; ledgerDir: string; install: boolean };

function parseStart(argv: string[]): StartArgs {
  const args: StartArgs = { port: 8787, ledgerDir: join(FLUX_HOME, "ledger"), install: true };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (key === "--help" || key === "-h") {
      console.log(
        `Usage: flux start [options]\n\n` +
          `  --port <n>       Port for the local proxy (default 8787).\n` +
          `  --ledger <dir>   Where to write the hash-chained ledger (default ~/.flux/ledger).\n` +
          `  --no-install     Don't touch ~/.claude/settings.json; just run the proxy.\n` +
          `  --help           Show this message.`,
      );
      process.exit(0);
    }
    if (key === "--no-install") { args.install = false; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value.`);
    i += 1;
    if (key === "--port") args.port = Number.parseInt(value, 10);
    else if (key === "--ledger") args.ledgerDir = value;
    else throw new Error(`Unknown option: ${key}. See flux start --help.`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error("--port must be 0-65535.");
  return args;
}

/** A per-user HMAC key for Theo's blind feature stream. Local, 0600, never leaves. */
function blindKey(): string {
  const path = join(FLUX_HOME, "blind.key");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const key = randomBytes(32).toString("hex");
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

/** Point Claude Code at the proxy; return a function that restores the prior state. */
function configureClaudeCode(baseUrl: string): () => void {
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  let settings: Record<string, unknown> = {};
  let hadFile = false;
  if (existsSync(CLAUDE_SETTINGS)) {
    hadFile = true;
    try {
      settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`~/.claude/settings.json isn't valid JSON — fix or move it, then re-run. FLUX won't overwrite it.`);
    }
  }
  const env = { ...((settings.env as Record<string, string>) ?? {}) };
  const priorBaseUrl = env.ANTHROPIC_BASE_URL;
  env.ANTHROPIC_BASE_URL = baseUrl;
  writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify({ ...settings, env }, null, 2)}\n`);

  return function restore(): void {
    try {
      const now = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as Record<string, unknown>;
      const nowEnv = { ...((now.env as Record<string, string>) ?? {}) };
      if (priorBaseUrl === undefined) delete nowEnv.ANTHROPIC_BASE_URL;
      else nowEnv.ANTHROPIC_BASE_URL = priorBaseUrl;
      const next: Record<string, unknown> = { ...now, env: nowEnv };
      if (Object.keys(nowEnv).length === 0) delete next.env;
      if (!hadFile && Object.keys(next).length === 0) return; // we created nothing worth keeping
      writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      /* best-effort restore; never crash on shutdown */
    }
  };
}

type LedgerSummary = { events: number; savedUsd: number; verdict: string; chainOk: boolean; brokenAt?: string };

/** Read every ledger spool, verify each chain, and recompute one honest invoice. */
function summariseLedger(ledgerDir: string): LedgerSummary {
  if (!existsSync(ledgerDir)) return { events: 0, savedUsd: 0, verdict: "do_not_charge", chainOk: true };
  const spools = readdirSync(ledgerDir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".features.jsonl"));
  const allRecords: LedgerRecord[] = [];
  let chainOk = true;
  let brokenAt: string | undefined;
  for (const spool of spools) {
    const records: LedgerRecord[] = [];
    const raw = readFileSync(join(ledgerDir, spool), "utf8").trim();
    if (raw === "") continue;
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try { records.push(JSON.parse(line) as LedgerRecord); } catch { /* partial tail line mid-write */ }
    }
    const chain = verifyLedgerChain(records);
    if (!chain.ok) { chainOk = false; brokenAt = `${spool} seq ${chain.seq}`; }
    allRecords.push(...records);
  }
  if (allRecords.length === 0) return { events: 0, savedUsd: 0, verdict: "do_not_charge", chainOk };
  const invoice = recomputeInvoice(allRecords.map((r) => r.event));
  return {
    events: allRecords.length,
    savedUsd: invoice.netVerifiedSavingsUsd,
    verdict: invoice.verdict,
    chainOk,
    brokenAt,
  };
}

const T = "⬢ theo"; // the hex mark, Theo's sign-off

export async function runStart(argv: string[]): Promise<void> {
  const args = parseStart(argv);
  mkdirSync(FLUX_HOME, { recursive: true });
  mkdirSync(args.ledgerDir, { recursive: true });

  // Theo's policy: load the user's own, or start strict + lossless.
  const policyPath = join(FLUX_HOME, "theo-policy.json");
  const policy = existsSync(policyPath)
    ? JSON.parse(readFileSync(policyPath, "utf8"))
    : defaultPolicy("local", new Date().toISOString());
  if (!existsSync(policyPath)) writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

  const proxy = await startFluxProxy({
    port: args.port,
    ledgerDirectory: args.ledgerDir,
    tokenReduction: policyToReductionConfig(policy),
    blindFeaturesKey: blindKey(),
  });

  const restore = args.install ? configureClaudeCode(proxy.url) : () => {};
  const withheld = withheldLevers(policy);

  // ---- banner ----
  console.log("");
  console.log(`  FLUX is running  ·  build ${BUILD_COMMIT}`);
  console.log(`  proxy    ${proxy.url}`);
  console.log(`  ledger   ${args.ledgerDir}  (hash-chained; recompute any time with: flux verify)`);
  if (args.install) console.log(`  claude   pointed at FLUX via ~/.claude/settings.json  (restored on exit)`);
  else console.log(`  claude   not configured (--no-install); set ANTHROPIC_BASE_URL=${proxy.url} yourself`);
  console.log("");
  console.log(`  ${T} — I'm watching your traffic. I only ever tune FLUX, never your prompts`);
  console.log(`  ${T}   or answers. Everything I report is verified from your provider's own`);
  console.log(`  ${T}   usage — never an estimate.`);
  if (withheld.length > 0) {
    console.log(`  ${T}   Holding ${withheld.length} lossy lever${withheld.length === 1 ? "" : "s"} back until a replay`);
    console.log(`  ${T}   proves ${withheld.length === 1 ? "it is" : "they are"} safe on your own traffic.`);
  }
  console.log("");
  console.log(`  Just use Claude Code as normal. Press Ctrl+C to stop (Claude Code reverts cleanly).`);
  console.log("");

  // ---- Theo's monitor: report verified savings as they accrue ----
  let lastEvents = -1;
  const tick = (): void => {
    const s = summariseLedger(args.ledgerDir);
    if (!s.chainOk) {
      console.log(`  ${T} — ⚠ ledger chain check failed at ${s.brokenAt}. Stop and run: flux verify`);
      return;
    }
    if (s.events === lastEvents) return;
    lastEvents = s.events;
    if (s.events === 0) return;
    const saved = `$${s.savedUsd.toFixed(4)}`;
    const verdict = s.verdict === "charge" ? saved : `${saved} (nothing to bill yet — do not pay us)`;
    console.log(`  ${T} — ${s.events} request${s.events === 1 ? "" : "s"} seen · ${verdict} verified saved`);
  };
  const monitor = setInterval(tick, 6000);

  // ---- clean shutdown ----
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(monitor);
    const s = summariseLedger(args.ledgerDir);
    restore();
    await proxy.close();
    console.log("");
    if (s.events > 0) {
      console.log(`  ${T} — session done: ${s.events} request${s.events === 1 ? "" : "s"}, $${s.savedUsd.toFixed(4)} verified saved.`);
      console.log(`  ${T}   Recompute it yourself any time: flux verify`);
    } else {
      console.log(`  ${T} — no requests ran through FLUX this session.`);
    }
    console.log(`  Claude Code restored. Bye.`);
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  // Keep the process alive.
  await new Promise<void>(() => {});
}
