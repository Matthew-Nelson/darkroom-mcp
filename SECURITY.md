# Security

Darkroom is a portfolio project, maintained on a best-effort basis. Only the latest commit on `main` gets fixes.

## Reporting a problem

Please report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/Matthew-Nelson/darkroom-mcp/security/advisories/new), not in a public issue.

Things worth reporting:

- An API key showing up anywhere: tool results, errors, logs, sidecars, or the ledger.
- A way to spend money without opting in: a paid request that gets past the daily cap, the paid-provider settings, or `DARKROOM_ALLOW_PAID_FALLBACK`.
- A file written or read outside the output folder.

## How Darkroom is meant to run

- It's a local stdio server started by your MCP client. It doesn't listen on a port.
- Keys come only from environment variables, are sent only in the request header, and are removed from every error message.
- ComfyUI should listen on `127.0.0.1` (its default). Don't expose it with `--listen 0.0.0.0`: it has no authentication.
