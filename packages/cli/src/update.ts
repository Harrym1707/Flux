/**
 * `flux update` — force a runtime refresh now (instead of waiting for the
 * bootstrap's daily check), with a one-step rollback.
 *
 *   flux update              fetch the manifest, and if newer, download +
 *                            checksum-verify the runtime, keeping the current
 *                            one as a backup, then swap it in
 *   flux update --rollback   restore the previous runtime
 *
 * It verifies the sha256 against the manifest before swapping (release-signature
 * verification is added in the signing track). It never overwrites a working
 * runtime until the replacement has passed its checksum.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.FLUX_BASE_URL ?? "https://www.fluxtoken.dev").replace(/\/$/, "");
const DIR = join(homedir(), ".flux", "runtime");
const RUNTIME = join(DIR, "flux-runtime.mjs");
const VERSION_FILE = join(DIR, "version");
const SHA_FILE = join(DIR, "sha256");
const BACKUP = join(DIR, "flux-runtime.previous.mjs");
const BACKUP_VERSION = join(DIR, "version.previous");
const BACKUP_SHA = join(DIR, "sha256.previous");

type Manifest = { version: string; sha256: string; runtime?: string };

function read(path: string): string | null {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

function rollback(): void {
  if (!existsSync(BACKUP)) {
    console.error("No previous runtime to roll back to.");
    process.exit(1);
  }
  copyFileSync(BACKUP, RUNTIME);
  const prev = read(BACKUP_VERSION) ?? "previous";
  writeFileSync(VERSION_FILE, prev);
  if (existsSync(BACKUP_SHA)) copyFileSync(BACKUP_SHA, SHA_FILE);
  console.log(`Rolled back to ${prev}.`);
}

export async function runUpdate(argv: string[]): Promise<void> {
  if (argv.includes("--rollback")) { rollback(); return; }

  mkdirSync(DIR, { recursive: true });
  const have = existsSync(VERSION_FILE) ? read(VERSION_FILE) : null;

  let manifest: Manifest;
  try {
    const res = await fetch(`${BASE}/flux-version.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = (await res.json()) as Manifest;
  } catch (error) {
    console.error(`Couldn't reach ${BASE} to check for updates (${String(error)}).`);
    process.exit(1);
  }

  if (have === manifest.version) { console.log(`Already up to date (${have}).`); return; }

  process.stdout.write(`Updating ${have ?? "(none)"} → ${manifest.version}… `);
  let bytes: Buffer;
  try {
    const res = await fetch(`${BASE}/${manifest.runtime ?? "flux-runtime"}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    console.log("failed");
    console.error(String(error));
    process.exit(1);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    console.log("failed");
    console.error("The downloaded runtime failed its checksum — refusing to install it.");
    process.exit(1);
  }

  // Keep the current runtime as a rollback point, then swap atomically-enough.
  if (existsSync(RUNTIME)) {
    copyFileSync(RUNTIME, BACKUP);
    if (have !== null) writeFileSync(BACKUP_VERSION, have);
    if (existsSync(SHA_FILE)) copyFileSync(SHA_FILE, BACKUP_SHA);
  }
  writeFileSync(RUNTIME, bytes);
  writeFileSync(VERSION_FILE, manifest.version);
  writeFileSync(SHA_FILE, manifest.sha256); // so `flux verify` can re-check the cached runtime
  console.log("done.");
  console.log(`Now on ${manifest.version}. Roll back with: flux update --rollback`);
}
