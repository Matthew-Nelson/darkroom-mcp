import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { createProviders } from "./providers/registry.js";
import { Router } from "./router.js";
import { Storage } from "./storage.js";
import { registerGenerateImage } from "./tools/generate-image.js";

// Resolved relative to this module so it works from dist/ and from an npx install.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export async function createServer(config: Config): Promise<McpServer> {
  const storage = await Storage.open(config.outputDir);
  const router = new Router(config, await createProviders(config));
  const server = new McpServer({ name: "darkroom", title: "Darkroom", version: pkg.version });
  registerGenerateImage(server, { router, storage });
  return server;
}
