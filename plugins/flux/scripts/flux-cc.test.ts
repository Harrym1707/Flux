import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "flux-cc.mjs");
const repo = path.resolve(here, "../../..");

const sandbox = mkdtempSync(path.join(tmpdir(), "flux-cc-"));
const fluxHome = path.join(sandbox, "flux-home");
const project = path.join(sandbox, "project");
const userSettings = path.join(sandbox, "user-settings.json");
mkdirSync(project, { recursive: true });
const port = 20000 + Math.floor(Math.random() * 20000);
// A stand-in proxy: answers the health check the way the real one does.
const fakeProxy = path.join(sandbox, "fake-proxy.mjs");
writeFileSync(fakeProxy, `import http from "node:http";
http.createServer((q, s) => { s.writeHead(404); s.end('{"error":"FLUX proxy forwards POST /v1/messages"}'); }).listen(Number(process.env.FLUX_PROXY_PORT), "127.0.0.1");`);

const env = {
  ...process.env,
  FLUX_HOME: fluxHome,
  CLAUDE_PROJECT_DIR: project,
  FLUX_CC_USER_SETTINGS: userSettings,
  FLUX_CC_PROXY_CMD: `"${process.execPath}" "${fakeProxy}"`,
  FLUX_CC_NO_EXTERNAL: "1",
};
const cc = (...args: string[]) => run(process.execPath, [script, ...args], { env, cwd: project });
const settingsFile = path.join(project, ".claude", "settings.local.json");

afterAll(async () => {
  await cc("stop").catch(() => undefined);
});

describe("flux-cc (Claude Code plugin helper)", () => {
  it("refuses to take over a base URL someone else set, without --force", async () => {
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example", KEEP: "1" }, model: "x" }));
    const result = await cc("on", "--port", String(port)).catch((e: { code: number; stderr: string }) => e);
    expect((result as { code: number }).code).toBe(2);
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).env.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
  });

  it("starts the proxy, then routes Claude Code, then restores on off", async () => {
    const { stdout } = await cc("on", "--port", String(port), "--force");
    expect(stdout).toContain("FLUX on");
    const routed = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(routed.env).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, KEEP: "1" });
    expect(routed.model).toBe("x");
    const status = await cc("status");
    expect(status.stdout).toContain("answering");
    await cc("off", "--stop");
    const restored = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(restored.env).toEqual({ ANTHROPIC_BASE_URL: "https://gateway.example", KEEP: "1" });
  });

  it("removes the key cleanly when there was nothing before", async () => {
    writeFileSync(settingsFile, "{}");
    await cc("on", "--port", String(port), "--no-start");
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}`);
    await cc("off");
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({});
  });

  it("never points Claude Code at a proxy that does not answer", async () => {
    writeFileSync(settingsFile, "{}");
    const deadEnv = { ...env, FLUX_CC_PROXY_CMD: `"${process.execPath}" -e "process.exit(1)"`, FLUX_CC_HEALTH_WAIT: "2" };
    const result = await run(process.execPath, [script, "on", "--port", String(port + 1)], { env: deadEnv, cwd: project, timeout: 30_000 })
      .catch((e: { code: number }) => e);
    expect((result as { code: number }).code).toBe(1);
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({});
  }, 30_000);

  it("tallies the committed live export to the published 18.2%", async () => {
    const { stdout } = await cc("stats", "--dir", path.join(repo, "evals/live-exports-2026-10-26"));
    expect(stdout).toContain("30 requests");
    expect(stdout).toContain("= 18.2% of spend");
    expect(stdout).toContain("not an invoice");
  });

  it("degrades gracefully with no ledger", async () => {
    const { stdout } = await cc("stats");
    expect(stdout).toContain("No FLUX ledger yet");
    expect(existsSync(settingsFile)).toBe(true);
  });
});
