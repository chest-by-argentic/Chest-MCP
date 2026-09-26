#!/usr/bin/env node
// chest-mcp: the MCP server of a Chest, over stdio. It reads CHEST_URL and
// CHEST_TOKEN (and CHEST_MCP_LAB, for a lab) from its environment, then
// serves the client that launched it until its input ends.
import { Chest } from "./chest.js";
import { ConfigError, readConfig } from "./config.js";
import { Confirmations } from "./confirm.js";
import { serve } from "./rpc.js";
import { Server } from "./server.js";

const report = (line: string) => process.stderr.write(`chest-mcp: ${line}\n`);

let config;
try {
  config = readConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  report(error.message);
  process.exit(2);
}
// The token lives in the configuration only: nothing this process runs or
// prints later finds it in its environment.
delete process.env["CHEST_TOKEN"];
const { token } = config;
const secret = token.slice(token.lastIndexOf("_") + 1);
// Whatever the server writes, the token and its secret never leave it.
const redact = (text: string) => text.split(token).join("[CHEST_TOKEN]").split(secret).join("[CHEST_TOKEN]");

await serve(process.stdin, process.stdout, new Server(new Chest(config), new Confirmations()), redact, line => report(redact(line)));
