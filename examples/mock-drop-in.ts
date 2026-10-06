import { withFlux } from "@flux-ai/sdk";

const inputPrice = process.env.FLUX_INPUT_PRICE_PER_MILLION;
const outputPrice = process.env.FLUX_OUTPUT_PRICE_PER_MILLION;
const pricing = inputPrice?.trim() && outputPrice?.trim()
  ? {
      inputPerMillion: Number(inputPrice),
      outputPerMillion: Number(outputPrice),
    }
  : undefined;

// A provider-shaped mock keeps the integration demo runnable without an API key.
const fakeOpenAI = {
  responses: {
    async create(request: { model: string; input: string }) {
      return {
        id: "resp_mock_001",
        model: request.model,
        output_text: "billing",
        usage: { input_tokens: 14, output_tokens: 2 },
      };
    },
  },
};

const openai = withFlux(fakeOpenAI, {
  applicationId: "mock-example",
  pricing,
  telemetry: {
    endpoint: process.env.FLUX_TELEMETRY_URL,
    mode: "metadata_only",
  },
  classify: () => "support.classification",
  onEvent: (event) => console.info("FLUX request", event),
});

const response = await openai.responses.create({
  model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  input: "Classify this support request as billing, technical or other.",
});

console.log("Mock model output:", response.output_text);
