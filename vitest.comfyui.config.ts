import { defineConfig } from "vitest/config";

// `npm run test:comfyui`: real ComfyUI, minutes per test, run on request only.
export default defineConfig({
  test: {
    include: ["test/comfyui/**/*.test.ts"],
    testTimeout: 360_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
