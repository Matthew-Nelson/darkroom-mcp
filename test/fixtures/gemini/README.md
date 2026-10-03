# Gemini fixtures

Responses from `POST /v1beta/models/{model}:generateContent`, so the provider's parsing is tested offline.

**Recorded Oct 3, 2026** from `gemini-3.1-flash-image` during the M5 benchmark (prompt: a ceramic coffee mug on a desk reading DARKROOM). Response bodies only (no headers); image data is replaced with an 8×8 gray JPEG and `thoughtSignature` with `[trimmed]`. `usageMetadata` is real:

- `generate-200-draft.json`: 1:1 at `imageSize: "512"` (the `draft` tier), 512×512: 24 prompt tokens, 1,196 output tokens of which 747 are `IMAGE`, $0.046179.
- `generate-200-final.json`: 1:1 at `1K` (the `final` tier), 1024×1024: 24 prompt tokens, 1,602 output tokens of which 1,120 are `IMAGE`, $0.068658.

What the real responses looked like (seven calls): one `image/jpeg` part each, carrying a `thoughtSignature` but no `thought: true` and no interim images; no `thoughtsTokenCount`; and 414–482 output tokens more than the `IMAGE` count, with no modality given. Darkroom bills those at the text and thinking rate, which puts every measured cost within 1% of the list price. Sizes seen: 512×512 and 624×416 (3:2) drafts; 1024×1024 and 1376×768 (16:9) finals.

**Hand-made** from the shapes in the Gemini API reference (`ai.google.dev/api/generate-content`, checked Oct 3, 2026):

- `prompt-blocked.json`: `promptFeedback.blockReason` set and no candidates, so the prompt was refused before generation.
- `finish-image-safety.json`: a candidate that stopped with `IMAGE_SAFETY` and no image.
- `error-400-api-key.json`: an invalid key. Google answers this with HTTP 400 and an `ErrorInfo` reason of `API_KEY_INVALID`, not 401.
