/**
 * `flux update` — exercised as a real subprocess, because the module fixes
 * ~/.flux paths from `homedir()` at import time and reads `FLUX_BASE_URL`. We
 * run the CLI with an isolated HOME and a local stub release server, so nothing
 * touches the real home directory or the network.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A stub release server. Its `state` is mutable so a single test can advance
 * from "version 1" to "version 2" between update runs. Serves:
 *   GET /flux-version.json  → the manifest
 *   GET /<runtimeName>      → the runtime body
 */
type StubState = { version: string; sha256: string; body: Buffer; runtimeName: string };

function startStub(initial: StubState): Promise<{ server: Server; url: string; state: StubState }> {
  const state = { ...initial };
  const server = createServer((req, res) => {
    if (req.url === "/flux-version.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: state.version, sha256: state.sha256, runtime: state.runtimeName }));
      return;
    }
    if (req.url === `/${state.runtimeName}`) {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(state.body);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, state });
    });
  });
}

// Must be async `spawn`, not `spawnSync`: the stub release server runs in this
// same process, and a synchronous spawn would block the event loop so the
// server could never answer the subprocess's fetch (a deadlock until timeout).
function runUpdate(home: string, baseUrl: string, args: string[] = []): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", MAIN, "update", ...args], {
      env: { ...process.env, HOME: home, FLUX_BASE_URL: baseUrl },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

describe("flux update (subprocess, isolated HOME + stub release server)", () => {
  let home: string;
  let stub: { server: Server; url: string; state: StubState };
  const RUNTIME_V1 = Buffer.from("export const flux = 'runtime-v1';\n");
  const RUNTIME_V2 = Buffer.from("export const flux = 'runtime-v2 is newer';\n");

  const runtimePath = (): string => join(home, ".flux", "runtime", "flux-runtime.mjs");
  const versionPath = (): string => join(home, ".flux", "runtime", "version");

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "flux-"));
    stub = await startStub({ version: "1.0.0", sha256: sha256(RUNTIME_V1), body: RUNTIME_V1, runtimeName: "flux-runtime" });
  });

  afterEach(() => {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("downloads, checksum-verifies and installs on a fresh HOME", { timeout: 30_000 }, async () => {
    const { status, stdout } = await runUpdate(home, stub.url);
    expect(status).toBe(0);
    expect(stdout).toContain("done");
    expect(existsSync(runtimePath())).toBe(true);
    expect(readFileSync(runtimePath())).toEqual(RUNTIME_V1);
    expect(readFileSync(versionPath(), "utf8").trim()).toBe("1.0.0");
  });

  it("is a no-op the second time: reports already up to date", { timeout: 30_000 }, async () => {
    expect((await runUpdate(home, stub.url)).status).toBe(0);
    const second = await runUpdate(home, stub.url);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Already up to date");
    // The runtime that was already installed is untouched.
    expect(readFileSync(runtimePath())).toEqual(RUNTIME_V1);
  });

  it("rolls back to the previous version after an update replaced an existing runtime", { timeout: 30_000 }, async () => {
    // First install v1, then advance the server to v2 and update into it.
    expect((await runUpdate(home, stub.url)).status).toBe(0);
    stub.state.version = "2.0.0";
    stub.state.body = RUNTIME_V2;
    stub.state.sha256 = sha256(RUNTIME_V2);
    const toV2 = await runUpdate(home, stub.url);
    expect(toV2.status).toBe(0);
    expect(readFileSync(versionPath(), "utf8").trim()).toBe("2.0.0");
    expect(readFileSync(runtimePath())).toEqual(RUNTIME_V2);

    // Roll back: the previous runtime body and version file are restored.
    const rolled = await runUpdate(home, stub.url, ["--rollback"]);
    expect(rolled.status).toBe(0);
    expect(rolled.stdout).toContain("Rolled back to 1.0.0");
    expect(readFileSync(versionPath(), "utf8").trim()).toBe("1.0.0");
    expect(readFileSync(runtimePath())).toEqual(RUNTIME_V1);
  });

  it("rejects a runtime whose sha256 does not match the manifest, keeping the good runtime", { timeout: 30_000 }, async () => {
    // Seed an existing, good runtime so we can prove it is NOT overwritten.
    const dir = join(home, ".flux", "runtime");
    mkdirSync(dir, { recursive: true });
    const good = Buffer.from("export const flux = 'the known-good runtime';\n");
    writeFileSync(join(dir, "flux-runtime.mjs"), good);
    writeFileSync(join(dir, "version"), "good-1.0.0");

    // Serve a NEWER version whose advertised sha256 lies about the body.
    stub.state.version = "9.9.9";
    stub.state.body = Buffer.from("tampered payload that does not hash to the manifest value\n");
    stub.state.sha256 = sha256(Buffer.from("something else entirely"));

    const { status, stdout, stderr } = await runUpdate(home, stub.url);
    expect(status).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("checksum");
    // The known-good runtime and its version are intact; the tampered body
    // never landed on disk.
    expect(readFileSync(runtimePath())).toEqual(good);
    expect(readFileSync(versionPath(), "utf8").trim()).toBe("good-1.0.0");
  });
});

// pullNewerRuntime is what the always-on daemon calls on a timer so it never
// serves an old runtime forever. Same download + checksum + swap as `flux
// update`, but it returns the new version (or null) instead of printing/exiting.
const UPDATE_MOD = fileURLToPath(new URL("./update.ts", import.meta.url));
function runPull(home: string, baseUrl: string): Promise<{ out: string; err: string }> {
  const script =
    `import(${JSON.stringify(UPDATE_MOD)}).then(async (m) => { const v = await m.pullNewerRuntime(); process.stdout.write("PULL:" + JSON.stringify(v ?? null)); });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", script], {
      env: { ...process.env, HOME: home, FLUX_BASE_URL: baseUrl },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", () => resolve({ out, err }));
  });
}

describe("pullNewerRuntime (daemon self-update)", () => {
  let home: string;
  let stub: { server: Server; url: string; state: StubState };
  const R1 = Buffer.from("export const flux = 'v1';\n");
  const R2 = Buffer.from("export const flux = 'v2 newer';\n");
  const rt = (): string => join(home, ".flux", "runtime", "flux-runtime.mjs");
  const ver = (): string => join(home, ".flux", "runtime", "version");

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "flux-pull-"));
    stub = await startStub({ version: "1.0.0", sha256: sha256(R1), body: R1, runtimeName: "flux-runtime" });
  });
  afterEach(() => { stub.server.close(); rmSync(home, { recursive: true, force: true }); });

  it("installs a newer runtime and returns its version", { timeout: 30_000 }, async () => {
    const { out } = await runPull(home, stub.url);
    expect(out).toBe(`PULL:${JSON.stringify("1.0.0")}`);
    expect(readFileSync(rt())).toEqual(R1);
    expect(readFileSync(ver(), "utf8").trim()).toBe("1.0.0");
  });

  it("returns null when already current (no redundant swap)", { timeout: 30_000 }, async () => {
    await runPull(home, stub.url);
    const { out } = await runPull(home, stub.url);
    expect(out).toBe("PULL:null");
  });

  it("keeps the good runtime and returns null on a checksum mismatch", { timeout: 30_000 }, async () => {
    await runPull(home, stub.url); // install v1
    stub.state.version = "2.0.0";
    stub.state.body = R2;
    stub.state.sha256 = sha256(Buffer.from("a lie about the bytes"));
    const { out } = await runPull(home, stub.url);
    expect(out).toBe("PULL:null");
    expect(readFileSync(rt())).toEqual(R1); // unchanged
    expect(readFileSync(ver(), "utf8").trim()).toBe("1.0.0");
  });
});
