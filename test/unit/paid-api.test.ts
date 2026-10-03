import { describe, expect, it } from "vitest";
import { redactKey } from "../../src/providers/paid-api.js";

const KEY = "sk-proj-THISISAFAKEKEYFORTESTS0123456789";

describe("redactKey", () => {
  it("removes the key and anything shaped like an OpenAI or Google key", () => {
    expect(redactKey(`bad key ${KEY}`, KEY)).toBe("bad key [redacted]");
    expect(redactKey("Incorrect API key provided: sk-proj-abcd****wxyz.", undefined)).toBe(
      "Incorrect API key provided: sk-[redacted].",
    );
    expect(redactKey("key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q is bad", undefined)).toBe("key AIza[redacted] is bad");
  });

  it("leaves ordinary text alone", () => {
    expect(redactKey("task-runner is fine", "x")).toBe("task-runner is fine");
  });
});
