import type { MeshRequestEvent, MeshTelemetryConfig } from "./types.js";

export class TelemetryClient {
  constructor(private readonly config: MeshTelemetryConfig = {}) {}

  async emit(event: MeshRequestEvent): Promise<void> {
    if (!this.config.endpoint) return;

    const metadataEvent = {
      ...event,
      // The local telemetry endpoint needs failure status, not provider error text.
      error: event.error ? "provider_error" : undefined,
    };

    // Deliberately non-blocking for the hot path.
    void fetch(this.config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(metadataEvent),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      // Telemetry failure must not break customer inference.
    });
  }
}
