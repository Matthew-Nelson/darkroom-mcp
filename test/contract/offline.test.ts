import sharp from "sharp";
import { createMockProvider } from "../../src/providers/mock.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";
import { ALL_SHAPES, providerContract } from "./contract.js";

// Runs in every `npm test`: no network, no GPU, no keys.

providerContract("mock", () => createMockProvider(), { cases: ALL_SHAPES });

/** Answers like the Images API, with a blank PNG at the requested size. */
const fakeImagesApi: typeof fetch = async (_input, init) => {
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { size?: string };
  const [width = 0, height = 0] = (body.size ?? "").split("x").map(Number);
  const png = await sharp({ create: { width, height, channels: 3, background: "#808080" } }).png().toBuffer();
  return Response.json({
    data: [{ b64_json: png.toString("base64") }],
    usage: { input_tokens: 20, input_tokens_details: { text_tokens: 20, image_tokens: 0 }, output_tokens: 300 },
  });
};

providerContract(
  "openai (fake API)",
  () =>
    createOpenAIProvider({ apiKey: "sk-test-not-a-real-key", model: "gpt-image-2.5-flare", timeoutMs: 10_000, fetch: fakeImagesApi }),
  { cases: ALL_SHAPES },
);
