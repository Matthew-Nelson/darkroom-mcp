# Gemini fixtures

Responses from `POST /v1beta/models/{model}:generateContent`, so the provider's parsing is tested offline.

**Hand-made** from the shapes in the Gemini API reference (`ai.google.dev/api/generate-content`, checked Oct 3, 2026), to be replaced with recorded responses after the M5 benchmark. Image data is an 8×8 gray PNG.

- `generate-200.json`: a 512px draft with one interim thought image and the final image; usage of 24 prompt tokens, 747 image tokens (the pricing page's count for 512px), and 300 thought tokens.
- `prompt-blocked.json`: `promptFeedback.blockReason` set and no candidates, so the prompt was refused before generation.
- `finish-image-safety.json`: a candidate that stopped with `IMAGE_SAFETY` and no image.
- `error-400-api-key.json`: an invalid key. Google answers this with HTTP 400 and an `ErrorInfo` reason of `API_KEY_INVALID`, not 401.
