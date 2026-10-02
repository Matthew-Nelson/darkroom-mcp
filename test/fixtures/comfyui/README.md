# ComfyUI fixtures

Recorded Oct 2, 2026 from a local ComfyUI 0.38.0 running `workflows/zimage.json` at 512×512, so the provider's HTTP parsing is tested offline.

- `prompt-200.json`, `prompt-400.json`: `POST /prompt` responses (the 400 is an unknown model file).
- `history-success.json`, `history-interrupted.json`: `GET /history/{id}` after a finished and an interrupted run. The `prompt` field is removed.
- `history-error.json`: hand-made from the interrupted run, following the `execution_error` shape in ComfyUI's `execution.py` (a real one couldn't be triggered on demand).
- `queue-*.json`: `GET /queue` with graphs elided.
- `ws-messages.json`: websocket text messages for the successful run, without the bulky `progress_state` messages.
- `object_info-*.json`, `system_stats.json` (trimmed): health-check responses.
- `view.png`: an 8×8 gray PNG standing in for the 466 KB render.
