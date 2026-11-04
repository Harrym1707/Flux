/**
 * Clean-machine smoke test: the read-only commands (`version`, `doctor`,
 * `verify`) must work from a pristine HOME with no ~/.mesh and no ~/.claude,
 * and must never reach the network. Run as a subprocess so the module-level
 * `homedir()` paths resolve against the isolated HOME, not the real one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

function runMesh(home: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", MAIN, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("mesh on a clean machine (no ~/.mesh, no ~/.claude)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mesh-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("starts from a genuinely pristine HOME", () => {
    expect(existsSync(join(home, ".mesh"))).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("`version --json` prints valid machine-readable identity", () => {
    const { status, stdout } = runMesh(home, ["version", "--json"]);
    expect(status).toBe(0);
    const info = JSON.parse(stdout.trim()) as Record<string, string>;
    expect(info).toHaveProperty("version");
    expect(info).toHaveProperty("build");
    expect(info.node).toBe(process.versions.node);
    expect(info.platform).toContain(process.arch);
  });

  it("`doctor --json` returns a checks array with the invariant checks", () => {
    const { status, stdout } = runMesh(home, ["doctor", "--json"]);
    // doctor only sets a non-zero exit on a HARD failure; a clean machine has
    // none (an unreachable proxy is a warning, not a failure).
    expect(status).toBe(0);
    const out = JSON.parse(stdout.trim()) as { checks: Array<{ name: string; ok: boolean }> };
    expect(Array.isArray(out.checks)).toBe(true);
    const names = out.checks.map((c) => c.name);
    expect(names).toContain("node");
    expect(names).toContain("proxy");
    expect(names).toContain("claude");
    expect(names).toContain("ledger");
    // Nothing is configured yet, so the ledger is empty and healthy.
    const ledger = out.checks.find((c) => c.name === "ledger")!;
    expect(ledger.ok).toBe(true);
  });

  it("`verify` passes with no ledger and exits zero", () => {
    const { status, stdout } = runMesh(home, ["verify"]);
    expect(status).toBe(0);
    expect(stdout).toContain("All checks passed");
    // Provenance + reducer always run; the ledger/determinism checks degrade
    // gracefully to "nothing yet" rather than failing.
    expect(stdout).toContain("provenance");
    expect(stdout).toContain("reducer");
    expect(stdout).toContain("ledger");
  });
});
