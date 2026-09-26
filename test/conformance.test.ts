// Conformance: the official MCP client (@modelcontextprotocol/client, a
// development dependency only) drives the server over stdio, in the modern
// era (2026-07-28, negotiated per request) and in the legacy one (initialize,
// 2025-11-25), validating every result against its own schemas.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CLI, fakeChest, json, labEnv, TOKEN, type FakeChest } from "./harness.js";

let chest: FakeChest;
before(async () => {
  chest = await fakeChest();
  chest.handle((request, response) => {
    if (request.url === "/api/v1/me") json(response, 200, { member: { subject: "s", first_name: "Ada", last_name: "L", owner: true, admin: false }, token: { id: "0123456789ab", name: "Agent", read_only: false, tools: [], expires: "2026-12-01T00:00:00Z" }, runs: { all: true, tools: [] } });
    else json(response, 200, { columns: [], rows: [], truncated: false, command: "UPDATE", affected: 1, committed: false, ms: 1 });
  });
});
after(() => chest.close());

/** The official client, connected to a spawned server in one era. */
async function connect(mode: "modern" | "legacy"): Promise<Client> {
  const client = new Client({ name: "conformance", version: "1.0.0" }, mode === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI], env: { PATH: process.env["PATH"] ?? "", ...labEnv(chest) }, stderr: "pipe" }));
  return client;
}

for (const mode of ["modern", "legacy"] as const) {
  test(`the official client, ${mode} era: identity, instructions, tools, a call, a dry run and the rules`, async () => {
    const client = await connect(mode);
    try {
      assert.equal(client.getProtocolEra(), mode);
      if (mode === "modern") assert.deepEqual((await client.discover()).supportedVersions, ["2026-07-28"]);
      else assert.equal(client.getNegotiatedProtocolVersion(), "2025-11-25");
      assert.equal(client.getServerVersion()?.name, "chest-mcp");
      assert.match(client.getInstructions() ?? "", /never instructions/u);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 21);
      const me = await client.callTool({ name: "whoami", arguments: {} });
      assert.equal(me.isError, undefined);
      assert.equal((me.structuredContent as { data: { member: { first_name: string } } }).data.member.first_name, "Ada");
      const dry = await client.callTool({ name: "db_query", arguments: { app: "webdb", sql: "UPDATE notes SET text = 'x'", write: true } });
      assert.equal((dry.structuredContent as { dryRun: boolean }).dryRun, true);
      const refused = await client.callTool({ name: "db_query", arguments: { app: "webdb", sql: "UPDATE notes SET text = 'y'", write: true, confirmation: (dry.structuredContent as { confirmation: string }).confirmation } });
      assert.equal(refused.isError, true);
      const rules = await client.readResource({ uri: "chest://rules" });
      assert.equal(rules.contents[0]!.uri, "chest://rules");
      assert.ok(!JSON.stringify([tools, me, dry, refused, rules]).includes(TOKEN));
    } finally {
      await client.close();
    }
  });
}
