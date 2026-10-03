import { ProviderError } from "./types.js";

// Shared by the providers that call a paid HTTP API (openai, gemini).

// Errors where the request never reached the provider, so it can't have been billed.
const UNSENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);

/** A failed fetch, as a ProviderError that says whether the request may have been billed. */
export function networkError(service: string, err: unknown, redact: (s: string) => string): ProviderError {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined;
  const code = cause && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  const reason = redact(code ?? cause?.message ?? (err instanceof Error ? err.message : String(err)));
  const unsent = code !== undefined && UNSENT_CODES.has(code);
  return new ProviderError(
    `Can't reach ${service} (${reason}).${unsent ? "" : " It may still have billed the request."}`,
    { notCharged: unsent },
  );
}

/** Removes the API key, and anything shaped like an OpenAI or Google key, from text bound for logs or Claude. */
export function redactKey(text: string, apiKey: string | undefined): string {
  // A very short "key" would mangle ordinary text; real keys are far longer.
  let out = apiKey && apiKey.length >= 8 ? text.split(apiKey).join("[redacted]") : text;
  out = out.replace(/sk-[A-Za-z0-9_*-]{8,}/g, "sk-[redacted]");
  out = out.replace(/AIza[A-Za-z0-9_-]{20,}/g, "AIza[redacted]");
  return out;
}

export function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
