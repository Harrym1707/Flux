// Offline mechanics check for run-effort-gate.ts — NO network, NO API spend.
// Confirms (1) the reducer engages output-effort-low on effort-capable Claude
// ids the picker would choose, and (2) replayGate+grader+reduceRequest wire
// together end-to-end on a LOCAL stub provider. A stub proves nothing about the
// lever's real value (that needs the live run) — it only proves the harness runs.
import { reduceRequest, replayGate } from "../../../packages/sdk-js/src/index.js";
import { effortTaskGrader, EFFORT_LOW, EFFORT_MEDIUM } from "../../../evals/run-effort-gate.js";

const MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-sonnet-4-5"];
for (const model of MODELS) {
  const req = { model, max_tokens: 1024, system: "x", messages: [{ role: "user", content: "hi" }] };
  const r = reduceRequest(req, EFFORT_LOW.config);
  const change = r.summary.changes.find((c) => c.lever.startsWith("output-effort"));
  console.log(`${model.padEnd(20)} -> ${change ? change.lever : "NO CHANGE"} (lossless=${change?.lossless})`);
}

// end-to-end wiring on a local stub: baseline verbose, candidate terse but still correct.
type Task = { prompt: string; expected: string };
const tasks: Task[] = [
  { prompt: "What is 2+2? Explain.", expected: "4" },
  { prompt: "Capital of France? Explain.", expected: "Paris" },
];
const byPrompt = new Map(tasks.map((t) => [t.prompt, { id: t.prompt, prompt: t.prompt, expected: t.expected } as any]));
const requests = tasks.map((t) => ({ model: "claude-sonnet-5", max_tokens: 1024, system: "Solve. End with 'FINAL: <answer>'.", messages: [{ role: "user", content: t.prompt }] }));

function stubCall(req: any) {
  const prompt = req.messages[0].content as string;
  const task = byPrompt.get(prompt)!;
  const terse = req.output_config?.effort === "low" || req.output_config?.effort === "medium";
  const long = terse ? "" : " Here is a lot of extra reasoning prose to make the baseline verbose. ".repeat(6);
  const text = `Thinking...${long}\nFINAL: ${task.expected}`;
  const outTok = terse ? 20 : 80;
  return Promise.resolve({ content: [{ type: "text", text }], usage: { input_tokens: 50, output_tokens: outTok, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
}

const result = await replayGate({
  requests, call: stubCall, candidates: [EFFORT_LOW, EFFORT_MEDIUM],
  grade: effortTaskGrader(byPrompt as any), groupOf: (r: any) => r.messages[0].content, seed: "mech-check",
});
console.log("\nreplayGate wired OK. calls:", result.calls);
for (const c of result.candidates) {
  console.log(` ${c.label}: graded=${c.graded} outSaved=${c.outputTokensSaved} qDeltaLower95=${(c.lower95QualityDelta*100).toFixed(1)}pp approved=${c.approved}`);
}
console.log("approved:", result.approved?.label ?? "none");
