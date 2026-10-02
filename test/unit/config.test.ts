import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

function problemsFor(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    expect(loadConfig({})).toEqual({
      outputDir: join(homedir(), ".darkroom", "images"),
      providerOrder: ["comfyui"],
      dailyCapUsd: 2,
      allowPaidFallback: false,
      comfyui: { url: "http://127.0.0.1:8188", workflow: "zimage", timeoutMs: 300_000 },
      openaiApiKey: undefined,
      geminiApiKey: undefined,
    });
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ DARKROOM_PROVIDER_ORDER: "", DARKROOM_DAILY_CAP_USD: "  " })).toMatchObject({
      providerOrder: ["comfyui"],
      dailyCapUsd: 2,
    });
  });

  it("ignores unrelated variables, including a generic OPENAI_API_KEY", () => {
    const config = loadConfig({ OPENAI_API_KEY: "sk-generic", GEMINI_API_KEY: "g-generic" });
    expect(config.openaiApiKey).toBeUndefined();
    expect(config.geminiApiKey).toBeUndefined();
  });

  describe("DARKROOM_OUTPUT_DIR", () => {
    it("accepts and normalizes an absolute path", () => {
      expect(loadConfig({ DARKROOM_OUTPUT_DIR: "/tmp/darkroom//out/" }).outputDir).toBe("/tmp/darkroom/out/");
    });

    it("expands a leading ~", () => {
      expect(loadConfig({ DARKROOM_OUTPUT_DIR: "~/pics" }).outputDir).toBe(join(homedir(), "pics"));
    });

    it.each(["images", "./images", "../images", "~user/images"])("rejects relative path %s", (dir) => {
      expect(problemsFor({ DARKROOM_OUTPUT_DIR: dir })).toEqual([
        expect.stringMatching(/^DARKROOM_OUTPUT_DIR: must be an absolute path/),
      ]);
    });
  });

  describe("DARKROOM_PROVIDER_ORDER", () => {
    it("parses a comma-separated list, ignoring case and spaces", () => {
      expect(loadConfig({ DARKROOM_PROVIDER_ORDER: " ComfyUI , mock " }).providerOrder).toEqual(["comfyui", "mock"]);
    });

    it("rejects unknown providers", () => {
      expect(problemsFor({ DARKROOM_PROVIDER_ORDER: "mock,dalle" })).toEqual([
        "DARKROOM_PROVIDER_ORDER: each provider must be one of: mock, comfyui, openai, gemini",
      ]);
    });

    it("rejects duplicates", () => {
      expect(problemsFor({ DARKROOM_PROVIDER_ORDER: "mock,mock" })).toEqual([
        "DARKROOM_PROVIDER_ORDER: must not list a provider twice",
      ]);
    });

    it("rejects an empty entry", () => {
      expect(problemsFor({ DARKROOM_PROVIDER_ORDER: "mock,," })).toEqual([
        "DARKROOM_PROVIDER_ORDER: each provider must be one of: mock, comfyui, openai, gemini",
      ]);
    });
  });

  describe("numbers and flags", () => {
    it("parses the cap, fallback flag, and timeout", () => {
      expect(
        loadConfig({
          DARKROOM_DAILY_CAP_USD: "0.5",
          DARKROOM_ALLOW_PAID_FALLBACK: "true",
          COMFYUI_TIMEOUT_MS: "600000",
        }),
      ).toMatchObject({ dailyCapUsd: 0.5, allowPaidFallback: true, comfyui: { timeoutMs: 600_000 } });
    });

    it("allows a zero cap", () => {
      expect(loadConfig({ DARKROOM_DAILY_CAP_USD: "0" }).dailyCapUsd).toBe(0);
    });

    it.each([
      ["DARKROOM_DAILY_CAP_USD", "-1", "must be zero or more"],
      ["DARKROOM_DAILY_CAP_USD", "two dollars", "must be a number"],
      ["DARKROOM_DAILY_CAP_USD", "Infinity", "must be a number"],
      ["DARKROOM_ALLOW_PAID_FALLBACK", "yes", 'must be "true" or "false"'],
      ["COMFYUI_TIMEOUT_MS", "1.5", "must be a whole number"],
      ["COMFYUI_TIMEOUT_MS", "10", "must be at least 1000"],
      ["COMFYUI_URL", "ftp://example.com", "must be an http(s) URL"],
      ["COMFYUI_URL", "not a url", "must be an http(s) URL"],
      ["COMFYUI_WORKFLOW", "../zimage", "must be a template name like 'zimage'"],
    ])("rejects %s=%s", (name, value, message) => {
      expect(problemsFor({ [name]: value })).toContain(`${name}: ${message}`);
    });
  });

  it("strips a trailing slash from COMFYUI_URL", () => {
    expect(loadConfig({ COMFYUI_URL: "http://localhost:8188/" }).comfyui.url).toBe("http://localhost:8188");
  });

  it("reads the Darkroom-specific API keys", () => {
    const config = loadConfig({ DARKROOM_OPENAI_API_KEY: "sk-test", DARKROOM_GEMINI_API_KEY: "g-test" });
    expect(config.openaiApiKey).toBe("sk-test");
    expect(config.geminiApiKey).toBe("g-test");
  });

  it("reports every problem at once, without echoing the bad values", () => {
    const secret = "sk-proj-SHOULD-NOT-APPEAR";
    const err = (() => {
      try {
        loadConfig({ DARKROOM_DAILY_CAP_USD: secret, COMFYUI_URL: secret, DARKROOM_OUTPUT_DIR: secret });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error("expected loadConfig to throw");
    })();
    expect(err.problems).toHaveLength(3);
    expect(err.message).not.toContain(secret);
  });
});
