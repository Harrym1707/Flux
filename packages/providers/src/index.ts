export type NormalizedMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
};

export type NormalizedRequest = {
  requestId: string;
  model: string;
  messages: NormalizedMessage[];
  metadata?: Record<string, string>;
};

export type NormalizedResponse = {
  raw: unknown;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
};

export interface ModelProvider {
  readonly name: string;
  complete(request: NormalizedRequest): Promise<NormalizedResponse>;
  estimateCost?(request: NormalizedRequest): Promise<number>;
}
