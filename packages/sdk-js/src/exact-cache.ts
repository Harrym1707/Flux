import { createHash } from "node:crypto";
import type { FluxExactCacheConfig } from "./types.js";

export type ExactCacheEntry = {
  response: unknown;
  model: string;
  inputTokens?: number;
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  expiresAt: number;
};

function canonicalJson(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const values = value.map((item) => canonicalJson(item, seen));
    seen.delete(value);
    return values.some((item) => item === undefined) ? undefined : `[${values.join(",")}]`;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return undefined;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort().map((key) => {
    const child = canonicalJson(record[key], seen);
    return child === undefined ? undefined : `${JSON.stringify(key)}:${child}`;
  });
  seen.delete(value);
  return entries.some((entry) => entry === undefined) ? undefined : `{${entries.join(",")}}`;
}

export class ExactResponseCache {
  private readonly entries = new Map<string, ExactCacheEntry>();

  constructor(private readonly config: FluxExactCacheConfig) {
    if (!Number.isInteger(config.maxEntries) || config.maxEntries < 1) {
      throw new Error("FLUX exact cache maxEntries must be a positive integer.");
    }
    if (!Number.isFinite(config.ttlMs) || config.ttlMs < 1) {
      throw new Error("FLUX exact cache ttlMs must be a positive number.");
    }
  }

  keyFor(request: unknown, scopeKey: string | undefined): string | undefined {
    if (typeof scopeKey !== "string" || scopeKey.trim() === "" || !request || typeof request !== "object") return undefined;
    const body = request as Record<string, unknown>;
    if (body.stream === true || body.tools !== undefined || body.tool_choice !== undefined ||
        body.previous_response_id !== undefined || body.conversation !== undefined) return undefined;
    const serialized = canonicalJson(request);
    if (serialized === undefined) return undefined;
    return createHash("sha256").update(`${scopeKey}\n${serialized}`).digest("hex");
  }

  get(key: string): ExactCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    try {
      const response = structuredClone(entry.response);
      this.entries.delete(key);
      this.entries.set(key, entry);
      return { ...entry, response };
    } catch {
      this.entries.delete(key);
      return undefined;
    }
  }

  set(key: string, entry: Omit<ExactCacheEntry, "expiresAt">): void {
    try {
      const response = structuredClone(entry.response);
      this.entries.delete(key);
      this.entries.set(key, { ...entry, response, expiresAt: Date.now() + this.config.ttlMs });
      while (this.entries.size > this.config.maxEntries) {
        const oldestKey = this.entries.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        this.entries.delete(oldestKey);
      }
    } catch {
      // Responses that cannot be safely cloned are not cached.
    }
  }
}
