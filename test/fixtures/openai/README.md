# OpenAI fixtures

Responses from `POST /v1/images/generations`, so the provider's parsing is tested offline.

**Recorded Oct 2, 2026** from `gpt-image-2.5-flare` during the M2 benchmark (prompt: a ceramic mug on a desk reading DARKROOM). Response bodies only (no headers); `b64_json` is replaced with an 8×8 gray PNG. `usage` is real:

- `generations-200-low.json`: 816×816 at `low` (the `draft` tier): 29 text input tokens, 171 image output tokens, $0.005275.
- `generations-200-high.json`: 1024×1024 at `high`: 29 text input tokens, 1,756 image output tokens, $0.052825. `final` now renders at `medium` (decided after the benchmark), so Darkroom no longer requests `high`; this fixture still tests usage parsing on a real response.

**Recorded Oct 4, 2026** from `gpt-image-2.5-flare` during the M7 benchmark: `POST /v1/images/edits` with a reference image (prompt: the M2 fox café image, turned to night). Only `usage` was captured from these responses, and it's real; the rest copies `generations-200-low.json`'s shape, with the same 8×8 gray PNG:

- `edits-200-draft.json`: a 3:2 `draft` (992×672, `low`) from a 1248×832 reference: 1,014 image input tokens, 63 text input tokens, 118 image output tokens, $0.011967.
- `edits-200-large-reference.json`: the same request with the reference at the 2048px cap (2048×1365): 1,457 image input tokens, $0.015511. A 1024×1024 reference read as 1,024 tokens, so input tokens grow with the reference's pixel count.

**Hand-made** from the shapes in OpenAI's API reference and image generation guide:

- `error-moderation.json`: `moderation_blocked` at the input stage (shape from the image generation guide).
- `error-401.json`: an invalid key. The shape matches the real 401 seen during the benchmark (OpenAI masks the key in the message); the fake key here is not real.
- `error-400-size.json`: a size under the 655,360-pixel minimum.
