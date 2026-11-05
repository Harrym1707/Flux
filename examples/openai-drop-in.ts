import OpenAI from "openai";
import { withMesh } from "@harrym1707/sdk";

const inputPrice = process.env.MESH_INPUT_PRICE_PER_MILLION;
const outputPrice = process.env.MESH_OUTPUT_PRICE_PER_MILLION;
const pricing = inputPrice?.trim() && outputPrice?.trim()
  ? {
      inputPerMillion: Number(inputPrice),
      outputPerMillion: Number(outputPrice),
    }
  : undefined;

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const raw = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = withMesh(raw, {
  applicationId: "example-app",
  pricing,
  telemetry: {
    endpoint: process.env.MESH_TELEMETRY_URL,
    mode: "metadata_only",
  },
  classify: () => "classification",
  onEvent: (event) => console.info("MESH request", event),
});

const response = await openai.responses.create({
  model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  input: "Classify this support request as billing, technical or other.",
});

console.log("Model output:", response.output_text);
