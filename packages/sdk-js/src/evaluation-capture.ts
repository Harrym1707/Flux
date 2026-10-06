import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FluxEvaluationCaptureConfig, FluxEvaluationCaptureRecord } from "./types.js";

export type LocalJsonlCapture = FluxEvaluationCaptureConfig & {
  /** Wait until all queued JSONL writes have completed. */
  flush: () => Promise<void>;
};

/**
 * Create an opt-in local JSONL capture sink. A redactor is mandatory because
 * records can contain prompts and model responses. The file is created with
 * owner-only permissions where the host filesystem supports POSIX modes.
 */
export function createLocalJsonlCapture(
  path: string,
  redact: (record: FluxEvaluationCaptureRecord) => FluxEvaluationCaptureRecord | undefined,
  hooks: Pick<FluxEvaluationCaptureConfig, "getCaseId" | "getGroupId" | "getExpected" | "score"> = {},
): LocalJsonlCapture {
  if (!path.trim() || typeof redact !== "function") {
    throw new Error("Local evaluation capture requires a path and a redaction function.");
  }
  const outputPath = resolve(path);
  let queue: Promise<void> = Promise.resolve();
  const write = (record: FluxEvaluationCaptureRecord): Promise<void> => {
    queue = queue.catch(() => undefined).then(async () => {
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      await appendFile(outputPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return queue;
  };
  return { ...hooks, redact, write, flush: () => queue };
}
