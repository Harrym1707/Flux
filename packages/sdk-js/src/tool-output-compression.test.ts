import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { approximateTokenCount } from "../../core/dist/src/index.js";
import { reduceRequest, type FluxTokenReductionConfig } from "./reduce-request.js";
import {
  compressCsv,
  compressToolOutput,
  dropEmptyJsonFields,
  htmlToText,
  minifyJsonWhitespace,
  type FluxToolOutputCompressionConfig,
} from "./tool-output-compression.js";

/** Real captures (provenance: docs/rnd/2026-10-28-read-less.md, "Fixtures"). */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../evals/tool-output-fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const ALL: FluxToolOutputCompressionConfig = {
  json: true,
  jsonDropEmpty: true,
  logs: true,
  testOutput: true,
  installOutput: true,
  csv: true,
  html: true,
};
const TESTS_ONLY: FluxToolOutputCompressionConfig = { testOutput: true };
const ESC = "\x1b";

/** Every line of `original` that carries an error/failure/warning word must survive verbatim. */
function expectFailureLinesKept(original: string, compressed: string): void {
  const keep = /\b(error|fail|failed|failure|failures|panicked|assert|assertion|warn|warning|deprecated|traceback|exception)\b|✕|●|^E\s|^>\s/i;
  const out = new Set(compressed.split("\n"));
  for (const line of original.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    if (keep.test(line)) expect(out.has(line), `kept verbatim: ${JSON.stringify(line)}`).toBe(true);
  }
}

describe("test-runner output (lossy)", () => {
  it("jest: collapses passing tests, keeps the failure block, code frame and summary verbatim", () => {
    const raw = fixture("jest-verbose.txt");
    const result = compressToolOutput(raw, TESTS_ONLY);
    expect(result.kinds).toEqual(["test"]);
    expect(result.text).toContain("    [flux: 30 line(s) of passing tests collapsed: 30 passed]");
    expect(result.text).toContain("    [flux: 5 line(s) of passing tests collapsed: 5 passed]");
    expect(result.text).not.toContain("✓ scales linearly for qty 7");
    for (const line of [
      "    ✕ applies discount with rounding (11 ms)",
      "  ● cart total › applies discount with rounding",
      "    > 13 |     expect(total([[19.99, 3]], 15)).toBe(50.98);",
      "      at Object.toBe (cart.test.js:13:37)",
      "Tests:       1 failed, 35 passed, 36 total",
      "Test Suites: 1 failed, 1 total",
    ]) expect(result.text.split("\n")).toContain(line);
    expectFailureLinesKept(raw, result.text);
    // The lossless tier alone does nothing to a plain test run.
    expect(result.lossless).toBe(raw);
  });

  it("vitest: collapses ✓ lines and keeps the assertion diff and summary", () => {
    const raw = fixture("vitest-verbose.txt");
    const result = compressToolOutput(raw, TESTS_ONLY);
    expect(result.text).toContain(" [flux: 30 line(s) of passing tests collapsed: 30 passed]");
    expect(result.text).toContain(" × cart.test.js > cart total > applies discount with rounding 9ms");
    expect(result.text).toContain(" [flux: 5 line(s) of passing tests collapsed: 5 passed]");
    expect(result.text).toContain(" FAIL  cart.test.js > cart total > applies discount with rounding");
    expect(result.text).toContain("AssertionError: expected 50.97 to be 50.98 // Object.is equality");
    expect(result.text).toContain("      Tests  1 failed | 35 passed (36)");
    expectFailureLinesKept(raw, result.text);
  });

  it("pytest -v: collapses PASSED lines, keeps FAILED lines, the FAILURES section and short summary", () => {
    const raw = fixture("pytest-verbose.txt");
    const result = compressToolOutput(raw, TESTS_ONLY);
    expect(result.text).toContain("test_cart.py::test_discount_rounding FAILED");
    expect(result.text).toContain("E       KeyError: 'SPRING'");
    expect(result.text).toContain(">       assert registry[\"SPRING\"] == 5");
    expect(result.text).toContain("=========================== short test summary info ============================");
    expect(result.text).toContain("========================= 2 failed, 47 passed in 0.09s =========================");
    expect(result.text).not.toMatch(/test_total_scales\[\d+\] PASSED/);
    expectFailureLinesKept(raw, result.text);
  });

  it("pytest default: a progress line containing F is a failure signal and stays verbatim", () => {
    const raw = fixture("pytest-default.txt");
    expect(compressToolOutput(raw, ALL).text).toBe(raw);
  });

  it("go test -v: collapses --- PASS and === RUN bookkeeping but keeps the failing test's RUN line and log", () => {
    const raw = fixture("go-test-verbose.txt");
    const result = compressToolOutput(raw, TESTS_ONLY);
    expect(result.text.split("\n")).toEqual([
      "[flux: 64 line(s) of passing tests collapsed: 32 passed]",
      "=== RUN   TestDiscount",
      "    cart_test.go:36: Total with discount = 5097, want 5098",
      "--- FAIL: TestDiscount (0.00s)",
      "FAIL",
      "FAIL\texample.com/cart\t0.004s",
      "FAIL",
      "",
    ]);
  });

  it("cargo test: collapses `... ok` lines and keeps the panic, backtrace and result line", () => {
    const raw = fixture("cargo-test.txt");
    const result = compressToolOutput(raw, TESTS_ONLY);
    expect(result.text).toContain("[flux: 25 line(s) of passing tests collapsed: 25 passed]");
    expect(result.text).toContain("test tests::discount_rounding ... FAILED");
    expect(result.text).toContain("thread 'tests::discount_rounding' (24461) panicked at src/lib.rs:31:9:");
    expect(result.text).toContain("   4: cart::tests::discount_rounding");
    expect(result.text).toContain("test result: FAILED. 25 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s");
    expectFailureLinesKept(raw, result.text);
  });

  it("accounting: every line not inside a marker survives in order, and the markers count exactly what went", () => {
    const cases: Array<[string, FluxToolOutputCompressionConfig, RegExp]> = [
      ["jest-verbose.txt", TESTS_ONLY, /^\s*\[flux: (\d+) line\(s\) of passing tests collapsed/],
      ["vitest-verbose.txt", TESTS_ONLY, /^\s*\[flux: (\d+) line\(s\) of passing tests collapsed/],
      ["pytest-verbose.txt", TESTS_ONLY, /^\s*\[flux: (\d+) line\(s\) of passing tests collapsed/],
      ["go-test-verbose.txt", TESTS_ONLY, /^\s*\[flux: (\d+) line\(s\) of passing tests collapsed/],
      ["cargo-test.txt", TESTS_ONLY, /^\s*\[flux: (\d+) line\(s\) of passing tests collapsed/],
      ["npm-install-loglevel-http.txt", { installOutput: true }, /^\[flux: (\d+) package-manager\/build progress/],
      ["pnpm-add.txt", { installOutput: true }, /^\[flux: (\d+) package-manager\/build progress/],
      ["pip-install.txt", { installOutput: true }, /^\[flux: (\d+) package-manager\/build progress/],
    ];
    for (const [name, config, marker] of cases) {
      const input = fixture(name).split("\n");
      const output = compressToolOutput(fixture(name), config).text.split("\n");
      let removed = 0;
      let cursor = 0;
      for (const line of output) {
        const match = marker.exec(line);
        if (match) {
          removed += Number(match[1]);
          continue;
        }
        while (cursor < input.length && input[cursor] !== line) cursor += 1;
        expect(cursor < input.length, `${name}: ${JSON.stringify(line)} in order`).toBe(true);
        cursor += 1;
      }
      const kept = output.filter((line) => !marker.test(line)).length;
      expect(kept + removed, name).toBe(input.length);
    }
  });

  it("needs a runner signature: ✓ lines without a summary are not treated as tests", () => {
    const text = ["Checklist:", "✓ wrote the migration", "✓ ran it locally", "✓ updated the docs", "✓ pinged review"].join("\n");
    expect(compressToolOutput(text, ALL).text).toBe(text);
  });

  it("a passing test whose NAME mentions an error is still a passing test", () => {
    const text = [
      "PASS src/a.test.ts",
      "  ✓ throws an error on bad input (2 ms)",
      "  ✓ returns 400 for invalid JSON",
      "  ✓ parses dates",
      "Tests:       3 passed, 3 total",
    ].join("\n");
    const result = compressToolOutput(text, TESTS_ONLY);
    expect(result.text).toBe("[flux: 4 line(s) of passing tests collapsed: 4 passed]\nTests:       3 passed, 3 total");
  });
});

describe("logs", () => {
  it("lossless tier: strips ANSI colour codes and collapses exact repeats with their exact count", () => {
    const raw = fixture("python-http-server.log");
    const result = compressToolOutput(raw, { logs: "lossless" });
    expect(result.text).toContain('127.0.0.1 - - [28/Oct/2026 14:31:35] "GET /test_cart.py HTTP/1.1" 200 - (x45)');
    expect(result.text).toBe(result.lossless);
    // Lossless means reconstructible: expanding every (xN) gives back the input.
    const expanded = result.text.split("\n").flatMap((line) => {
      const match = / \(x(\d+)\)$/.exec(line);
      return match ? Array(Number(match[1])).fill(line.slice(0, match.index)) : [line];
    }).join("\n");
    expect(expanded).toBe(raw);
  });

  it("lossy tier: near-identical lines (same modulo timestamps/numbers) collapse; 404 lines stay", () => {
    const raw = fixture("python-http-server.log");
    const result = compressToolOutput(raw, { logs: true });
    expect(result.text).toContain('127.0.0.1 - - [28/Oct/2026 14:31:35] "GET /?page=1 HTTP/1.1" 200 - (x30, timestamps/numbers vary)');
    expect(result.text).toContain('127.0.0.1 - - [28/Oct/2026 14:31:36] "GET /missing.js HTTP/1.1" 404 -');
    expect(result.text.split("\n").filter((line) => line.includes("code 404, message File not found"))).toHaveLength(2);
  });

  it("never collapses ERROR/WARN lines, even exact repeats", () => {
    const lines = [
      ...Array.from({ length: 4 }, (_, i) => `2026-10-28T10:00:0${i}Z INFO heartbeat ok`),
      ...Array.from({ length: 4 }, () => "2026-10-28T10:00:05Z ERROR upstream connect refused"),
      ...Array.from({ length: 3 }, (_, i) => `2026-10-28T10:00:1${i}Z WARN retrying in ${i}s`),
    ];
    const result = compressToolOutput(lines.join("\n"), { logs: true });
    const out = result.text.split("\n");
    expect(out.filter((line) => line === "2026-10-28T10:00:05Z ERROR upstream connect refused")).toHaveLength(4);
    expect(out.filter((line) => line.includes("WARN retrying"))).toHaveLength(3);
    expect(out[0]).toBe("2026-10-28T10:00:00Z INFO heartbeat ok (x4, timestamps/numbers vary)");
  });

  it("drops progress-bar spam and resolves carriage-return overwrites (lossy)", () => {
    const text = [
      "2026-10-28 10:00:00 INFO starting download",
      "Downloading model\r 10%|█         | 1/10\r 50%|█████     | 5/10\r100%|██████████| 10/10",
      "   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 1.3/1.3 MB 532.0 kB/s  0:00:02",
      "2026-10-28 10:00:03 INFO download complete",
      "2026-10-28 10:00:04 INFO cache warmed",
      "2026-10-28 10:00:05 INFO ready",
      "2026-10-28 10:00:06 ERROR model checksum mismatch",
    ].join("\n");
    const result = compressToolOutput(text, { logs: true });
    expect(result.text).not.toContain("█");
    expect(result.text).not.toContain("━");
    expect(result.text).not.toContain("\r");
    expect(result.text).toContain("2026-10-28 10:00:06 ERROR model checksum mismatch");
    expect(result.text).toContain("[flux: 2 progress-bar line(s) dropped]");
  });

  it("ANSI-coloured cargo build output: lossless strips colour, lossy collapses the Compiling/Downloaded chatter", () => {
    const raw = fixture("cargo-build-color.txt");
    expect(raw).toContain(ESC);
    const lossless = compressToolOutput(raw, { logs: "lossless" });
    expect(lossless.text).not.toContain(ESC);
    expect(lossless.text.replace(/\s+/g, "")).toBe(raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, ""));
    const lossy = compressToolOutput(raw, { logs: true, installOutput: true });
    expect(lossy.text).toContain("    Finished `dev` profile [unoptimized + debuginfo] target(s) in 16.68s");
    expect(lossy.text).toMatch(/\[flux: \d+ package-manager\/build progress line\(s\) collapsed\]/);
  });
});

describe("install/build output (lossy)", () => {
  it("npm --loglevel http: hundreds of fetch lines collapse; deprecation warnings and the audit stay", () => {
    const raw = fixture("npm-install-loglevel-http.txt");
    const result = compressToolOutput(raw, { installOutput: true });
    expect(result.text.length).toBeLessThan(raw.length / 10);
    expect(result.text).toContain("npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it. Check out lru-cache if you want a good and tested way to coalesce async requests by a key value, which is much more comprehensive and powerful.");
    expect(result.text).toContain("added 267 packages, and audited 268 packages in 14s");
    expect(result.text).toContain("6 low severity vulnerabilities");
  });

  it("pnpm: progress lines collapse to the last one, the WARN line stays", () => {
    const raw = fixture("pnpm-add.txt");
    const result = compressToolOutput(raw, { installOutput: true });
    // pnpm pads its WARN badge with U+2009 thin spaces; the line is kept byte-for-byte.
    expect(result.text).toContain("\u2009WARN\u2009 2 deprecated subdependencies found: glob@7.2.3, inflight@1.0.6");
    expect(result.text).toContain("Progress: resolved 267, reused 0, downloaded 266, added 266, done");
    expect(result.text).not.toContain("Progress: resolved 39,");
    expect(result.text).toContain("+ jest 29.7.0 (30.5.2 is available)");
  });

  it("pip: Collecting/Downloading chatter collapses, the install result stays", () => {
    const raw = fixture("pip-install.txt");
    const result = compressToolOutput(raw, { installOutput: true, logs: true });
    expect(result.text).toContain("Successfully installed certifi-2026.10.23");
    expect(result.text).not.toContain("Collecting iniconfig");
    expect(result.text).not.toContain("━");
  });
});

describe("JSON", () => {
  it("lossless: whitespace-only minification keeps every literal byte-for-byte", () => {
    const pretty = '{\n  "id": 12345678901234567890,\n  "ratio": 1.0,\n  "name": "caf\\u00e9  au  lait",\n' +
      '  "dup": 1,\n  "dup": 2,\n  "tags": [ "a" , "b" ],\n  "nested": { "x" : null }\n}\n';
    const minified = minifyJsonWhitespace(pretty.trim());
    expect(minified).toBe('{"id":12345678901234567890,"ratio":1.0,"name":"caf\\u00e9  au  lait","dup":1,"dup":2,"tags":["a","b"],"nested":{"x":null}}');
    expect(JSON.parse(minified)).toEqual(JSON.parse(pretty));
    const result = compressToolOutput(pretty, true);
    expect(result.text).toBe(minified);
    expect(result.lossless).toBe(minified);
  });

  it("strings with escaped quotes and backslashes are not mangled", () => {
    const pretty = '[\n  "a \\" b",\n  "c\\\\",\n  " d "\n]';
    expect(minifyJsonWhitespace(pretty)).toBe('["a \\" b","c\\\\"," d "]');
  });

  it("a real pretty-printed npm registry document minifies to valid, equal JSON", () => {
    const raw = fixture("npm-jest-29.7.0.pretty.json");
    const result = compressToolOutput(raw, { json: true });
    expect(JSON.parse(result.text)).toEqual(JSON.parse(raw));
    expect(result.text.length).toBeLessThan(raw.length);
  });

  it("lossy: drops null/empty members recursively, keeps array positions, and says so", () => {
    const text = '{"a":null,"b":"","c":[],"d":{},"e":{"f":null},"g":[null,1],"h":0,"i":false}';
    const dropped = dropEmptyJsonFields(text);
    expect(dropped).toBe('{"g":[null,1],"h":0,"i":false}\n[flux: 6 null/empty JSON field(s) dropped]');
  });

  it("lossy on the real PyPI response: drops its null/empty info fields", () => {
    const raw = fixture("pypi-requests.json");
    const result = compressToolOutput(raw, { json: true, jsonDropEmpty: true });
    expect(result.text).toMatch(/\[flux: \d+ null\/empty JSON field\(s\) dropped\]$/);
    const body = JSON.parse(result.text.slice(0, result.text.lastIndexOf("\n")));
    expect(body.info.bugtrack_url).toBeUndefined();
    expect(body.info.name).toBe("requests");
  });

  it("text that merely starts with a brace is left alone", () => {
    const text = "{ this is not json }\nbut a log line";
    expect(compressToolOutput(text, ALL).text).toBe(text);
  });
});

describe("CSV/TSV (lossy)", () => {
  it("keeps the header and first/last K rows of the real fetch-log CSV", () => {
    const raw = fixture("npm-fetch-log.csv");
    const out = compressCsv(raw, 3).split("\n");
    expect(out[0]).toBe("id,kind,status,package,duration_ms,cache");
    expect(out[1]).toMatch(/^1,/);
    expect(out[3]).toMatch(/^3,/);
    expect(out[4]).toBe("[flux: 769 rows omitted (rows 4-772 of 775)]");
    expect(out[7]).toMatch(/^775,/);
  });

  it("handles TSV and quoted delimiters", () => {
    const tsv = ["a\tb", ...Array.from({ length: 30 }, (_, i) => `${i}\tx`)].join("\n");
    expect(compressCsv(tsv, 2).split("\n")).toHaveLength(6);
    const quoted = ["name,note", ...Array.from({ length: 30 }, (_, i) => `n${i},"has, a comma"`)].join("\n");
    expect(compressCsv(quoted, 2)).toContain("[flux: 26 rows omitted");
  });

  it("leaves ragged or short tables, and prose with commas, untouched", () => {
    const ragged = ["a,b", ...Array.from({ length: 30 }, (_, i) => (i === 7 ? "1,2,3" : `${i},x`))].join("\n");
    expect(compressCsv(ragged, 2)).toBe(ragged);
    const short = ["a,b", "1,2", "3,4"].join("\n");
    expect(compressCsv(short, 2)).toBe(short);
    const prose = "Hello, world.\nThis, that.\nOne, two.";
    expect(compressToolOutput(prose, ALL).text).toBe(prose);
  });
});

describe("HTML (lossy)", () => {
  it("strips script/style/svg/comments and keeps text, headings, links and <pre> whitespace", () => {
    const html = `<!DOCTYPE html><html><head><title>Docs &amp; API</title><style>body{color:red}</style>
      <script>window.x = 1;</script></head><body><!-- nav --><svg><path d="M0 0"/></svg>
      <h2>Install</h2><p>Run the <a href="https://example.com/cli">CLI</a> or <a href="#top">jump</a>.</p>
      <pre><code>npm i  flux
  --save &lt;dev&gt;</code></pre><ul><li>one</li><li>two</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("# Docs & API");
    expect(text).toContain("## Install");
    expect(text).toContain("Run the CLI (https://example.com/cli) or jump .");
    expect(text).toContain("npm i  flux\n  --save <dev>");
    expect(text).toContain("- one\n- two");
    expect(text).not.toMatch(/color:red|window\.x|M0 0|nav/);
  });

  it("the real nodejs.org release page shrinks by more than 90% and keeps its release notes and links", () => {
    const raw = fixture("nodejs-release-v22.11.0.html");
    const result = compressToolOutput(raw, { html: true });
    expect(result.kinds).toEqual(["html"]);
    expect(result.text.length).toBeLessThan(raw.length * 0.1);
    expect(result.text).toContain("## 2024-10-29, Version 22.11.0 'Jod' (LTS), @richardlau");
    expect(result.text).toContain("Docs (https://nodejs.org/docs/latest/api/)");
    expect(result.text).not.toContain("<script");
  });

  it("an HTML fragment (not a document) is not treated as a page", () => {
    const fragment = '<div class="x">component markup the agent is editing</div>';
    expect(compressToolOutput(fragment, ALL).text).toBe(fragment);
  });
});

describe("conservative detection and guards", () => {
  it("file-read/edit tools always pass verbatim, even for JSON, logs or HTML content", () => {
    for (const name of ["Read", "read_file", "str_replace_based_edit_tool", "mcp__fs__read_file"]) {
      for (const body of [fixture("npm-jest-29.7.0.pretty.json"), fixture("jest-verbose.txt"), fixture("nodejs-release-v22.11.0.html")]) {
        const result = compressToolOutput(body, ALL, name);
        expect(result.text).toBe(body);
        expect(result.verbatimReason).toMatch(/returns file content/);
      }
    }
  });

  it("shell commands that dump a file pass verbatim (cat package.json), test runs do not (pytest | tail)", () => {
    const json = fixture("npm-jest-29.7.0.pretty.json");
    for (const command of ["cat package.json", "cd app && cat package.json | jq .", "sed -n '1,80p' src/a.ts", "head -50 data.csv"]) {
      expect(compressToolOutput(json, ALL, { name: "Bash", input: { command } }).text).toBe(json);
    }
    const jest = fixture("jest-verbose.txt");
    expect(compressToolOutput(jest, ALL, { name: "Bash", input: { command: "npx jest --verbose 2>&1 | tail -80" } }).text)
      .not.toBe(jest);
    // Chat Completions carries arguments as a JSON string.
    expect(compressToolOutput(json, ALL, { name: "shell", input: '{"command":"cat package.json"}' }).text).toBe(json);
  });

  it("numbered file listings, diffs and code fences pass verbatim", () => {
    const listing = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(6)}\tconst a${i} = ${i};`).join("\n");
    const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n" +
      Array.from({ length: 5 }, () => "+}").join("\n");
    const fenced = "Output:\n```\nPASS a\n  ✓ x\n  ✓ y\n  ✓ z\nTests:       3 passed, 3 total\n```";
    for (const body of [listing, diff, fenced]) expect(compressToolOutput(body, ALL).text).toBe(body);
  });

  it("source code printed by a non-read tool is not detected as any noisy type", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "reduce-request.ts"), "utf8");
    expect(compressToolOutput(source, ALL).text).toBe(source);
  });

  it("binary-ish bodies pass verbatim", () => {
    const binary = `PNG\u0000\u0001\u0002${"x".repeat(100)}`;
    expect(compressToolOutput(binary, ALL).verbatimReason).toMatch(/binary/);
    const garbled = Array.from({ length: 200 }, (_, i) => (i % 5 === 0 ? "\u0007" : "a")).join("");
    expect(compressToolOutput(garbled, ALL).text).toBe(garbled);
  });

  it("a huge single line is handled in linear time and left alone unless it is a known type", () => {
    const huge = "x".repeat(2_000_000);
    const started = Date.now();
    expect(compressToolOutput(huge, ALL).text).toBe(huge);
    const hugeJson = `[${Array.from({ length: 100_000 }, (_, i) => `{ "i" : ${i} , "v" : null }`).join(" , ")}]`;
    const minified = compressToolOutput(hugeJson, { json: true }).text;
    expect(JSON.parse(minified)).toEqual(JSON.parse(hugeJson));
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("mixed content: install noise then a test run in one body (cargo test after a fresh fetch)", () => {
    const mixed = `${fixture("cargo-build-color.txt")}${fixture("cargo-test.txt")}`;
    const result = compressToolOutput(mixed, ALL);
    expect(result.kinds).toEqual(expect.arrayContaining(["install", "test"]));
    expect(result.text).toContain("test result: FAILED. 25 passed; 1 failed");
    expectFailureLinesKept(mixed, result.text);
  });

  it("off by default: an empty or false config changes nothing", () => {
    const raw = fixture("jest-verbose.txt");
    expect(compressToolOutput(raw, false).text).toBe(raw);
    expect(compressToolOutput(raw, {}).text).toBe(raw);
    // `true` is the lossless tier only: a jest run has nothing lossless to remove.
    expect(compressToolOutput(raw, true).text).toBe(raw);
  });

  it("every fixture is deterministic and idempotent under the full config", () => {
    for (const name of [
      "jest-verbose.txt", "vitest-verbose.txt", "pytest-verbose.txt", "pytest-default.txt", "go-test-verbose.txt",
      "cargo-test.txt", "cargo-build-color.txt", "npm-install-loglevel-http.txt", "pnpm-add.txt", "pip-install.txt",
      "python-http-server.log", "npm-fetch-log.csv", "npm-jest-29.7.0.pretty.json", "pypi-requests.json",
      "nodejs-release-v22.11.0.html",
    ]) {
      const raw = fixture(name);
      const first = compressToolOutput(raw, ALL);
      expect(compressToolOutput(raw, ALL).text, name).toBe(first.text);
      expect(compressToolOutput(first.text, ALL).text, `${name} idempotent`).toBe(first.text);
      expect(first.text.length, name).toBeLessThanOrEqual(raw.length);
    }
  });
});

// --- Through reduceRequest ------------------------------------------------------

type AnyObject = Record<string, unknown>;

/** A growing Anthropic-shaped agent session, one request per assistant step, raw tool output re-sent each turn. */
function anthropicSession(): AnyObject[] {
  const steps: Array<{ name: string; input: AnyObject; output: string }> = [
    { name: "Bash", input: { command: "pnpm add -D jest" }, output: fixture("pnpm-add.txt") },
    { name: "Bash", input: { command: "npx jest --verbose" }, output: fixture("jest-verbose.txt") },
    { name: "Read", input: { file_path: "cart.test.js" }, output: fixture("npm-jest-29.7.0.pretty.json") },
    { name: "Bash", input: { command: "curl -s https://nodejs.org/en/blog/release/v22.11.0" }, output: fixture("nodejs-release-v22.11.0.html") },
    { name: "Bash", input: { command: "go test -v ./..." }, output: fixture("go-test-verbose.txt") },
  ];
  const requests: AnyObject[] = [];
  const messages: AnyObject[] = [{ role: "user", content: "The discount test fails in CI. Find out why and fix it." }];
  steps.forEach((step, index) => {
    const id = `toolu_${index}`;
    messages.push({ role: "assistant", content: [{ type: "text", text: `Step ${index}.` }, { type: "tool_use", id, name: step.name, input: step.input }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: step.output }] });
    requests.push({ model: "claude-sonnet-5-5", max_tokens: 1024, system: "You are a coding agent.", messages: structuredClone(messages) });
  });
  return requests;
}

describe("reduceRequest integration", () => {
  const FULL: FluxTokenReductionConfig = { toolOutputCompression: ALL };

  it("is byte-stable across turns: each request's compressed history is an exact prefix of the next one's", () => {
    const reduced = anthropicSession().map((request) => reduceRequest(request, FULL).request as AnyObject);
    for (let turn = 1; turn < reduced.length; turn += 1) {
      const previous = reduced[turn - 1]!.messages as unknown[];
      const current = reduced[turn]!.messages as unknown[];
      expect(JSON.stringify(current.slice(0, previous.length))).toBe(JSON.stringify(previous));
    }
    // And the wire text is a literal string prefix, which is what a provider's exact-prefix cache matches.
    const wire = reduced.map((request) => JSON.stringify(request.messages).slice(0, -1));
    for (let turn = 1; turn < wire.length; turn += 1) expect(wire[turn]!.startsWith(wire[turn - 1]!)).toBe(true);
  });

  it("a tool result is compressed on the turn it first appears, identically every later turn", () => {
    const requests = anthropicSession();
    const firstSeen = reduceRequest(requests[1], FULL).request as AnyObject;
    const jestOnFirstTurn = JSON.stringify((firstSeen.messages as unknown[])[4]);
    for (const later of requests.slice(2)) {
      const reduced = reduceRequest(later, FULL).request as AnyObject;
      expect(JSON.stringify((reduced.messages as unknown[])[4])).toBe(jestOnFirstTurn);
    }
    expect(jestOnFirstTurn).toContain("passing tests collapsed");
  });

  it("never touches assistant output, user text or system text, and passes Read results verbatim", () => {
    const request = anthropicSession().at(-1)!;
    const noisy = fixture("jest-verbose.txt");
    (request.messages as AnyObject[]).push({ role: "user", content: noisy });
    request.system = noisy;
    (request.messages as AnyObject[]).push({ role: "assistant", content: noisy });
    const reduced = reduceRequest(request, FULL).request as AnyObject;
    const messages = reduced.messages as AnyObject[];
    expect(reduced.system).toBe(noisy);
    expect(messages.at(-1)!.content).toBe(noisy);
    expect(messages.at(-2)!.content).toBe(noisy);
    expect(messages[1]!.content).toEqual((request.messages as AnyObject[])[1]!.content);
    // The Read tool's result (index 6) is untouched although its body is pretty JSON.
    expect(messages[6]).toEqual((request.messages as AnyObject[])[6]);
  });

  it("reports lossless and lossy savings under separate lever ids", () => {
    const request = anthropicSession().at(-1)!;
    const lossless = reduceRequest(request, { toolOutputCompression: true }).summary;
    expect(lossless.changes.map((change) => change.lever)).not.toContain("tool-output-compression-lossy");
    const full = reduceRequest(request, FULL).summary;
    const lossy = full.changes.find((change) => change.lever === "tool-output-compression-lossy");
    expect(lossy?.lossless).toBe(false);
    expect(lossy!.estimatedTokensSaved).toBeGreaterThan(1_000);
    for (const change of full.changes.filter((c) => c.lever === "tool-output-compression")) expect(change.lossless).toBe(true);
    expect(full.estimatedTokensAfter).toBeLessThan(full.estimatedTokensBefore);
  });

  it("works on Chat Completions tool messages and Responses function_call_output items", () => {
    const jest = fixture("jest-verbose.txt");
    const chat = reduceRequest({
      model: "gpt-5",
      messages: [
        { role: "user", content: "run tests" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: '{"command":"npx jest"}' } }] },
        { role: "tool", tool_call_id: "c1", content: jest },
        { role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "shell", arguments: '{"command":"cat package.json"}' } }] },
        { role: "tool", tool_call_id: "c2", content: fixture("npm-jest-29.7.0.pretty.json") },
      ],
    }, FULL).request as AnyObject;
    const chatMessages = chat.messages as AnyObject[];
    expect(String(chatMessages[2]!.content)).toContain("passing tests collapsed");
    expect(chatMessages[4]!.content).toBe(fixture("npm-jest-29.7.0.pretty.json"));

    const responses = reduceRequest({
      model: "gpt-5",
      input: [
        { role: "user", content: "run tests" },
        { type: "function_call", call_id: "r1", name: "shell", arguments: '{"command":"go test -v ./..."}' },
        { type: "function_call_output", call_id: "r1", output: fixture("go-test-verbose.txt") },
      ],
    }, FULL).request as AnyObject;
    expect(String((responses.input as AnyObject[])[2]!.output)).toContain("32 passed");
  });

  it("off unless configured", () => {
    const request = anthropicSession().at(-1)!;
    expect(reduceRequest(request, {}).summary.changes.map((c) => c.lever).filter((l) => l.startsWith("tool-output"))).toEqual([]);
  });

  it("stays byte-stable stacked with the fresh cap and history compaction", () => {
    const config: FluxTokenReductionConfig = { ...FULL, freshToolResultCap: true, countTokens: approximateTokenCount };
    const reduced = anthropicSession().map((request) => reduceRequest(request, config).request as AnyObject);
    for (let turn = 1; turn < reduced.length; turn += 1) {
      const previous = reduced[turn - 1]!.messages as unknown[];
      expect(JSON.stringify((reduced[turn]!.messages as unknown[]).slice(0, previous.length))).toBe(JSON.stringify(previous));
    }
  });
});
