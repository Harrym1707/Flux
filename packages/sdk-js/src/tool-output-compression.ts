import type { TokenCounter } from "../../core/dist/src/index.js";

/**
 * "Read less": compress FRESH tool output by type before the model reads it.
 *
 * FLUX's other tool-result levers reach a result only once it is stale
 * (history compaction) or oversized (the fresh cap, which keeps headlines and
 * error sentences and drops the rest by position). Neither knows what KIND of
 * output it is looking at, so a 200-line test run with one failure goes in
 * almost untouched on its first, full-rate send. This module knows the
 * shapes: test-runner output, logs, package-manager/build noise, JSON, CSV/TSV
 * and HTML, and compresses each one by the structure that makes it noisy.
 *
 * Three properties carry the design, in order of importance:
 *
 *   1. PURE PER BODY. Every transform is a pure function of (tool-result text,
 *      the tool's own name, the options). Nothing depends on turn position,
 *      message count, a moving window or another body. The first time a tool
 *      result appears it is compressed; every later turn re-sends the same raw
 *      result and gets byte-identical compressed bytes back, so the provider's
 *      exact-prefix cache keeps matching. This is the explicit answer to the
 *      lever-backlog's P7 trap and the KILLED sliding-window entry: a cut
 *      schedule that re-edits already-sent bytes rewrites a cached prefix and
 *      pays 1.25x writes every turn. There is no schedule here to slide.
 *
 *   2. CONSERVATIVE DETECTION. Only obviously-noisy tool output is touched.
 *      A body is left verbatim when its tool is a file read/edit tool, when it
 *      looks like a numbered file listing, a diff, or carries a code fence, or
 *      when it is binary-ish. Structured types (JSON/HTML/CSV) must parse as
 *      that type end to end; terminal types (tests/install/logs) need a real
 *      runner or package-manager signature. Model output, user text and system
 *      text never reach this module at all (see reduce-request.ts).
 *
 *   3. HONEST LABELS. Each stage is either LOSSLESS (the information content is
 *      unchanged: JSON whitespace, ANSI colour codes, exact repeated lines
 *      collapsed with their exact count) or LOSSY (something the model could
 *      have read is gone: passing-test names, install chatter, varying
 *      timestamps, CSV middle rows, null JSON fields, HTML markup). Lossless
 *      stages always run first, so the saving splits exactly into a lossless
 *      part and a lossy increment, and the two are reported under separate
 *      lever ids. Lossy savings bill only with an approved replay-gate verdict
 *      (packages/sdk-js/src/replay-gate.ts; the ledger enforces this by lever
 *      id, see savings-ledger.ts).
 */

export type FluxToolOutputCompressionConfig = {
  /** LOSSLESS. Whitespace-only JSON minification; every token of the document is kept byte-for-byte. */
  json?: boolean;
  /** LOSSY. Drop object members whose value is null, "", [] or {} (applied recursively). */
  jsonDropEmpty?: boolean;
  /**
   * Terminal/log output. "lossless": strip ANSI colour (SGR) codes and
   * collapse runs of exactly identical lines into one line plus "(xN)".
   * `true` adds the LOSSY stages: all terminal escape sequences and
   * carriage-return overwrites resolved to what the terminal shows,
   * progress-bar lines dropped, and runs of near-identical lines (equal
   * after masking timestamps and numbers) collapsed. ERROR/WARN lines are
   * never collapsed or dropped.
   */
  logs?: boolean | "lossless";
  /** LOSSY. Collapse runs of passing tests (jest/vitest/mocha/pytest/go test/cargo test) into a count. */
  testOutput?: boolean;
  /** LOSSY. Collapse npm/pnpm/yarn/pip/cargo download and compile chatter. */
  installOutput?: boolean;
  /** LOSSY. Keep the header and first/last `keepRows` rows of a CSV/TSV body (default 10). */
  csv?: boolean | { keepRows?: number };
  /** LOSSY. Strip script/style/svg/comments and markup from an HTML document, keeping text and links. */
  html?: boolean;
  /** Extra tool names whose results must always pass through verbatim. */
  verbatimTools?: string[];
};

/** `toolOutputCompression: true` is the lossless tier only, by the same convention as `toolSchemas: true`. */
export const TOOL_OUTPUT_LOSSLESS_DEFAULTS: FluxToolOutputCompressionConfig = { json: true, logs: "lossless" };

export type ToolOutputKind = "json" | "html" | "csv" | "test" | "install" | "log";

export type ToolOutputCompression = {
  /** The body after lossless stages only. */
  lossless: string;
  /** The body after lossless then lossy stages: what is sent. */
  text: string;
  /** Detected shapes that a stage actually changed. */
  kinds: ToolOutputKind[];
  /** Why the body was left verbatim, when it was. */
  verbatimReason?: string;
};

/**
 * Tools whose output is file content an agent reads in order to edit it. Their
 * results are never compressed, whatever they contain: a "compressed" file the
 * agent then patches is how an edit tool writes garbage.
 */
const VERBATIM_TOOLS = new Set([
  "read", "read_file", "readfile", "view", "view_file", "cat", "open", "open_file", "file_read", "get_file_contents",
  "str_replace_editor", "str_replace_based_edit_tool", "text_editor", "edit", "multiedit", "write", "write_file",
  "notebookread", "notebookedit", "notebook_read",
]);

// --- Shared line helpers -----------------------------------------------------

const ANSI_SGR = /\x1b\[[0-9;:]*m/g;
// CSI (any final byte), OSC (BEL- or ST-terminated) and lone two-byte escapes.
const ANSI_ANY = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Lines that are never collapsed, merged or dropped by any stage. */
const MUST_KEEP_LINE =
  /\b(error|errors|err!|fatal|panic|panicked|exception|traceback|warn|warning|warnings|deprecated|fail|failed|failure|failures|denied|refused|timeout|timed out|critical|severe|assert|assertion|vulnerabilit(?:y|ies))\b/i;

const TIMESTAMP =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|\[\d{2}\/[A-Z][a-z]{2}\/\d{4}[ :]\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?\]|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/;
const LEVEL_PREFIX = /^\s*[[(]?(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL)[\])]?[\s:]/i;

/** A trailing exact-repeat marker this module itself writes: "<line> (xN)". */
const REPEAT_SUFFIX = / \(x(\d+)\)$/;

function multiplicity(line: string): number {
  const match = REPEAT_SUFFIX.exec(line);
  return match ? Number(match[1]) : 1;
}

function nonEmptyLines(lines: string[]): string[] {
  return lines.filter((line) => line.trim() !== "");
}

// --- Guards ------------------------------------------------------------------

/** The issuing call, as far as the request shows it: its tool name and (parsed) input. */
export type ToolCallContext = { name?: string; input?: unknown };

/** Shell commands whose output is a file's content (cat/head/sed -n/...); never compressed. */
const FILE_DUMP_COMMAND = /^(?:sudo\s+)?(?:cat|head|tail|less|more|bat|batcat|nl|sed|awk|view|type|get-content|gc|xxd|od|hexdump|strings)\b/i;

function shellCommandOf(input: unknown): string | undefined {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return value as string;
    }
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["command", "cmd", "script", "shell"]) {
      const field = record[key];
      if (typeof field === "string") return field;
      if (Array.isArray(field) && field.every((part) => typeof part === "string")) return field.join(" ");
    }
  }
  return undefined;
}

/**
 * Whether a shell command dumps a file. Any statement (split on && || ; and
 * newlines, NOT on pipes) that starts with a file-dumping program counts:
 * "cat package.json | jq ." is still a file the agent may edit next, while
 * "pytest | tail -50" is a test run.
 */
function dumpsFile(command: string): boolean {
  return command.split(/&&|\|\||;|\n/).some((statement) => {
    const words = statement.trim().replace(/^\(+/, "");
    return FILE_DUMP_COMMAND.test(words);
  });
}

function verbatimReason(text: string, call: ToolCallContext, extraTools: string[]): string | undefined {
  const toolName = call.name;
  if (call.input !== undefined) {
    const command = shellCommandOf(call.input);
    if (command !== undefined && dumpsFile(command)) return "the command dumps a file's content";
  }
  if (toolName !== undefined) {
    const name = toolName.toLowerCase();
    // MCP-prefixed names (mcp__server__read_file) end in the tool's own name.
    const bare = name.split("__").at(-1) ?? name;
    if (VERBATIM_TOOLS.has(name) || VERBATIM_TOOLS.has(bare) ||
        extraTools.some((tool) => tool.toLowerCase() === name)) {
      return `tool "${toolName}" returns file content`;
    }
  }
  if (text.includes("\u0000")) return "binary-ish (NUL bytes)";
  let control = 0;
  let replacement = 0;
  const sample = text.length > 65_536 ? text.slice(0, 65_536) : text;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 0xfffd) replacement += 1;
    else if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 27) control += 1;
  }
  if (sample.length > 0 && (control + replacement) / sample.length > 0.01) return "binary-ish (control characters)";
  if (/^\s*```/m.test(text)) return "contains a code fence";
  if (/^(?:diff --git |--- a\/|\+\+\+ b\/|@@ -\d+(?:,\d+)? \+\d+)/m.test(text)) return "looks like a diff";
  const lines = nonEmptyLines(text.split("\n"));
  if (lines.length >= 3) {
    const numbered = lines.filter((line) => /^\s*\d+(?:\t|→)/.test(line)).length;
    if (numbered / lines.length >= 0.5) return "looks like a numbered file listing";
  }
  return undefined;
}

// --- JSON --------------------------------------------------------------------

function looksLikeJson(trimmed: string): boolean {
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove whitespace outside string literals. Every literal, key and number is
 * kept byte-for-byte (no re-serialisation: big integers, 1.0 vs 1, escape
 * spellings and duplicate keys all survive), so the decoded document is
 * identical. Input must already be valid JSON.
 */
export function minifyJsonWhitespace(json: string): string {
  let out = "";
  let start = 0;
  let index = 0;
  const length = json.length;
  while (index < length) {
    const char = json[index]!;
    if (char === '"') {
      index += 1;
      while (index < length && json[index] !== '"') index += json[index] === "\\" ? 2 : 1;
      index += 1;
      continue;
    }
    if (char === " " || char === "\n" || char === "\r" || char === "\t") {
      out += json.slice(start, index);
      while (index < length && /[ \n\r\t]/.test(json[index]!)) index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
  return out + json.slice(start);
}

type JsonNode =
  | { kind: "object"; members: Array<{ key: string; value: JsonNode }> }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "literal"; raw: string };

/** Parse minified JSON into a tree that keeps every literal's raw spelling. */
function parseRawJson(json: string): JsonNode {
  let index = 0;
  const readString = (): string => {
    const begin = index;
    index += 1;
    while (json[index] !== '"') index += json[index] === "\\" ? 2 : 1;
    index += 1;
    return json.slice(begin, index);
  };
  const readValue = (): JsonNode => {
    const char = json[index];
    if (char === "{") {
      index += 1;
      const members: Array<{ key: string; value: JsonNode }> = [];
      while (json[index] !== "}") {
        const key = readString();
        index += 1; // ':'
        members.push({ key, value: readValue() });
        if (json[index] === ",") index += 1;
      }
      index += 1;
      return { kind: "object", members };
    }
    if (char === "[") {
      index += 1;
      const items: JsonNode[] = [];
      while (json[index] !== "]") {
        items.push(readValue());
        if (json[index] === ",") index += 1;
      }
      index += 1;
      return { kind: "array", items };
    }
    if (char === '"') return { kind: "literal", raw: readString() };
    const begin = index;
    while (index < json.length && !",]}".includes(json[index]!)) index += 1;
    return { kind: "literal", raw: json.slice(begin, index) };
  };
  return readValue();
}

function isEmptyNode(node: JsonNode): boolean {
  if (node.kind === "literal") return node.raw === "null" || node.raw === '""';
  if (node.kind === "array") return node.items.length === 0;
  return node.members.length === 0;
}

function pruneEmpty(node: JsonNode, state: { dropped: number }): JsonNode {
  if (node.kind === "array") return { kind: "array", items: node.items.map((item) => pruneEmpty(item, state)) };
  if (node.kind === "literal") return node;
  const members: Array<{ key: string; value: JsonNode }> = [];
  for (const member of node.members) {
    const value = pruneEmpty(member.value, state);
    if (isEmptyNode(value)) state.dropped += 1;
    else members.push({ key: member.key, value });
  }
  return { kind: "object", members };
}

function serializeRawJson(node: JsonNode): string {
  if (node.kind === "literal") return node.raw;
  if (node.kind === "array") return `[${node.items.map(serializeRawJson).join(",")}]`;
  return `{${node.members.map((member) => `${member.key}:${serializeRawJson(member.value)}`).join(",")}}`;
}

/** LOSSY: drop null/empty members. Appends a marker line, so the result is no longer re-detected as JSON. */
export function dropEmptyJsonFields(minified: string): string {
  const state = { dropped: 0 };
  const pruned = serializeRawJson(pruneEmpty(parseRawJson(minified), state));
  if (state.dropped === 0) return minified;
  return `${pruned}\n[flux: ${state.dropped} null/empty JSON field(s) dropped]`;
}

// --- CSV / TSV ---------------------------------------------------------------

function countFields(line: string, delimiter: string): number | undefined {
  let fields = 1;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      fields += 1;
    }
  }
  return quoted ? undefined : fields;
}

/** Every line must carry the header's field count (at least 2) for the body to count as a table. */
function detectDelimitedTable(text: string, minimumRows: number): { lines: string[]; trailingNewline: boolean } | undefined {
  const trailingNewline = text.endsWith("\n");
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length - 1 < minimumRows) return undefined;
  for (const delimiter of [",", "\t"]) {
    const header = countFields(lines[0]!, delimiter);
    if (header === undefined || header < 2) continue;
    if (lines.every((line) => line !== "" && countFields(line, delimiter) === header)) {
      return { lines, trailingNewline };
    }
  }
  return undefined;
}

export function compressCsv(text: string, keepRows: number): string {
  const table = detectDelimitedTable(text, 2 * keepRows + 5);
  if (!table) return text;
  const { lines, trailingNewline } = table;
  const rows = lines.length - 1;
  const omitted = rows - 2 * keepRows;
  const out = [
    lines[0]!,
    ...lines.slice(1, 1 + keepRows),
    `[flux: ${omitted} rows omitted (rows ${keepRows + 1}-${rows - keepRows} of ${rows})]`,
    ...lines.slice(lines.length - keepRows),
  ].join("\n");
  return trailingNewline ? `${out}\n` : out;
}

// --- HTML --------------------------------------------------------------------

function looksLikeHtmlDocument(trimmed: string): boolean {
  return /^(?:﻿)?(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype html|<html[\s>])/i.test(trimmed);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * LOSSY: an HTML document reduced to readable text. Script, style, svg,
 * template, noscript, head (except the title) and comments are removed; block
 * elements become line breaks, headings keep a "#" prefix, list items a "- ",
 * and every link keeps its target as "text (href)". <pre> contents keep their
 * whitespace, so code samples on a fetched page survive as written.
 */
export function htmlToText(html: string): string {
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim();
  body = body
    .replace(/<head[\s>][\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style|svg|template|noscript|iframe|object|canvas)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|svg|link|meta|base)\b[^>]*\/?>/gi, "");
  const pres: string[] = [];
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_whole, inner: string) => {
    pres.push(decodeEntities(inner.replace(/<[^>]+>/g, "")));
    return `\n\u0000${pres.length - 1}\u0000\n`;
  });
  body = body
    .replace(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_whole, _quoted, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => {
        const href = decodeEntities(dq ?? sq ?? bare ?? "");
        const label = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (label === "") return " ";
        if (href === "" || href.startsWith("#") || /^javascript:/i.test(href) || href === decodeEntities(label)) {
          return ` ${label} `;
        }
        return ` ${label} (${href}) `;
      })
    .replace(/<h([1-6])\b[^>]*>/gi, (_whole, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(?:br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(?:p|div|section|article|header|footer|nav|main|aside|ul|ol|table|thead|tbody|tr|blockquote|dl|dt|dd|figure|figcaption|form|h[1-6]|details|summary)\b[^>]*>/gi, "\n")
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);
  const lines = body.split("\n").map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim());
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line === "" && (collapsed.length === 0 || collapsed[collapsed.length - 1] === "")) continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === "") collapsed.pop();
  let text = collapsed.join("\n").replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => pres[Number(index)] ?? "");
  if (title !== undefined && title !== "") text = `# ${decodeEntities(title)}\n\n${text}`;
  return `[flux: HTML document converted to text; markup, scripts, styles and svg removed]\n${text}`;
}

// --- Terminal output: tests, install/build, logs --------------------------------

const PASS_LINE: RegExp[] = [
  /^\s*[✓✔√]\s+\S/, // jest/vitest/mocha verbose
  /^\s*PASS\s+\S/, // jest per-file header
  /^\S+::\S.*\sPASSED(?:\s+\[\s*\d+%\])?\s*$/, // pytest -v
  /^\S+\.py\s+\.+\s+\[\s*\d+%\]\s*$/, // pytest default, an all-pass progress line
  /^\s*--- PASS: \S/, // go test -v
  /^=== (?:RUN|PAUSE|CONT|NAME)\s+\S/, // go test -v bookkeeping
  /^test \S+ \.\.\. ok$/, // cargo test
];

const TEST_SIGNATURE: RegExp[] = [
  /^\s*Tests?:\s+.*\d+ (?:passed|failed|total)/m, // jest
  /^\s*Test Files\s+\d+/m, // vitest
  /^=+ test session starts =+$/m, // pytest
  /^=+ .*\b\d+ (?:passed|failed|errors?)\b.* in [\d.]+s.* =+$/m, // pytest
  /^--- (?:PASS|FAIL): /m, // go
  /^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\))/m, // go package summary
  /^test result: (?:ok|FAILED)\. \d+ passed/m, // cargo
  /^\s*\d+ passing \(\d+/m, // mocha
];

const INSTALL_LINE: RegExp[] = [
  /^npm (?:http|timing|sill|silly|verb|verbose) /, // npm --loglevel http/verbose chatter
  /^Progress: resolved \d+, reused \d+, downloaded \d+, added \d+/, // pnpm
  /^\++$/, // pnpm "Packages: +N" bar
  /^\[\d+\/\d+\] (?:Resolving|Fetching|Linking|Building)/, // yarn classic
  /^\s*(?:Collecting|Downloading|Using cached|Obtaining|Requirement already satisfied:|Preparing metadata|Building wheel for|Created wheel for|Stored in directory:|Looking in indexes:|Installing build dependencies|Getting requirements to build)\b/, // pip
  /^\s*(?:Downloading|Downloaded|Compiling|Fresh|Checking|Updating|Locking|Adding|Blocking|Unpacking|Documenting)\s+\S/, // cargo
];

const PROGRESS_LINE: RegExp[] = [
  /[━█▓▒░■▇▆▅▄▃▂▁⣿]{5,}/, // pip/rich, tqdm, npm/yarn bars
  /\[[=#>\-. ]{6,}\]\s*\d{1,3}(?:\.\d+)?%/, // [=====>    ] 45%
  /^\s*\d{1,3}(?:\.\d+)?%\s*\|[^|]*\|/, // tqdm "45%|████  |"
];

function matchesAny(line: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(line));
}

function isPassLine(line: string): boolean {
  const bare = line.replace(REPEAT_SUFFIX, "");
  return !/\b(?:FAIL|FAILED|ERROR)\b|✕|×/.test(bare) && matchesAny(bare, PASS_LINE);
}

function isInstallLine(line: string): boolean {
  return !MUST_KEEP_LINE.test(line) && matchesAny(line.replace(REPEAT_SUFFIX, ""), INSTALL_LINE);
}

function isProgressLine(line: string): boolean {
  return !MUST_KEEP_LINE.test(line) && matchesAny(line, PROGRESS_LINE);
}

function terminalShape(text: string, lines: string[]): { test: boolean; install: boolean; log: boolean } {
  const test = matchesAny(text, TEST_SIGNATURE) && lines.filter(isPassLine).length >= 3;
  const install = lines.filter(isInstallLine).length >= 5;
  const meaningful = nonEmptyLines(lines);
  const stamped = meaningful.filter((line) => TIMESTAMP.test(line) || LEVEL_PREFIX.test(line)).length;
  const log = meaningful.length >= 5 && stamped / meaningful.length >= 0.6;
  return { test, install, log };
}

/** LOSSLESS: collapse runs (>=3) of exactly identical, non-must-keep, non-empty lines. */
function collapseIdenticalRuns(lines: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const run = end - index;
    if (run >= 3 && line.trim() !== "" && !MUST_KEEP_LINE.test(line)) out.push(`${line} (x${run})`);
    else for (let copy = index; copy < end; copy += 1) out.push(lines[copy]!);
    index = end;
  }
  return out;
}

function nearIdenticalKey(line: string): string {
  return line
    .replace(new RegExp(TIMESTAMP.source, "g"), "<ts>")
    .replace(/\b[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>");
}

/** LOSSY: collapse runs (>=3) of lines equal after masking timestamps/numbers. The first line is kept. */
function collapseNearIdenticalRuns(lines: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "" || MUST_KEEP_LINE.test(line) || REPEAT_SUFFIX.test(line) || line.startsWith("[flux:")) {
      out.push(line);
      index += 1;
      continue;
    }
    const key = nearIdenticalKey(line);
    let end = index + 1;
    while (end < lines.length && !MUST_KEEP_LINE.test(lines[end]!) && !REPEAT_SUFFIX.test(lines[end]!) &&
      nearIdenticalKey(lines[end]!) === key) end += 1;
    const run = end - index;
    if (run >= 3 && key !== line) out.push(`${line} (x${run}, timestamps/numbers vary)`);
    else for (let copy = index; copy < end; copy += 1) out.push(lines[copy]!);
    index = end;
  }
  return out;
}

/** go test's "=== RUN/PAUSE/CONT" lines: bookkeeping, not a verdict. */
const TEST_BOOKKEEPING = /^=== (?:RUN|PAUSE|CONT|NAME)\s+\S/;

/**
 * LOSSY: runs (>=2) of passing-test lines become one indented count marker.
 * A run never swallows a trailing "=== RUN" line: that line opens the next
 * test, which may be the one that fails, so it stays verbatim as context.
 */
function collapsePassingTests(lines: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!isPassLine(lines[index]!)) {
      out.push(lines[index]!);
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && isPassLine(lines[end]!)) end += 1;
    while (end > index && TEST_BOOKKEEPING.test(lines[end - 1]!)) end -= 1;
    if (end - index >= 2) {
      let passed = 0;
      for (let line = index; line < end; line += 1) {
        if (!TEST_BOOKKEEPING.test(lines[line]!)) passed += multiplicity(lines[line]!);
      }
      const indent = /^\s*/.exec(lines[index]!)![0];
      out.push(`${indent}[flux: ${end - index} line(s) of passing tests collapsed: ${passed} passed]`);
    } else {
      for (let line = index; line < Math.max(end, index + 1); line += 1) out.push(lines[line]!);
      end = Math.max(end, index + 1);
    }
    index = end;
  }
  return out;
}

/** LOSSY: runs (>=3) of package-manager chatter become a count marker plus the run's last line. */
function collapseInstallNoise(lines: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!isInstallLine(lines[index]!)) {
      out.push(lines[index]!);
      index += 1;
      continue;
    }
    let end = index;
    let count = 0;
    while (end < lines.length && isInstallLine(lines[end]!)) {
      count += multiplicity(lines[end]!);
      end += 1;
    }
    if (end - index >= 3) {
      out.push(`[flux: ${count - multiplicity(lines[end - 1]!)} package-manager/build progress line(s) collapsed]`);
      out.push(lines[end - 1]!);
    } else {
      for (let line = index; line < end; line += 1) out.push(lines[line]!);
    }
    index = end;
  }
  return out;
}

/** What a terminal shows for a line rewritten with carriage returns: the last non-empty segment. */
function resolveCarriageReturns(line: string): string {
  const crlf = line.endsWith("\r");
  const body = crlf ? line.slice(0, -1) : line;
  if (!body.includes("\r")) return line;
  const segments = body.split("\r").filter((segment) => segment !== "");
  const shown = segments.length > 0 ? segments[segments.length - 1]! : "";
  return crlf ? `${shown}\r` : shown;
}

// --- Driver --------------------------------------------------------------------

type Resolved = {
  json: boolean;
  jsonDropEmpty: boolean;
  logsLossless: boolean;
  logsLossy: boolean;
  testOutput: boolean;
  installOutput: boolean;
  csvKeepRows: number | undefined;
  html: boolean;
  verbatimTools: string[];
};

export function resolveToolOutputCompression(config: boolean | FluxToolOutputCompressionConfig): Resolved {
  const options = config === true ? TOOL_OUTPUT_LOSSLESS_DEFAULTS : config === false ? {} : config;
  let csvKeepRows: number | undefined;
  if (options.csv) {
    csvKeepRows = typeof options.csv === "object" && options.csv.keepRows !== undefined ? options.csv.keepRows : 10;
    if (!Number.isInteger(csvKeepRows) || csvKeepRows < 1) {
      throw new Error("toolOutputCompression csv keepRows must be a positive integer.");
    }
  }
  return {
    json: options.json === true,
    jsonDropEmpty: options.jsonDropEmpty === true,
    logsLossless: options.logs === true || options.logs === "lossless",
    logsLossy: options.logs === true,
    testOutput: options.testOutput === true,
    installOutput: options.installOutput === true,
    csvKeepRows,
    html: options.html === true,
    verbatimTools: options.verbatimTools ?? [],
  };
}

/**
 * Compress one tool-result body. Pure: the same (text, tool call, options)
 * always yields the same bytes, which is the whole cache-safety argument.
 * Returns the lossless-only body alongside the final one so a caller can
 * attribute the saving honestly between the two tiers.
 */
export function compressToolOutput(
  text: string,
  options: boolean | FluxToolOutputCompressionConfig | Resolved,
  tool?: string | ToolCallContext,
): ToolOutputCompression {
  const resolved = typeof options === "object" && "logsLossless" in options
    ? options
    : resolveToolOutputCompression(options as boolean | FluxToolOutputCompressionConfig);
  const call: ToolCallContext = typeof tool === "string" ? { name: tool } : tool ?? {};
  const verbatim = verbatimReason(text, call, resolved.verbatimTools);
  if (verbatim) return { lossless: text, text, kinds: [], verbatimReason: verbatim };

  const trimmed = text.trim();
  const kinds: ToolOutputKind[] = [];

  // Structured types first: each must parse as that type end to end.
  if (looksLikeJson(trimmed)) {
    if (!resolved.json && !resolved.jsonDropEmpty) return { lossless: text, text, kinds };
    const minified = minifyJsonWhitespace(trimmed);
    const lossless = resolved.json && minified.length < text.length ? minified : text;
    let sent = lossless;
    if (resolved.jsonDropEmpty) {
      // The pruned document is emitted minified; with `json` off that
      // whitespace saving is attributed to the lossy tier, never the lossless.
      const pruned = dropEmptyJsonFields(minified);
      if (pruned !== minified && pruned.length < sent.length) sent = pruned;
    }
    if (sent !== text) kinds.push("json");
    return { lossless, text: sent, kinds };
  }
  if (looksLikeHtmlDocument(trimmed)) {
    if (!resolved.html) return { lossless: text, text, kinds };
    const converted = htmlToText(text);
    if (converted.length >= text.length) return { lossless: text, text, kinds };
    return { lossless: text, text: converted, kinds: ["html"] };
  }
  if (resolved.csvKeepRows !== undefined) {
    const compressed = compressCsv(text, resolved.csvKeepRows);
    if (compressed !== text) return { lossless: text, text: compressed, kinds: ["csv"] };
  }

  // Terminal output.
  const anyTerminal = resolved.logsLossless || resolved.testOutput || resolved.installOutput;
  if (!anyTerminal) return { lossless: text, text, kinds };

  // LOSSLESS tier: colour codes and exact repeats.
  let current = resolved.logsLossless ? text.replace(ANSI_SGR, "") : text;
  let lines = current.split("\n");
  const shape = terminalShape(current, lines);
  const terminal = shape.test || shape.install || shape.log;
  if (resolved.logsLossless && terminal) lines = collapseIdenticalRuns(lines);
  const lossless = lines.join("\n");
  if (lossless !== text) kinds.push("log");

  // LOSSY tier.
  // Escape sequences and carriage-return overwrites are terminal evidence in
  // themselves; any other body keeps its bytes.
  if (resolved.logsLossy && (terminal || text.includes("\x1b"))) {
    const stripped = lines.map((line) => resolveCarriageReturns(line.replace(ANSI_ANY, "")));
    if (terminal) {
      let dropped = 0;
      lines = stripped.filter((line) => {
        if (!isProgressLine(line)) return true;
        dropped += 1;
        return false;
      });
      if (dropped > 0) lines.push(`[flux: ${dropped} progress-bar line(s) dropped]`);
    } else {
      lines = stripped;
    }
  }
  if (resolved.testOutput && shape.test) {
    const next = collapsePassingTests(lines);
    if (next.length !== lines.length) kinds.push("test");
    lines = next;
  }
  if (resolved.installOutput && shape.install) {
    const next = collapseInstallNoise(lines);
    if (next.length !== lines.length) kinds.push("install");
    lines = next;
  }
  if (resolved.logsLossy && terminal) {
    const next = collapseNearIdenticalRuns(lines);
    if (next.length !== lines.length && !kinds.includes("log")) kinds.push("log");
    lines = next;
  }
  current = lines.join("\n");
  // A lossy pass that does not beat the lossless body is not worth its risk.
  const final = current.length < lossless.length ? current : lossless;
  if (final.length >= text.length) return { lossless: text, text, kinds: [] };
  return { lossless, text: final, kinds: final === lossless ? (lossless === text ? [] : ["log"]) : kinds };
}

export type ToolOutputCompressionTally = {
  bodies: number;
  losslessTokensSaved: number;
  lossyTokensSaved: number;
  byKind: Partial<Record<ToolOutputKind, number>>;
};

export function emptyTally(): ToolOutputCompressionTally {
  return { bodies: 0, losslessTokensSaved: 0, lossyTokensSaved: 0, byKind: {} };
}

/** Compress a body and add its lossless/lossy token split to a tally. */
export function compressAndTally(
  text: string,
  options: Resolved,
  tool: ToolCallContext,
  countTokens: TokenCounter,
  tally: ToolOutputCompressionTally,
): string {
  const result = compressToolOutput(text, options, tool);
  if (result.text === text) return text;
  const before = countTokens(text);
  const afterLossless = result.lossless === text ? before : countTokens(result.lossless);
  const after = countTokens(result.text);
  tally.bodies += 1;
  tally.losslessTokensSaved += Math.max(0, before - afterLossless);
  tally.lossyTokensSaved += Math.max(0, afterLossless - after);
  for (const kind of result.kinds) tally.byKind[kind] = (tally.byKind[kind] ?? 0) + 1;
  return result.text;
}
