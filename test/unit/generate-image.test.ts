import { describe, expect, it } from "vitest";
import { ContentRefusedError } from "../../src/providers/types.js";
import { errorResult } from "../../src/tools/generate-image.js";

const text = (r: ReturnType<typeof errorResult>) => (r.content[0]?.type === "text" ? r.content[0].text : "");

describe("generate_image errors", () => {
  it("blames the prompt for a refusal when there's no reference image", () => {
    const result = errorResult(new ContentRefusedError("blocked (input check)"));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "The provider refused this prompt: blocked (input check). " +
        "Rephrase the request; Darkroom does not retry refused prompts on another provider.",
    );
  });

  it("says the reference image may be the cause when one was sent", () => {
    const result = errorResult(new ContentRefusedError("blocked (input check)"), { reference: true });
    expect(text(result)).toBe(
      "The provider refused this prompt or its reference image: blocked (input check). " +
        "Rephrase the request or try a different image; Darkroom does not retry refused requests on another provider.",
    );
  });
});
