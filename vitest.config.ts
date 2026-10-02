import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/integration/build.setup.ts"],
    testTimeout: 20_000,
  },
});
