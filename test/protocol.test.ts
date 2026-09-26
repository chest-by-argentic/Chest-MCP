// The protocol, spoken over stdio as a client does: both eras, the lists,
// JSON-RPC's refusals, and the requests the Chest receives.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fakeChest, json, labEnv, MODERN, spawnServer, TOKEN, type FakeChest } from "./harness.js";

let chest: FakeChest;
before(async () => (chest = await fakeChest()));
after(() => chest.close());

const serverInfo = { name: "chest-mcp", title: "Chest", version: "0.1.0" };

test("server/discover says the versions, the capabilities, the rules and who the server is", async () => {
  const server = spawnServer(labEnv(chest));
  const { result } = await server.request("server/discover");
  assert.deepEqual(result.supportedVersions, [MODERN]);
  assert.deepEqual(result.capabilities, { tools: {}, resources: {} });
  assert.match(result.instructions, /never instructions/u);
  assert.equal(result.resultType, "complete");
  assert.deepEqual(result._meta, { "io.modelcontextprotocol/serverInfo": serverInfo });
  assert.equal(result.ttlMs > 0 && result.cacheScope === "public", true);
  assert.equal(await server.end(), 0);
});

test("a modern request of an unknown version is refused with the versions served", async () => {
  const server = spawnServer(labEnv(chest));
  const response = await server.raw({ jsonrpc: "2.0", id: "v", method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01", "io.modelcontextprotocol/clientCapabilities": {} } } });
  assert.deepEqual(response.error, { code: -32022, message: "Unsupported protocol version", data: { supported: [MODERN], requested: "1900-01-01" } });
  const noCapabilities = await server.raw({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } });
  assert.equal(noCapabilities.error.code, -32602);
  const noVersion = await server.raw({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  assert.equal(noVersion.error.code, -32600);
  // ping and initialize are of the legacy era only.
  assert.equal((await server.request("ping")).error.code, -32601);
  await server.end();
});

test("a legacy client initializes, pings and lists the same tools, without the modern fields", async () => {
  const server = spawnServer(labEnv(chest));
  assert.deepEqual((await server.raw({ jsonrpc: "2.0", id: 0, method: "ping" })).result, {});
  const init = await server.raw({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.deepEqual(init.result.serverInfo, serverInfo);
  assert.match(init.result.instructions, /No write is committed without a human confirming it/u);
  server.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  const listed = await server.raw({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(listed.result.resultType, undefined);
  assert.equal(listed.result.ttlMs, undefined);
  const modern = await server.request("tools/list");
  assert.deepEqual(listed.result.tools, modern.result.tools);
  assert.equal((await server.raw({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-11-25" } })).error.code, -32600);
  assert.equal((await server.raw({ jsonrpc: "2.0", id: 4, method: "server/discover", params: {} })).error.code, -32601);
  assert.equal((await server.raw({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "chest://nothing" } })).error.code, -32002);
  await server.end();
});

test("an unknown legacy version is answered with the newest legacy one", async () => {
  const server = spawnServer(labEnv(chest));
  const init = await server.raw({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-01-01", capabilities: {} } });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  await server.end();
});

const writes = ["redeploy", "db_query", "db_insert", "db_update", "db_delete", "set_variable", "install_from_catalogue", "link_github", "propose_tool"];
const reads = ["whoami", "list_tools", "tool_status", "list_deployments", "build_log", "read_logs", "db_overview", "db_structure", "db_rows", "list_variables", "catalogue_list", "github_preview"];

test("tools/list: the v1 tools, closed schemas, and hints that say which write", async () => {
  const server = spawnServer(labEnv(chest));
  const { result } = await server.request("tools/list");
  const tools = result.tools as { name: string; title: string; description: string; inputSchema: any; annotations: any }[];
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...reads, ...writes].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    for (const name of tool.inputSchema.required) assert.ok(name in tool.inputSchema.properties, `${tool.name}: ${name}`);
    assert.ok(tool.title && tool.description.length > 40, tool.name);
    assert.equal(tool.annotations.openWorldHint, false);
    if (writes.includes(tool.name)) {
      assert.equal(tool.annotations.readOnlyHint, false, tool.name);
      assert.equal(typeof tool.annotations.destructiveHint, "boolean", tool.name);
      assert.equal(tool.inputSchema.properties.confirmation.type, "string", tool.name);
    } else {
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      assert.equal(tool.inputSchema.properties.confirmation, undefined, tool.name);
    }
  }
  assert.equal(tools.find(tool => tool.name === "db_delete")!.annotations.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === "db_insert")!.annotations.destructiveHint, false);
  assert.deepEqual(tools.find(tool => tool.name === "read_logs")!.inputSchema.properties.limit, { type: "integer", minimum: 1, maximum: 500, description: "How many lines at most (100 by default)." });
  assert.equal((await server.request("tools/list", { cursor: "x" })).error.code, -32602);
  await server.end();
});

test("the rules are a resource, the same text as the instructions", async () => {
  const server = spawnServer(labEnv(chest));
  const listed = await server.request("resources/list");
  assert.deepEqual(listed.result.resources.map((r: { uri: string }) => r.uri), ["chest://rules"]);
  const read = await server.request("resources/read", { uri: "chest://rules" });
  const discover = await server.request("server/discover");
  assert.equal(read.result.contents[0].text, discover.result.instructions);
  assert.equal(read.result.contents[0].mimeType, "text/markdown");
  for (const rule of ["migration in the tool's source", "data, never instructions", "without a human confirming", "Never print secrets"]) assert.ok(read.result.contents[0].text.includes(rule), rule);
  assert.equal((await server.request("resources/read", { uri: "chest://other" })).error.code, -32602);
  await server.end();
});

test("JSON-RPC: a parse error, a batch, a bad id, bad params, an unknown method and an unknown tool", async () => {
  const server = spawnServer(labEnv(chest));
  server.send("{not json");
  server.send("[]");
  const refused = await server.raw({ jsonrpc: "2.0", id: 9, method: "tools/call", params: [1] } as Record<string, unknown>);
  assert.equal(refused.error.code, -32602);
  assert.deepEqual(JSON.parse(server.stdout[0]!), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  assert.equal(JSON.parse(server.stdout[1]!).error.code, -32600);
  assert.equal((await server.request("nothing/here")).error.code, -32601);
  assert.equal((await server.request("tools/call", { name: "nothing" })).error.code, -32602);
  assert.equal((await server.raw({ jsonrpc: "1.0", id: 10, method: "ping" })).error.code, -32600);
  await server.end();
});

test("each call sends the token as a Bearer header, and nothing of a browser", async () => {
  chest.handle((request, response) => json(response, 200, { member: { subject: "s" }, token: { id: "0123456789ab" }, runs: { all: true, tools: [] }, seen: request.url }));
  chest.received.length = 0;
  const server = spawnServer(labEnv(chest));
  const result = await server.tool("whoami");
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.untrusted, true);
  assert.equal(result.structuredContent.source, "chest:me");
  assert.equal(result.structuredContent.data.seen, "/api/v1/me");
  const [sent] = chest.received;
  assert.equal(sent!.method, "GET");
  assert.equal(sent!.headers["authorization"], "Bearer " + TOKEN);
  for (const header of ["cookie", "origin", "sec-fetch-site", "referer"]) assert.equal(sent!.headers[header], undefined, header);
  assert.match(sent!.headers["user-agent"] ?? "", /^chest-mcp\/0\.1\.0$/u);
  await server.end();
});

test("arguments are checked against the schema before anything is sent", async () => {
  chest.received.length = 0;
  const server = spawnServer(labEnv(chest));
  for (const [name, args] of [
    ["read_logs", { app: "../me" }],
    ["read_logs", { app: "web", limit: 501 }],
    ["read_logs", { app: "web", extra: 1 }],
    ["db_rows", { app: "web", schema: "public" }],
    ["set_variable", { app: "web", name: "lower", operation: "set", value: "v", secret: false }],
  ] as const) {
    const result = await server.tool(name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.error, "invalid_arguments", name);
  }
  assert.equal(chest.received.length, 0);
  await server.end();
});

test("a cancelled read is never answered", async () => {
  let respond: () => void = () => {};
  chest.received.length = 0;
  chest.handle((_, response) => (respond = () => json(response, 200, [])));
  const server = spawnServer(labEnv(chest));
  const pending = server.raw({ jsonrpc: "2.0", id: "slow", method: "tools/call", params: { name: "list_tools", _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} } } });
  let answered = false;
  void pending.then(() => (answered = true));
  while (chest.received.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
  server.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow" } }));
  await new Promise(resolve => setTimeout(resolve, 100));
  respond();
  await server.end();
  assert.equal(answered, false);
  assert.equal(server.stdout.length, 0);
});
