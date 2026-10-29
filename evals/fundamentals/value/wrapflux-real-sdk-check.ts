import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { wrapFlux } from "../../../packages/sdk-js/src/wrap.js";

/**
 * Does wrapFlux actually work against the REAL @anthropic-ai/sdk — not a mock?
 *
 * The earlier wrap.test.ts used plain-object mocks with no #private fields, so
 * it could never catch a Proxy/private-field break. This wraps a real Anthropic
 * client pointed at a local stub (no network, no key) and checks the drop-in
 * works, reduces the real request on the wire, and surfaces savings. Kept as a
 * runnable eval (not a vitest test: the real SDK's keep-alive socket hangs the
 * runner). Run it:
 *
 *   corepack pnpm add -D -w @anthropic-ai/sdk   # if not installed
 *   node --import tsx evals/fundamentals/value/wrapflux-real-sdk-check.ts
 *
 * Result on @anthropic-ai/sdk 1.3.0 (2026-10-29): WORKS — no Proxy/private-field
 * break. The bug previously claimed here does not reproduce on the real SDK.
 */

const seen: any[] = [];
const stub = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_stub", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: 120, output_tokens: 10 },
    }));
  });
});

const DUP = "Knowledge base article 4471: refunds to a closed card return to the original payment method.";

async function main() {
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const port = (stub.address() as any).port;
  const real = new Anthropic({ apiKey: "sk-ant-stub", baseURL: `http://127.0.0.1:${port}` });

  let wrapped: any;
  try {
    wrapped = wrapFlux(real, { app: "repro", ledgerPath: "/tmp/flux-repro-ledger.jsonl" });
    console.log("STEP 1 wrapFlux(real)                  OK (no throw at wrap time)");
  } catch (e) {
    console.log(`STEP 1 wrapFlux(real)                  THREW: ${(e as Error).message}`);
    stub.close();
    return;
  }

  try {
    const res: any = await wrapped.messages.create({
      model: "claude-sonnet-5-5", max_tokens: 64,
      messages: [{ role: "user", content: `${DUP}\n\n${DUP}\n\nWhat happens?` }],
    });
    console.log(`STEP 2 wrapped.messages.create(...)     OK, response: ${JSON.stringify(res.content?.[0]?.text)}`);
    const dupCount = JSON.stringify(seen.at(-1)).split("Knowledge base article 4471").length - 1;
    console.log(`STEP 3 reduction on the wire           duplicate block appears ${dupCount}x (1 = reduced)`);
    console.log(`STEP 4 savings()                       ${JSON.stringify(wrapped.flux.savings())}`);
    console.log(`\nVERDICT: wrapFlux WORKS against the real @anthropic-ai/sdk — no Proxy/private-field break.`);
  } catch (e) {
    console.log(`STEP 2 wrapped.messages.create(...)     THREW: ${(e as Error).message}`);
    console.log(`\nVERDICT: BUG REPRODUCES — wrapFlux breaks on the real SDK. Fix needed.`);
  } finally {
    stub.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
