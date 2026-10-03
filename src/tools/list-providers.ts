import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PAID_PROVIDERS, PROVIDER_NAMES, type Config, type ProviderName } from "../config.js";
import { formatUsd, type Ledger } from "../ledger.js";
import type { Quality } from "../providers/types.js";
import type { Router } from "../router.js";

const DESCRIPTION = `List Darkroom's image providers: which are enabled and healthy, which cost money and roughly how much per image, and today's paid spend against the daily cap.

Use this when the user asks which providers are available, why one wasn't used, or how much they've spent. It costs nothing and generates nothing.`;

// Paid providers need their key as well as a place in the order.
const KEY_VARS: Partial<Record<ProviderName, string>> = {
  openai: "DARKROOM_OPENAI_API_KEY",
  gemini: "DARKROOM_GEMINI_API_KEY",
};

// Estimates are for a square image and a typical prompt (paid text input is billed per token).
const SAMPLE_PROMPT = "a ceramic coffee mug on a wooden desk by a window, morning light, ".repeat(4);

const NOT_BUILT = "Not available in this version of Darkroom yet.";

const providerSchema = z.object({
  name: z.enum(PROVIDER_NAMES),
  enabled: z.boolean().describe("Listed in DARKROOM_PROVIDER_ORDER"),
  healthy: z.boolean().nullable().describe("null when the provider isn't enabled or isn't built yet"),
  detail: z.string().nullable().describe("Why the provider can't be used right now, how to enable it, or when it's used"),
  model: z.string().nullable(),
  paid: z.boolean(),
  estimated_cost_usd: z
    .object({ draft: z.number(), final: z.number() })
    .nullable()
    .describe("Estimated cost of one square image at each quality; null when not enabled"),
});

const outputSchema = {
  order: z.array(z.enum(PROVIDER_NAMES)).describe("DARKROOM_PROVIDER_ORDER"),
  allow_paid_fallback: z.boolean().describe("Whether a paid provider may serve a request after a free one was skipped or failed"),
  providers: z.array(providerSchema).describe("Enabled providers in order, then the rest"),
  spend: z.object({
    day_utc: z.string().describe("The cap resets at UTC midnight"),
    spent_usd: z
      .number()
      .nullable()
      .describe("Paid spend today, including requests still running; null if the ledger can't be read"),
    cap_usd: z.number(),
    remaining_usd: z.number().nullable(),
    error: z.string().nullable(),
  }),
};

export type ProviderStatus = { [K in keyof typeof outputSchema]: z.infer<(typeof outputSchema)[K]> };

export interface ListProvidersDeps {
  config: Config;
  router: Router;
  ledger: Ledger;
  implemented: ReadonlySet<ProviderName>;
}

export async function providerStatus(deps: ListProvidersDeps): Promise<ProviderStatus> {
  const { config, router, ledger, implemented } = deps;
  const order = config.providerOrder;
  const names = [...order, ...PROVIDER_NAMES.filter((n) => !order.includes(n))];

  const oneStatus = async (name: ProviderName): Promise<ProviderStatus["providers"][number]> => {
    const paid = PAID_PROVIDERS.has(name);
    const enabled = order.includes(name);
    const unbuilt = { name, enabled, healthy: null, model: null, paid, estimated_cost_usd: null };
    if (!implemented.has(name)) return { ...unbuilt, detail: NOT_BUILT };
    const provider = router.provider(name);
    if (!provider) {
      const key = KEY_VARS[name];
      return { ...unbuilt, detail: `Not enabled: add ${name} to DARKROOM_PROVIDER_ORDER${key ? ` and set ${key}` : ""}.` };
    }

    const health = await router.health(name, provider);
    const estimate = (quality: Quality) => provider.estimateCostUsd({ prompt: SAMPLE_PROMPT, aspectRatio: "1:1", quality });
    // The router never steps from a free provider to a paid one without the flag,
    // so a paid provider behind a free one is reachable only by name.
    const freeBefore = order.slice(0, order.indexOf(name)).find((n) => !PAID_PROVIDERS.has(n));
    let detail: string | null = null;
    if (!health.ok) detail = health.detail ?? "health check failed";
    else if (provider.isPaid && freeBefore && !config.allowPaidFallback) {
      detail = `Used only when asked for by name: ${freeBefore} comes first, and DARKROOM_ALLOW_PAID_FALLBACK is off.`;
    }
    return {
      name,
      enabled,
      healthy: health.ok,
      detail,
      model: provider.model,
      paid: provider.isPaid,
      estimated_cost_usd: { draft: estimate("draft"), final: estimate("final") },
    };
  };

  return {
    order,
    allow_paid_fallback: config.allowPaidFallback,
    providers: await Promise.all(names.map(oneStatus)),
    spend: await spend(ledger, config.dailyCapUsd),
  };
}

async function spend(ledger: Ledger, capUsd: number): Promise<ProviderStatus["spend"]> {
  const base = { day_utc: ledger.today(), cap_usd: capUsd };
  try {
    const spent = await ledger.spentTodayUsd();
    const remaining = Math.max(0, Math.round((capUsd - spent) * 1e6) / 1e6);
    return { ...base, spent_usd: spent, remaining_usd: remaining, error: null };
  } catch (err) {
    return { ...base, spent_usd: null, remaining_usd: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerListProviders(server: McpServer, deps: ListProvidersDeps): void {
  server.registerTool(
    "list_providers",
    {
      title: "List image providers",
      description: DESCRIPTION,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      const status = await providerStatus(deps);
      return {
        content: [{ type: "text", text: `${summarize(status)}\n\n${JSON.stringify(status)}` }],
        structuredContent: status,
      };
    },
  );
}

function summarize(s: ProviderStatus): string {
  const spent =
    s.spend.spent_usd === null
      ? `unknown (${s.spend.error ?? "ledger unreadable"})`
      : `${formatUsd(s.spend.spent_usd)} of ${formatUsd(s.spend.cap_usd)}`;
  const lines = [
    `Order: ${s.order.join(", ")}. Paid fallback: ${s.allow_paid_fallback ? "on" : "off"}.`,
    `Paid spend today (${s.spend.day_utc} UTC): ${spent}.`,
  ];
  for (const p of s.providers) {
    const parts = [p.model ? `${p.name} (${p.model})` : p.name];
    if (p.healthy !== null) parts.push(p.healthy ? "healthy" : "unhealthy");
    const cost = p.estimated_cost_usd;
    if (p.paid && cost) {
      parts.push(`paid, about ${formatUsd(cost.draft)} per draft and ${formatUsd(cost.final)} per final`);
    } else {
      parts.push(p.paid ? "paid" : "free");
    }
    lines.push(`${parts.join(", ")}.${p.detail ? ` ${p.detail}` : ""}`);
  }
  return lines.join("\n");
}
