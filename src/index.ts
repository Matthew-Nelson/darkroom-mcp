#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { log } from "./log.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = await createServer(config);
  await server.connect(new StdioServerTransport());
  log("info", "ready", { providers: config.providerOrder, outputDir: config.outputDir });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) log("error", err.message);
  else log("error", "failed to start", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
