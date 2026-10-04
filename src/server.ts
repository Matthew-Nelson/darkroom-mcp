import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { Ledger } from "./ledger.js";
import { createProviders, IMPLEMENTED_PROVIDERS } from "./providers/registry.js";
import { Router } from "./router.js";
import { Storage } from "./storage.js";
import { registerCheckContrast } from "./tools/check-contrast.js";
import { registerGenerateImage } from "./tools/generate-image.js";
import { registerListImages } from "./tools/list-images.js";
import { registerListProviders } from "./tools/list-providers.js";
import { registerSaveAltText } from "./tools/save-alt-text.js";

// Resolved relative to this module so it works from dist/ and from an npx install.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export async function createServer(config: Config): Promise<McpServer> {
  const storage = await Storage.open(config.outputDir);
  const ledger = Ledger.inDir(storage.root);
  const router = new Router(config, await createProviders(config), ledger);
  const server = new McpServer({ name: "darkroom", title: "Darkroom", version: pkg.version });
  registerGenerateImage(server, { router, storage });
  registerListProviders(server, { config, router, ledger, implemented: IMPLEMENTED_PROVIDERS });
  registerListImages(server, { storage });
  registerSaveAltText(server, { storage });
  registerCheckContrast(server, { storage });
  return server;
}
