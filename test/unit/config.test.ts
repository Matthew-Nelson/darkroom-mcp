import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { API_KEY_VARS, ConfigError, loadConfig, PAID_PROVIDERS } from "../../src/config.js";

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
      openai: { apiKey: undefined, model: "gpt-image-2.5-flare", timeoutMs: 180_000 },
      gemini: { apiKey: undefined, model: "gemini-3.1-flash-image", timeoutMs: 180_000 },
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
    expect(config.openai.apiKey).toBeUndefined();
    expect(config.gemini.apiKey).toBeUndefined();
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
      ["COMFYUI_TIMEOUT_MS", "2147483648", "must be at most 2147483647 (about 24.8 days)"],
      ["COMFYUI_URL", "ftp://example.com", "must be an http(s) URL"],
      ["COMFYUI_URL", "not a url", "must be an http(s) URL"],
      ["COMFYUI_WORKFLOW", "../zimage", "must be a template name like 'zimage'"],
      ["DARKROOM_OPENAI_MODEL", "gpt image", "must be a model name like 'gpt-image-2.5-flare'"],
      ["DARKROOM_OPENAI_TIMEOUT_MS", "10", "must be at least 1000"],
      ["DARKROOM_GEMINI_MODEL", "models/gemini", "must be a model name like 'gemini-3.1-flash-image'"],
      ["DARKROOM_GEMINI_TIMEOUT_MS", "2147483648", "must be at most 2147483647 (about 24.8 days)"],
    ])("rejects %s=%s", (name, value, message) => {
      expect(problemsFor({ [name]: value })).toContain(`${name}: ${message}`);
    });
  });

  it("strips a trailing slash from COMFYUI_URL", () => {
    expect(loadConfig({ COMFYUI_URL: "http://localhost:8188/" }).comfyui.url).toBe("http://localhost:8188");
  });

  it("reads the Darkroom-specific API keys", () => {
    const config = loadConfig({ DARKROOM_OPENAI_API_KEY: "sk-test", DARKROOM_GEMINI_API_KEY: "g-test" });
    expect(config.openai.apiKey).toBe("sk-test");
    expect(config.gemini.apiKey).toBe("g-test");
  });

  it("names the key variable for every paid provider, and it's the one loadConfig reads", () => {
    expect(Object.keys(API_KEY_VARS).sort()).toEqual([...PAID_PROVIDERS].sort());
    for (const [name, envVar] of Object.entries(API_KEY_VARS)) {
      const config = loadConfig({ [envVar]: "key" });
      expect(config[name as "openai" | "gemini"].apiKey).toBe("key");
    }
  });

  it("reads the OpenAI model and timeout", () => {
    expect(
      loadConfig({ DARKROOM_OPENAI_MODEL: "gpt-image-2", DARKROOM_OPENAI_TIMEOUT_MS: "60000" }).openai,
    ).toMatchObject({ model: "gpt-image-2", timeoutMs: 60_000 });
  });

  it("reads the Gemini model and timeout", () => {
    expect(
      loadConfig({ DARKROOM_GEMINI_MODEL: "gemini-3.1-flash-lite-image", DARKROOM_GEMINI_TIMEOUT_MS: "90000" }).gemini,
    ).toMatchObject({ model: "gemini-3.1-flash-lite-image", timeoutMs: 90_000 });
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
