import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compressInstructions, unifiedDiff } from "./compress.js";

const SAMPLE = `# Project rules

Please note that you should always run \`pnpm test\` before committing.
It is very important that you basically keep the build green. It actually matters.
In order to release, please run the script at ./scripts/release.sh with --dry-run first.

- Make sure to use TypeScript strict mode.
- Never commit secrets to the repo.
- Use 2-space indentation.
-   Prefer   small   functions.
- Never commit secrets to the repo.

\`\`\`bash
# Please note that this block is code and must not change.
pnpm   install   --frozen-lockfile
\`\`\`



| Key | Value |
|-----|-------|
| port   | 8787 |

Timeouts are 30s and retries are 3 (see https://example.com/please-note-that/docs).
`;

describe("compressInstructions", () => {
  const result = compressInstructions(SAMPLE);

  it("removes filler and wordy phrasing from prose", () => {
    expect(result.text).toContain("Always run `pnpm test` before committing.");
    expect(result.text).toContain("Keep the build green. It actually matters.");
    expect(result.text).toContain("To release, run the script at ./scripts/release.sh with --dry-run first.");
    expect(result.text).toContain("- Use TypeScript strict mode.");
    expect(result.text).not.toContain("Please note that you");
    expect(result.text).not.toContain("In order to");
  });

  it("keeps code blocks, inline code, paths, URLs, flags and numbers byte-for-byte", () => {
    expect(result.text).toContain("```bash\n# Please note that this block is code and must not change.\npnpm   install   --frozen-lockfile\n```");
    expect(result.text).toContain("`pnpm test`");
    expect(result.text).toContain("./scripts/release.sh");
    expect(result.text).toContain("--dry-run");
    expect(result.text).toContain("https://example.com/please-note-that/docs");
    expect(result.text).toContain("30s and retries are 3");
    expect(result.text).toContain("2-space");
    expect(result.text).toContain("| port   | 8787 |");
  });

  it("dedupes a rule repeated verbatim, keeping its first occurrence", () => {
    expect(result.text.match(/Never commit secrets to the repo\./g)).toHaveLength(1);
    expect(result.stats.duplicateRulesRemoved).toBe(1);
  });

  it("collapses whitespace inside lines and runs of blank lines, keeping list structure", () => {
    expect(result.text).toContain("-   Prefer small functions.");
    expect(result.text).not.toMatch(/\n\n\n/);
  });

  it("never touches headings and keeps headings that repeat", () => {
    const text = "## Notes\nAlpha rule number one here.\n\n## Notes\nBeta rule number two here.\n";
    expect(compressInstructions(text).text).toBe(text);
  });

  it("does not turn a rule into a claim or flip a negation", () => {
    const text = "Make sure the build is green.\nThis is not very stable.\nClearly label every migration.\n";
    expect(compressInstructions(text).text).toBe(text);
  });

  it("is deterministic and idempotent", () => {
    expect(compressInstructions(SAMPLE).text).toBe(result.text);
    expect(compressInstructions(result.text).text).toBe(result.text);
  });

  it("reports fewer tokens after than before", () => {
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it("preserves CRLF line endings and the trailing newline", () => {
    const crlf = "Please   run the tests.\r\nKeep it short.\r\n";
    expect(compressInstructions(crlf).text).toBe("Run the tests.\r\nKeep it short.\r\n");
  });

  it("leaves an already-tight file unchanged", () => {
    const tight = "# Rules\n\n- Run `pnpm test`.\n- No secrets.\n";
    expect(compressInstructions(tight).text).toBe(tight);
  });
});

describe("unifiedDiff", () => {
  it("emits a standard hunk with context", () => {
    const diff = unifiedDiff("a\nb\nc\nd\n", "a\nB\nc\nd\n", "x (original)", "x (compressed)");
    expect(diff).toBe("--- x (original)\n+++ x (compressed)\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n \n");
  });

  it("is empty for identical input", () => {
    expect(unifiedDiff("same\n", "same\n", "a", "b")).toBe("");
  });
});

describe("flux compress CLI", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const main = join(here, "main.ts");
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", main, "compress", ...args], {
    cwd: join(here, "..", "..", ".."),
    encoding: "utf8",
  });

  it("--dry-run prints counts, the LOSSY notice and the diff, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-compress-"));
    const file = join(dir, "CLAUDE.md");
    writeFileSync(file, SAMPLE);
    const output = run(file, "--dry-run");
    expect(output.status).toBe(0);
    expect(output.stdout).toContain("LOSSY");
    expect(output.stdout).toMatch(/tokens {2}\d+ -> \d+/);
    expect(output.stdout).toContain("--- CLAUDE.md (original)");
    expect(output.stdout).toContain("-Please note that you should always run `pnpm test` before committing.");
    expect(readFileSync(file, "utf8")).toBe(SAMPLE);
    expect(existsSync(`${file}.flux-backup`)).toBe(false);
  });

  it("writes the compressed file and a byte-identical backup, and refuses to clobber a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-compress-"));
    const file = join(dir, "AGENTS.md");
    writeFileSync(file, SAMPLE);
    const output = run(file);
    expect(output.status).toBe(0);
    expect(readFileSync(`${file}.flux-backup`, "utf8")).toBe(SAMPLE);
    expect(readFileSync(file, "utf8")).toBe(compressInstructions(SAMPLE).text);

    writeFileSync(file, SAMPLE);
    const again = run(file);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already exists");
    expect(readFileSync(file, "utf8")).toBe(SAMPLE);
  });
});
