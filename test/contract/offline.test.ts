import sharp from "sharp";
import { createGeminiProvider } from "../../src/providers/gemini.js";
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

// Gemini picks sizes from the aspect ratio and tier: these are the 1K sizes seen in the M5
// benchmark and eval. Drafts are about half each side (512×512, 624×416).
const GEMINI_SIDES: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "3:2": [1264, 848],
  "2:3": [848, 1264],
  "16:9": [1376, 768],
  "9:16": [768, 1376],
};

/** Answers like generateContent, with a blank PNG at the aspect ratio asked for. */
const fakeGenerateContent: typeof fetch = async (_input, init) => {
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
    generationConfig?: { imageConfig?: { aspectRatio?: string; imageSize?: string } };
  };
  const { aspectRatio = "1:1", imageSize = "1K" } = body.generationConfig?.imageConfig ?? {};
  const [w, h] = GEMINI_SIDES[aspectRatio] ?? [1024, 1024];
  const scale = imageSize === "512" ? 0.5 : 1;
  const png = await sharp({
    create: { width: Math.round(w * scale), height: Math.round(h * scale), channels: 3, background: "#808080" },
  })
    .png()
    .toBuffer();
  const image = { inlineData: { mimeType: "image/png", data: png.toString("base64") } };
  return Response.json({
    candidates: [{ content: { parts: [image] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 1120,
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
    },
  });
};

providerContract(
  "gemini (fake API)",
  () =>
    createGeminiProvider({
      apiKey: "AIza-test-not-a-real-key",
      model: "gemini-3.1-flash-image",
      timeoutMs: 10_000,
      fetch: fakeGenerateContent,
    }),
  { cases: ALL_SHAPES },
);
