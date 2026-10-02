# OpenAI fixtures

Responses from `POST /v1/images/generations`, so the provider's parsing is tested offline.

**Hand-made (Oct 2, 2026)** from the shapes in OpenAI's API reference and image generation guide, until a real response is recorded during the M2 acceptance run:

- `generations-200.json`: a success. `b64_json` is an 8×8 gray PNG; the token counts are made up.
- `error-moderation.json`: `moderation_blocked` at the input stage (shape from the image generation guide).
- `error-401.json`: an invalid key. OpenAI masks most of the key in this message; the fake key here is not real.
- `error-400-size.json`: a size under the 655,360-pixel minimum.
