/**
 * The ~/.claude/settings.json contract, without installing a launchd service.
 *
 * `flux start` points Claude Code at the local proxy by writing
 * ANTHROPIC_BASE_URL into ~/.claude/settings.json, and reverts that write on
 * exit — leaving any pre-existing, unrelated settings untouched. We drive the
 * real `flux start` against an isolated HOME on an OS-assigned port (no real
 * API traffic flows; we only inspect the settings file it mutates), then send
 * SIGINT and assert the revert.
 *
 * Run as a subprocess because start.ts fixes ~/.flux and ~/.claude paths from
 * `homedir()` at import time.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

type Settings = { env?: Record<string, string>; theme?: string } & Record<string, unknown>;

function settingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

function readSettings(home: string): Settings {
  return JSON.parse(readFileSync(settingsPath(home), "utf8")) as Settings;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll a predicate until it holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return true;
    } catch {
      /* file not there yet */
    }
    await sleep(intervalMs);
  }
  return false;
}

describe("flux start — ~/.claude/settings.json merge + revert", () => {
  let home: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "flux-"));
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child!.once("exit", () => resolve())).catch(() => undefined);
    }
    child = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("adds ANTHROPIC_BASE_URL while running, then reverts on SIGINT, preserving unrelated settings", { timeout: 30_000 }, async () => {
    // A user who already has settings: an unrelated env var and a theme.
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath(home), `${JSON.stringify({ env: { FOO: "bar" }, theme: "dark" }, null, 2)}\n`);

    // Port 0 lets the OS pick a free port; we never send traffic through it.
    child = spawn(process.execPath, ["--import", "tsx", MAIN, "start", "--port", "0"], {
      env: { ...process.env, HOME: home },
      stdio: "ignore",
    });

    // While running, ANTHROPIC_BASE_URL points at the local proxy and the
    // pre-existing settings are still present.
    const configured = await waitFor(() => Boolean(readSettings(home).env?.ANTHROPIC_BASE_URL));
    expect(configured).toBe(true);
    const running = readSettings(home);
    expect(running.env!.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.env!.FOO).toBe("bar");
    expect(running.theme).toBe("dark");

    // Ctrl+C: start must revert its own key and leave everything else alone.
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGINT");
    await exited;

    const reverted = readSettings(home);
    expect(reverted.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(reverted.env?.FOO).toBe("bar");
    expect(reverted.theme).toBe("dark");
  });

  it("with --no-install it does not touch ~/.claude/settings.json at all", { timeout: 30_000 }, async () => {
    child = spawn(process.execPath, ["--import", "tsx", MAIN, "start", "--port", "0", "--no-install"], {
      env: { ...process.env, HOME: home },
      stdio: "ignore",
    });

    // Give the proxy time to come up; the ledger dir appears under ~/.flux,
    // which is our signal that start actually got going.
    const up = await waitFor(() => existsSync(join(home, ".flux", "ledger")));
    expect(up).toBe(true);

    // No Claude Code wiring was written.
    expect(existsSync(settingsPath(home))).toBe(false);

    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGINT");
    await exited;
    expect(existsSync(settingsPath(home))).toBe(false);
  });
});
