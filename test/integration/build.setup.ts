import { execFileSync } from "node:child_process";

// The stdio tests spawn the compiled server, exactly as `claude mcp add` would.
export default function setup(): void {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
}
