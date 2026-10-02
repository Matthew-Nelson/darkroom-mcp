import { describe, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createComfyUIProvider } from "../../src/providers/comfyui.js";
import { loadWorkflow } from "../../src/providers/comfyui-workflow.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";
import { ONE_DRAFT, providerContract } from "./contract.js";

// The same contract against real providers, only when asked:
//   DARKROOM_CONTRACT_COMFYUI=1 npm run test:contract                  (a few minutes, free)
//   DARKROOM_CONTRACT_OPENAI=1 DARKROOM_OPENAI_API_KEY=... npm run test:contract   (costs money)

const comfyuiOn = process.env.DARKROOM_CONTRACT_COMFYUI === "1";
const openaiOn = process.env.DARKROOM_CONTRACT_OPENAI === "1";
// Read only when asked, so stray settings in the shell can't break `npm test`.
const config = comfyuiOn || openaiOn ? loadConfig() : undefined;

if (comfyuiOn && config) {
  const workflow = await loadWorkflow(config.comfyui.workflow);
  providerContract("comfyui (real server)", () => createComfyUIProvider({ ...config.comfyui, workflow }), {
    cases: ONE_DRAFT,
    timeoutMs: config.comfyui.timeoutMs + 30_000,
  });
}

if (openaiOn && config) {
  if (!config.openai.apiKey) throw new Error("DARKROOM_CONTRACT_OPENAI=1 needs DARKROOM_OPENAI_API_KEY.");
  const make = () => createOpenAIProvider(config.openai);
  const estimate = ONE_DRAFT.reduce((sum, req) => sum + make().estimateCostUsd(req), 0);
  process.stderr.write(
    `\n[contract] Real OpenAI run: ${ONE_DRAFT.length} draft image(s) with ${config.openai.model}, ` +
      `estimated at about $${estimate.toFixed(4)}. This bypasses the spend ledger.\n\n`,
  );
  providerContract("openai (real API)", make, { cases: ONE_DRAFT, timeoutMs: config.openai.timeoutMs + 10_000 });
}

describe("real-provider contract runs", () => {
  it.skipIf(comfyuiOn || openaiOn)(
    "are off unless DARKROOM_CONTRACT_COMFYUI=1 or DARKROOM_CONTRACT_OPENAI=1",
    () => undefined,
  );
});
