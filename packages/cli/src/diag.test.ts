import { describe, it, expect, vi } from "vitest";

import { runDoctor, runVersion } from "./diag.js";

function captureLog(fn: () => void | Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });
  return Promise.resolve(fn()).finally(() => spy.mockRestore()).then(() => logs);
}

describe("flux version", () => {
  it("emits machine-readable identity with --json", async () => {
    const logs = await captureLog(() => runVersion(["--json"]));
    const info = JSON.parse(logs[0]!) as Record<string, string>;
    expect(info).toHaveProperty("version");
    expect(info).toHaveProperty("build");
    expect(info.node).toBe(process.versions.node);
    expect(info.platform).toContain(process.arch);
  });

  it("prints a human-readable line by default", async () => {
    const logs = await captureLog(() => runVersion([]));
    expect(logs[0]).toMatch(/^flux /);
  });
});

describe("flux doctor", () => {
  it("runs environment checks and emits a checks array with --json", async () => {
    const logs = await captureLog(() => runDoctor(["--json"]));
    const out = JSON.parse(logs[0]!) as { checks: Array<{ name: string; ok: boolean }> };
    expect(Array.isArray(out.checks)).toBe(true);
    const names = out.checks.map((c) => c.name);
    // The invariant checks are always present regardless of machine state.
    expect(names).toContain("node");
    expect(names).toContain("proxy");
    expect(names).toContain("ledger");
  });
});
