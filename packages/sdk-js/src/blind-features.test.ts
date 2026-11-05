import { describe, expect, it } from "vitest";
import { extractBlindFeatures } from "./blind-features.js";

const KEY = "deployment-secret-key-never-leaves-the-enclave";

const SECRET = "PATIENT JANE DOE DIAGNOSED WITH acute lymphoblastic leukaemia on 2026-03-14";
const DUP = "You are a careful clinical assistant. Cite sources. Escalate anything risky.";

function clinicalRequest() {
  return {
    model: "claude-sonnet-5-5",
    system: DUP,
    tools: [{ name: "lookup_record", description: "Look up a patient record.", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: SECRET },
      { role: "assistant", content: DUP },
      { role: "user", content: `${SECRET} — summarise the treatment plan.` },
    ],
  };
}

describe("blind feature extraction", () => {
  it("NEVER lets prompt content into the features (the whole point)", () => {
    const features = extractBlindFeatures(clinicalRequest(), { hmacKey: KEY });
    const serialised = JSON.stringify(features);
    // No fragment of the sensitive prompt may appear anywhere in what we keep.
    expect(serialised).not.toContain("JANE DOE");
    expect(serialised).not.toContain("leukaemia");
    expect(serialised).not.toContain("treatment plan");
    expect(serialised).not.toContain("careful clinical assistant");
    // Not even a distinctive long token should survive.
    expect(serialised.toLowerCase()).not.toContain("lymphoblastic");
  });

  it("still learns the STRUCTURE needed to calibrate levers", () => {
    const features = extractBlindFeatures(clinicalRequest(), { hmacKey: KEY });
    expect(features.provider).toBe("anthropic");
    expect(features.model).toBe("claude-sonnet-5-5");
    expect(features.messageCount).toBe(3);
    expect(features.toolCount).toBe(1);
    expect(features.inputTokensApprox).toBeGreaterThan(0);
    expect(features.toolSchemaTokensApprox).toBeGreaterThan(0);
    // The user role appears twice, assistant + system once each.
    expect(features.roleTokensApprox.user).toBeGreaterThan(0);
    expect(features.roleTokensApprox.assistant).toBeGreaterThan(0);
    expect(features.roleTokensApprox.system).toBeGreaterThan(0);
  });

  it("detects duplication/reuse from keyed hashes without seeing the text", () => {
    const features = extractBlindFeatures(clinicalRequest(), { hmacKey: KEY });
    // The system line is repeated as an assistant turn: identical text -> identical
    // keyed hash -> a measurable duplicate fraction, learned with zero content.
    expect(features.duplicateBlockFraction).toBeGreaterThan(0);
    const counts = new Map<string, number>();
    for (const h of features.blockHashes) counts.set(h, (counts.get(h) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeGreaterThanOrEqual(2);
  });

  it("is keyed: the SAME prompt under a DIFFERENT key yields different hashes (unguessable)", () => {
    const a = extractBlindFeatures(clinicalRequest(), { hmacKey: KEY });
    const b = extractBlindFeatures(clinicalRequest(), { hmacKey: "a-different-deployment-key" });
    // Same structure...
    expect(a.messageCount).toBe(b.messageCount);
    // ...but no hash matches across keys, so a hash cannot be guess-and-checked
    // against candidate strings by anyone who lacks the key.
    expect(a.stablePrefixHash).not.toBe(b.stablePrefixHash);
    expect(a.blockHashes.some((h) => b.blockHashes.includes(h))).toBe(false);
  });

  it("is deterministic under the same key, so cross-turn reuse is detectable", () => {
    const first = extractBlindFeatures(clinicalRequest(), { hmacKey: KEY });
    const second = extractBlindFeatures(clinicalRequest(), { hmacKey: KEY });
    expect(first.stablePrefixHash).toBe(second.stablePrefixHash);
  });

  it("requires a key — it will not run blind-less", () => {
    expect(() => extractBlindFeatures(clinicalRequest(), { hmacKey: "" })).toThrow(/hmacKey/);
  });
});
