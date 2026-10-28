import { approximateTokenCount, type TokenCounter } from "./token-reduction.js";

/**
 * Tool and MCP schema minification: the largest lever on agentic workloads.
 *
 * Tool catalogues are resent on every turn because the APIs are stateless, so a
 * 20-turn task pays for the whole catalogue 20 times. Measured on the sample
 * fixtures the catalogue was 66% of a request's input.
 *
 * Minification is split into two tiers and the distinction is not cosmetic.
 *
 *   Lossless: JSON formatting, schema plumbing the model does not read
 *   ($schema, $id, $comment), and `title` fields that only restate the property
 *   name. The decoded schema is semantically identical, so tool selection cannot
 *   change. This is billable without a quality gate.
 *
 *   Lossy: descriptions, examples, and dropping tools. Descriptions are how the
 *   model decides which tool to call, so trimming them is a behaviour change,
 *   not a formatting change. Published sources report the large savings here,
 *   but they belong behind a replay check.
 *
 * An earlier version of this project's savings model labelled description
 * trimming "deterministic". That was wrong, and it is the kind of error that
 * turns into a disputed invoice: the saving is real, the no-quality-risk claim
 * attached to it was not.
 *
 * `$defs`/`definitions` (pydantic v2's and v1's names for the same mechanism;
 * also emitted by OpenAPI-derived generators) are a related trap this module
 * used to fall into: they hold real type definitions addressed by `$ref`
 * elsewhere in the schema, not decoration. Dropping the whole container
 * because "the model never reads $defs" is false when a `$ref` still points
 * into it — the model reads it to resolve the pointer, and dropping it leaves
 * a dangling reference, i.e. the request still validates as JSON but the
 * model can no longer see what shape a referenced nested object has. Only
 * UNREFERENCED entries within the container are true plumbing.
 */

/** Keys the provider's schema validator reads but the model never sees as prose. */
const PLUMBING_KEYS = new Set(["$schema", "$id", "$comment"]);

/**
 * Definition-container keys used by `$ref`. Pydantic v2's `.model_json_schema()`
 * emits `$defs`; pydantic v1's `.schema()` and OpenAPI-derived generators emit the
 * older draft-07 `definitions`. Both hold real type definitions for nested models,
 * addressed elsewhere in the same schema via `$ref: "#/$defs/Name"` (or
 * `#/definitions/Name`) — they are not decorative the way `$schema`/`$id`/`$comment`
 * are. An earlier version of this minifier treated `$defs` as plumbing and dropped
 * it unconditionally, which left `$ref` pointers dangling: the model would see a
 * property typed only as `{"$ref": "#/$defs/Customer"}` with no definition of what
 * a Customer is anywhere in the request. That is not lossless minification, it is
 * schema corruption that happens to still be valid JSON.
 */
const DEFINITION_CONTAINER_KEYS = new Set(["$defs", "definitions"]);

/** Every name a `$ref` in this subtree points at, e.g. "Customer" from "#/$defs/Customer". */
function collectReferencedDefinitionNames(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectReferencedDefinitionNames(item, into);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") {
      const match = /(?:\$defs|definitions)\/([^/]+)/.exec(value);
      if (match?.[1] !== undefined) into.add(match[1]);
      continue;
    }
    collectReferencedDefinitionNames(value, into);
  }
}

export type MinifyOptions = {
  /**
   * What to do with description fields.
   * `keep` stays lossless. `truncate` clips to `maximumDescriptionTokens`.
   * `drop` removes them, which is the largest saving and the largest risk.
   */
  descriptions?: "keep" | "truncate" | "drop";
  maximumDescriptionTokens?: number;
  /** Remove `examples` arrays. The model does read these, so this is lossy. */
  dropExamples?: boolean;
  /** Tool names to keep. Omit to keep all; naming a subset is lossy. */
  keepTools?: readonly string[];
  countTokens?: TokenCounter;
};

export type MinifyChange = {
  kind: "plumbing" | "redundant-title" | "formatting" | "description" | "examples" | "dropped-tool";
  lossless: boolean;
  /** Where in the catalogue, e.g. a tool name or a property path. */
  at: string;
  tokensSaved: number;
  detail: string;
};

export type MinifyResult = {
  tools: unknown[];
  tokensBefore: number;
  tokensAfter: number;
  /** Tokens removed without any possibility of changing tool selection. */
  losslessTokensSaved: number;
  /** Tokens removed by altering what the model reads. Needs a replay check. */
  lossyTokensSaved: number;
  changes: MinifyChange[];
};

function toolNameOf(tool: unknown, index: number): string {
  if (typeof tool === "object" && tool !== null) {
    const row = tool as Record<string, unknown>;
    const direct = typeof row.name === "string" ? row.name : undefined;
    const nested = typeof row.function === "object" && row.function !== null
      ? (row.function as Record<string, unknown>).name
      : undefined;
    return direct ?? (typeof nested === "string" ? nested : `tool-${index}`);
  }
  return `tool-${index}`;
}

function truncateToTokens(text: string, limit: number, countTokens: TokenCounter): string {
  if (countTokens(text) <= limit) return text;
  // Clip on a sentence boundary where one is available, so the remaining text
  // still reads as an instruction rather than breaking mid-clause.
  const sentences = text.split(/(?<=[.!?])\s+/);
  let kept = "";
  for (const sentence of sentences) {
    const candidate = kept === "" ? sentence : `${kept} ${sentence}`;
    if (countTokens(candidate) > limit) break;
    kept = candidate;
  }
  if (kept !== "") return kept;
  const words = text.split(/\s+/);
  let fallback = "";
  for (const word of words) {
    const candidate = fallback === "" ? word : `${fallback} ${word}`;
    if (countTokens(candidate) > limit) break;
    fallback = candidate;
  }
  return fallback;
}

/**
 * Minify a tool catalogue, reporting every change and which tier it belongs to.
 *
 * Defaults are lossless only: descriptions are kept. A caller wanting the large
 * saving opts into it explicitly and gets it reported as lossy.
 */
export function minifyToolSchemas(tools: unknown[], options: MinifyOptions = {}): MinifyResult {
  if (!Array.isArray(tools)) throw new Error("A tool catalogue must be an array.");
  const countTokens = options.countTokens ?? approximateTokenCount;
  const descriptions = options.descriptions ?? "keep";
  const maximumDescriptionTokens = options.maximumDescriptionTokens ?? 24;
  if (!Number.isInteger(maximumDescriptionTokens) || maximumDescriptionTokens < 1) {
    throw new Error("maximumDescriptionTokens must be a positive integer.");
  }
  const changes: MinifyChange[] = [];
  const tokensBefore = countTokens(JSON.stringify(tools, null, 2));

  const keep = options.keepTools === undefined ? undefined : new Set(options.keepTools);
  const retained: unknown[] = [];

  // Which `$defs`/`definitions` entries are still pointed at by some `$ref` in
  // THIS tool. Recomputed per tool below, read by `prune` via closure. The
  // check is reference-string presence in the tool's original (unpruned) JSON,
  // not true reachability from the schema root: a definition referenced only
  // from inside another dead, unreferenced definition is still kept. That is
  // deliberately conservative — it never drops a definition a live `$ref`
  // needs, at the cost of occasionally keeping a few bytes of truly dead
  // definitions. Correctness over maximal compression.
  let referencedDefinitionNames = new Set<string>();

  tools.forEach((tool, index) => {
    const name = toolNameOf(tool, index);
    if (keep !== undefined && !keep.has(name)) {
      changes.push({
        kind: "dropped-tool",
        lossless: false,
        at: name,
        tokensSaved: countTokens(JSON.stringify(tool)),
        detail: "Tool removed from the catalogue. The model cannot call what it cannot see, so this " +
          "is safe only where the tool is genuinely unreachable for the workload.",
      });
      return;
    }
    referencedDefinitionNames = new Set();
    collectReferencedDefinitionNames(tool, referencedDefinitionNames);
    retained.push(prune(tool, name));
  });

  function prune(node: unknown, path: string): unknown {
    if (Array.isArray(node)) return node.map((item, index) => prune(item, `${path}[${index}]`));
    if (typeof node !== "object" || node === null) return node;
    const row = node as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (DEFINITION_CONTAINER_KEYS.has(key) && typeof value === "object" && value !== null &&
        !Array.isArray(value)) {
        const definitions = value as Record<string, unknown>;
        const kept: Record<string, unknown> = {};
        for (const [defName, defValue] of Object.entries(definitions)) {
          if (referencedDefinitionNames.has(defName)) {
            kept[defName] = prune(defValue, `${path}.${key}.${defName}`);
          } else {
            changes.push({
              kind: "plumbing",
              lossless: true,
              at: `${path}.${key}.${defName}`,
              tokensSaved: countTokens(JSON.stringify({ [defName]: defValue })),
              detail: `Removed unused definition "${defName}" from ${key}; no "$ref" in this tool points to it.`,
            });
          }
        }
        if (Object.keys(kept).length > 0) output[key] = kept;
        continue;
      }
      if (PLUMBING_KEYS.has(key)) {
        changes.push({
          kind: "plumbing",
          lossless: true,
          at: `${path}.${key}`,
          tokensSaved: countTokens(JSON.stringify({ [key]: value })),
          detail: `Removed ${key}, which the model never reads.`,
        });
        continue;
      }
      if (key === "title" && typeof value === "string") {
        const leaf = path.split(".").pop() ?? "";
        // A title that only restates its own property name carries no information.
        if (value.toLowerCase().replace(/[^a-z0-9]/g, "") === leaf.toLowerCase().replace(/[^a-z0-9]/g, "")) {
          changes.push({
            kind: "redundant-title",
            lossless: true,
            at: `${path}.title`,
            tokensSaved: countTokens(JSON.stringify({ title: value })),
            detail: `Removed title "${value}", which restates the property name.`,
          });
          continue;
        }
      }
      if (key === "examples" && options.dropExamples) {
        changes.push({
          kind: "examples",
          lossless: false,
          at: `${path}.examples`,
          tokensSaved: countTokens(JSON.stringify({ examples: value })),
          detail: "Removed examples. The model does read these when choosing arguments.",
        });
        continue;
      }
      if (key === "description" && typeof value === "string" && descriptions !== "keep") {
        if (descriptions === "drop") {
          changes.push({
            kind: "description",
            lossless: false,
            at: `${path}.description`,
            tokensSaved: countTokens(JSON.stringify({ description: value })),
            detail: "Removed description. Descriptions are how the model chooses between tools.",
          });
          continue;
        }
        const trimmed = truncateToTokens(value, maximumDescriptionTokens, countTokens);
        if (trimmed !== value) {
          changes.push({
            kind: "description",
            lossless: false,
            at: `${path}.description`,
            tokensSaved: countTokens(value) - countTokens(trimmed),
            detail: `Truncated description from ${countTokens(value)} to ${countTokens(trimmed)} tokens.`,
          });
        }
        output[key] = trimmed;
        continue;
      }
      output[key] = prune(value, `${path}.${key}`);
    }
    return output;
  }

  // Compact encoding is the remaining lossless win: the decoded value is identical.
  const compact = JSON.stringify(retained);
  const tokensAfter = countTokens(compact);
  const prettyAfter = countTokens(JSON.stringify(retained, null, 2));
  if (prettyAfter > tokensAfter) {
    changes.push({
      kind: "formatting",
      lossless: true,
      at: "catalogue",
      tokensSaved: prettyAfter - tokensAfter,
      detail: "Serialised without indentation. The decoded schema is identical.",
    });
  }

  return {
    tools: retained,
    tokensBefore,
    tokensAfter,
    losslessTokensSaved: changes.filter((change) => change.lossless)
      .reduce((sum, change) => sum + change.tokensSaved, 0),
    lossyTokensSaved: changes.filter((change) => !change.lossless)
      .reduce((sum, change) => sum + change.tokensSaved, 0),
    changes,
  };
}

export type ToolCatalogueAudit = {
  tools: number;
  tokens: number;
  meanTokensPerTool: number;
  /** Largest offenders first, so a catalogue can be trimmed by hand. */
  largest: Array<{ name: string; tokens: number; descriptionTokens: number }>;
  /** Achievable without any behaviour change. */
  losslessTokensSaved: number;
  /** Additionally achievable by trimming descriptions, behind a replay check. */
  descriptionTokensSaved: number;
};

/**
 * Audit a catalogue: how big it is, which tools dominate, and how much each tier
 * of minification would recover. This is what makes the lever measured rather
 * than assumed, so a workload with an already-lean catalogue is credited nothing.
 */
export function auditToolCatalogue(
  tools: unknown[],
  options: { countTokens?: TokenCounter; maximumDescriptionTokens?: number } = {},
): ToolCatalogueAudit {
  const countTokens = options.countTokens ?? approximateTokenCount;
  const lossless = minifyToolSchemas(tools, { countTokens, descriptions: "keep" });
  const trimmed = minifyToolSchemas(tools, {
    countTokens,
    descriptions: "truncate",
    maximumDescriptionTokens: options.maximumDescriptionTokens ?? 24,
  });

  const largest = tools.map((tool, index) => {
    const serialised = JSON.stringify(tool);
    const descriptions = [...serialised.matchAll(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
      .reduce((sum, match) => sum + countTokens(match[1] ?? ""), 0);
    return { name: toolNameOf(tool, index), tokens: countTokens(serialised), descriptionTokens: descriptions };
  }).sort((left, right) => right.tokens - left.tokens);

  const tokens = countTokens(JSON.stringify(tools));
  return {
    tools: tools.length,
    tokens,
    meanTokensPerTool: tools.length === 0 ? 0 : tokens / tools.length,
    largest: largest.slice(0, 10),
    losslessTokensSaved: Math.max(0, lossless.tokensBefore - lossless.tokensAfter),
    descriptionTokensSaved: trimmed.lossyTokensSaved,
  };
}
