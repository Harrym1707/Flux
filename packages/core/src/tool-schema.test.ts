import { describe, expect, it } from "vitest";
import { auditToolCatalogue, minifyToolSchemas } from "./tool-schema.js";

function tool(name: string, description: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          accountId: {
            type: "string",
            title: "accountId",
            description: "The customer account identifier as shown in the admin console.",
          },
          limit: { type: "integer", title: "Maximum results", description: "Between 1 and 100." },
        },
        required: ["accountId"],
        ...extra,
      },
    },
  };
}

const LONG = "Look up a record set for an account. Use this when the customer asks about historical activity " +
  "in this subsystem. Returns a paginated list ordered by creation time descending. Do not call this more " +
  "than once per turn; prefer narrowing the query with filters over paging through results.";

describe("minifyToolSchemas", () => {
  it("keeps descriptions by default, so the default path is lossless", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)]);
    expect(result.lossyTokensSaved).toBe(0);
    expect(result.losslessTokensSaved).toBeGreaterThan(0);
    expect(JSON.stringify(result.tools)).toContain("paginated list");
  });

  it("removes schema plumbing the model never reads", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)]);
    expect(JSON.stringify(result.tools)).not.toContain("$schema");
    expect(result.changes.some((change) => change.kind === "plumbing" && change.lossless)).toBe(true);
  });

  it("removes a title that only restates its property name, and keeps one that does not", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)]);
    const serialised = JSON.stringify(result.tools);
    // accountId's title restated the key; limit's title carries information.
    expect(serialised).not.toContain('"title":"accountId"');
    expect(serialised).toContain("Maximum results");
  });

  it("never reports formatting or plumbing as lossy", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)]);
    for (const change of result.changes) {
      if (change.kind === "formatting" || change.kind === "plumbing" || change.kind === "redundant-title") {
        expect(change.lossless).toBe(true);
      }
    }
  });

  it("reports description trimming as lossy, because descriptions drive tool choice", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)], {
      descriptions: "truncate",
      maximumDescriptionTokens: 12,
    });
    const trims = result.changes.filter((change) => change.kind === "description");
    expect(trims.length).toBeGreaterThan(0);
    expect(trims.every((change) => change.lossless === false)).toBe(true);
    expect(result.lossyTokensSaved).toBeGreaterThan(0);
  });

  it("truncates on a sentence boundary where one fits", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)], {
      descriptions: "truncate",
      maximumDescriptionTokens: 16,
    });
    const serialised = JSON.stringify(result.tools);
    expect(serialised).toContain("Look up a record set for an account.");
    expect(serialised).not.toContain("paginated list");
  });

  it("drops descriptions entirely when asked, and says so", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)], { descriptions: "drop" });
    expect(JSON.stringify(result.tools)).not.toContain("Look up a record set");
    expect(result.changes.some((change) =>
      change.kind === "description" && /chooses between tools/.test(change.detail))).toBe(true);
  });

  it("treats dropping a tool as lossy and names it", () => {
    const result = minifyToolSchemas([tool("keep", LONG), tool("discard", LONG)], { keepTools: ["keep"] });
    expect(result.tools).toHaveLength(1);
    const dropped = result.changes.find((change) => change.kind === "dropped-tool")!;
    expect(dropped.lossless).toBe(false);
    expect(dropped.at).toBe("discard");
    expect(dropped.detail).toMatch(/cannot call what it cannot see/);
  });

  it("only reduces tokens", () => {
    const tools = [tool("a", LONG), tool("b", LONG)];
    const result = minifyToolSchemas(tools, { descriptions: "truncate" });
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it("rejects a catalogue that is not an array, and a bad token limit", () => {
    expect(() => minifyToolSchemas({} as unknown as unknown[])).toThrow(/must be an array/);
    expect(() => minifyToolSchemas([], { maximumDescriptionTokens: 0 })).toThrow(/positive integer/);
  });

  it("handles an empty catalogue", () => {
    const result = minifyToolSchemas([]);
    expect(result.tools).toEqual([]);
    expect(result.lossyTokensSaved).toBe(0);
  });
});

describe("auditToolCatalogue", () => {
  it("separates what is free from what needs verifying", () => {
    const audit = auditToolCatalogue([tool("a", LONG), tool("b", LONG), tool("c", LONG)]);
    expect(audit.tools).toBe(3);
    expect(audit.tokens).toBeGreaterThan(0);
    expect(audit.losslessTokensSaved).toBeGreaterThan(0);
    expect(audit.descriptionTokensSaved).toBeGreaterThan(0);
  });

  it("scales the description saving with how verbose the descriptions are", () => {
    // Which tier is larger depends on what the catalogue happens to contain:
    // the lossless tier is plumbing and indentation, the lossy tier is prose.
    // Asserting an ordering between them would test the fixture rather than the
    // code, so the invariant asserted is that the description saving tracks
    // description length while the lossless saving does not.
    const terse = auditToolCatalogue(Array.from({ length: 8 }, (_, i) => tool(`t${i}`, "Short.")));
    const verbose = auditToolCatalogue(Array.from({ length: 8 }, (_, i) => tool(`t${i}`, LONG)));
    expect(verbose.descriptionTokensSaved).toBeGreaterThan(terse.descriptionTokensSaved * 3);
    expect(verbose.losslessTokensSaved).toBeCloseTo(terse.losslessTokensSaved, -1);
  });

  it("credits an already-lean catalogue almost nothing for description trimming", () => {
    const lean = [{ type: "function", function: { name: "ping", parameters: { type: "object", properties: {} } } }];
    const audit = auditToolCatalogue(lean);
    expect(audit.descriptionTokensSaved).toBe(0);
  });

  it("ranks the largest tools first so a catalogue can be trimmed by hand", () => {
    const audit = auditToolCatalogue([
      tool("small", "Short."),
      tool("large", LONG),
    ]);
    expect(audit.largest[0]!.name).toBe("large");
    expect(audit.largest[0]!.descriptionTokens).toBeGreaterThan(audit.largest[1]!.descriptionTokens);
  });

  it("reports mean size per tool", () => {
    const audit = auditToolCatalogue([tool("a", LONG), tool("b", LONG)]);
    expect(audit.meanTokensPerTool).toBeCloseTo(audit.tokens / 2, 6);
  });
});
