import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalJsonlCapture } from "./evaluation-capture.js";
import { withFlux } from "./openai.js";

describe("local evaluation capture", () => {
  it("writes only the explicit redacted record and preserves scored usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flux-capture-test-"));
    const path = join(directory, "capture.jsonl");
    const capture = createLocalJsonlCapture(path, (record) => ({
      ...record,
      request: { model: "test-model" },
      expected: undefined,
      attempts: record.attempts.map((attempt) => ({
        ...attempt,
        request: { model: attempt.model },
        response: undefined,
      })),
    }), {
      getCaseId: () => "case-001",
      getGroupId: () => "sha256-group",
      getExpected: () => "approved",
      score: (_expected, response) => (response as { output_text?: string }).output_text === "approved" ? 1 : 0,
    });
    const client = withFlux({
      responses: {
        async create(_request: Record<string, unknown>) {
          return { output_text: "approved", usage: { input_tokens: 10, output_tokens: 2 } };
        },
      },
    }, {
      applicationId: "capture-test",
      pricing: { inputPerMillion: 1, outputPerMillion: 1 },
      evaluationCapture: capture,
    });

    await client.responses.create({ model: "test-model", input: "secret prompt text" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await capture.flush();
    const saved = await readFile(path, "utf8");
    const record = JSON.parse(saved.trim()) as {
      caseId: string;
      groupId: string;
      request: { model: string };
      attempts: Array<{ score: number; inputTokens: number; outputTokens: number; costUsd: number }>;
    };
    expect(saved).not.toContain("secret prompt text");
    expect(record.caseId).toBe("case-001");
    expect(record.groupId).toBe("sha256-group");
    expect(record.request.model).toBe("test-model");
    expect(record.attempts[0]).toMatchObject({ score: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.000012 });
    await rm(directory, { recursive: true, force: true });
  });
});
