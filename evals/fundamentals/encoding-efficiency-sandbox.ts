/**
 * A2 ENCODING-EFFICIENCY SANDBOX
 * ------------------------------------------------------------------
 * Measures the size of the SAME information rendered in different
 * serialization formats, to quantify the LOSSLESS (information-
 * preserving) token headroom FLUX could capture by re-serializing a
 * request body before forwarding it.
 *
 * What is MEASURED here (deterministic, reproducible):
 *   - exact UTF-8 byte count per format
 *   - exact character count per format
 *   - token count IF a tokenizer is installed (tries, in order:
 *     `gpt-tokenizer` then `js-tiktoken`); otherwise falls back to a
 *     LABELLED char/token proxy (chars / 3.6 for structured data,
 *     the o200k ~176 tok / 1000 char figure from the tokenizer
 *     deep-dive, docs/rnd/fundamentals/2026-10-28-encoding-efficiency.md).
 *
 * HONESTY: when no tokenizer is installed every token number printed
 * is DERIVED from a char proxy and tagged `[proxy]`. Install a
 * tokenizer (do NOT add it to the repo manifest for this sandbox —
 * `npm i -g gpt-tokenizer` or a throwaway dir) to get a MEASURED
 * number tagged `[tok]`.
 *
 * This sandbox does NOT prove comprehension parity. Format conversion
 * is LOSSY for FLUX billing (the model reads a different token
 * sequence and the Notation-Matters / TOON benchmarks show accuracy
 * moves with format) and must pass a replay gate. The one number this
 * harness treats as lossless-eligible is whitespace/indentation
 * removal on a format the request already uses (JSON pretty -> JSON
 * minified), because that preserves the same structure and keys.
 *
 * Run:  node --import tsx evals/fundamentals/encoding-efficiency-sandbox.ts
 */

type Row = Record<string, unknown>;

// ---- sample data: three shapes that stress the format tradeoff ----

// Shape 1: UNIFORM array of flat objects (TOON/CSV sweet spot)
const uniform: Row[] = Array.from({ length: 50 }, (_, i) => ({
  id: 1000 + i,
  sku: `SKU-${(i * 7) % 1000}`,
  name: `Widget ${i}`,
  price: Number((9.99 + i * 0.5).toFixed(2)),
  inStock: i % 3 !== 0,
  qty: (i * 13) % 97,
}));

// Shape 2: DEEPLY NESTED / non-uniform (JSON-favoured; TOON loses here)
const nested = {
  org: "acme",
  settings: {
    features: { beta: true, flags: { a: 1, b: null, c: [1, 2, { deep: "x" }] } },
    limits: { rpm: 6000, tpm: 400000, burst: { window: 60, max: 120 } },
  },
  members: [
    { id: 1, roles: ["admin", "billing"], meta: { since: "2024", tier: "gold" } },
    { id: 2, roles: ["viewer"], meta: { since: "2025" } },
  ],
};

// Shape 3: a realistic TOOL SCHEMA (function-calling), the agentic case
const toolSchema = {
  type: "function",
  function: {
    name: "search_orders",
    description:
      "Search customer orders by any combination of filters. Returns matching orders with line items.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "The customer identifier" },
        status: {
          type: "string",
          enum: ["pending", "shipped", "delivered", "cancelled", "refunded"],
          description: "Filter by order status",
        },
        date_from: { type: "string", format: "date", description: "Earliest order date (inclusive)" },
        date_to: { type: "string", format: "date", description: "Latest order date (inclusive)" },
        min_total: { type: "number", description: "Minimum order total in dollars" },
        limit: { type: "integer", description: "Max rows to return", default: 20 },
      },
      required: ["customer_id"],
    },
  },
};

// ---- serializers (all LOSSLESS round-trips of the same information) ----

function jsonPretty(x: unknown): string {
  return JSON.stringify(x, null, 2);
}
function jsonMin(x: unknown): string {
  return JSON.stringify(x);
}
// crude YAML for flat/simple structures (enough for size comparison)
function toYaml(x: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(x)) {
    return x.map((v) => `${pad}- ${toYaml(v, indent + 1).trimStart()}`).join("\n");
  }
  if (x && typeof x === "object") {
    return Object.entries(x as Row)
      .map(([k, v]) => {
        if (v && typeof v === "object") return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        return `${pad}${k}: ${String(v)}`;
      })
      .join("\n");
  }
  return `${pad}${String(x)}`;
}
// TOON-like tabular encoding for a uniform array of flat objects:
//   header declares length + field order once, rows are comma-joined values.
function toToonTable(rows: Row[]): string {
  if (rows.length === 0) return "[0]{}";
  const keys = Object.keys(rows[0]);
  const header = `[${rows.length}]{${keys.join(",")}}:`;
  const body = rows
    .map((r) => "  " + keys.map((k) => String(r[k])).join(",")).join("\n");
  return header + "\n" + body;
}
// CSV for a uniform array
function toCsv(rows: Row[]): string {
  if (rows.length === 0) return "";
  const keys = Object.keys(rows[0]);
  const head = keys.join(",");
  const body = rows.map((r) => keys.map((k) => String(r[k])).join(",")).join("\n");
  return head + "\n" + body;
}

// ---- token counting: measured if a tokenizer is present, else proxy ----

type Counter = { count: (s: string) => number; label: "tok" | "proxy"; name: string };

async function loadCounter(): Promise<Counter> {
  // try gpt-tokenizer (o200k_base, GPT-4o/5 family)
  try {
    const m: any = await import("gpt-tokenizer");
    if (typeof m.encode === "function") {
      return { count: (s) => m.encode(s).length, label: "tok", name: "gpt-tokenizer/o200k_base" };
    }
  } catch {}
  // try js-tiktoken cl100k
  try {
    const m: any = await import("js-tiktoken");
    const enc = m.getEncoding ? m.getEncoding("cl100k_base") : null;
    if (enc) return { count: (s) => enc.encode(s).length, label: "tok", name: "js-tiktoken/cl100k_base" };
  } catch {}
  // fallback: labelled proxy. 3.6 chars/token ~ o200k on structured data
  // (176 tok / 1000 chars English prose; structured data is denser in
  // punctuation so this is a conservative-ish lower bound on tokens).
  return { count: (s) => Math.round(s.length / 3.6), label: "proxy", name: "char/3.6 proxy (NO tokenizer installed)" };
}

function pct(from: number, to: number): string {
  if (from === 0) return "0.0%";
  return (((from - to) / from) * 100).toFixed(1) + "%";
}

async function main() {
  const c = await loadCounter();
  const tag = `[${c.label}]`;
  console.log(`# A2 encoding-efficiency sandbox`);
  console.log(`# token source: ${c.name}  ${tag}`);
  if (c.label === "proxy") {
    console.log(`# WARNING: all token numbers below are DERIVED from a char proxy, not measured.`);
  }
  console.log("");

  const report = (title: string, variants: Record<string, string>, baselineKey: string) => {
    console.log(`## ${title}`);
    const base = variants[baselineKey];
    const baseTok = c.count(base);
    const rows = Object.entries(variants).map(([name, s]) => {
      const tok = c.count(s);
      return { name, chars: s.length, bytes: Buffer.byteLength(s, "utf8"), tok, save: pct(baseTok, tok) };
    });
    const w = Math.max(...rows.map((r) => r.name.length));
    console.log(`  ${"format".padEnd(w)}  ${"chars".padStart(7)}  ${"bytes".padStart(7)}  ${("tok " + tag).padStart(10)}  vs ${baselineKey}`);
    for (const r of rows) {
      console.log(
        `  ${r.name.padEnd(w)}  ${String(r.chars).padStart(7)}  ${String(r.bytes).padStart(7)}  ${String(r.tok).padStart(10)}  ${r.save}`,
      );
    }
    console.log("");
  };

  report("Shape 1 - UNIFORM array (50 flat objects)", {
    "json-pretty": jsonPretty(uniform),
    "json-min": jsonMin(uniform),
    "yaml": toYaml(uniform),
    "csv": toCsv(uniform),
    "toon-table": toToonTable(uniform),
  }, "json-pretty");

  report("Shape 2 - NESTED / non-uniform (JSON-favoured)", {
    "json-pretty": jsonPretty(nested),
    "json-min": jsonMin(nested),
    "yaml": toYaml(nested),
  }, "json-pretty");

  report("Shape 3 - TOOL SCHEMA (function-calling)", {
    "json-pretty": jsonPretty(toolSchema),
    "json-min": jsonMin(toolSchema),
    "yaml": toYaml(toolSchema),
  }, "json-pretty");

  console.log(`## Reading this`);
  console.log(`- json-pretty -> json-min is the LOSSLESS lever (same keys/structure, only whitespace removed).`);
  console.log(`- yaml / csv / toon-table are LOSSY for FLUX billing: the model reads a different token`);
  console.log(`  sequence, and published benchmarks show accuracy moves with format. They require a replay gate.`);
  console.log(`- csv/toon win big on Shape 1 (uniform) and LOSE or barely help on Shape 2 (nested) - exactly`);
  console.log(`  the eligibility pattern the TOON README and the Notation-Matters paper report.`);
}

main();
