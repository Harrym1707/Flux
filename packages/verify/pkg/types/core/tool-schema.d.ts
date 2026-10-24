import { type TokenCounter } from "./token-reduction.js";
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
/**
 * Minify a tool catalogue, reporting every change and which tier it belongs to.
 *
 * Defaults are lossless only: descriptions are kept. A caller wanting the large
 * saving opts into it explicitly and gets it reported as lossy.
 */
export declare function minifyToolSchemas(tools: unknown[], options?: MinifyOptions): MinifyResult;
export type ToolCatalogueAudit = {
    tools: number;
    tokens: number;
    meanTokensPerTool: number;
    /** Largest offenders first, so a catalogue can be trimmed by hand. */
    largest: Array<{
        name: string;
        tokens: number;
        descriptionTokens: number;
    }>;
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
export declare function auditToolCatalogue(tools: unknown[], options?: {
    countTokens?: TokenCounter;
    maximumDescriptionTokens?: number;
}): ToolCatalogueAudit;
