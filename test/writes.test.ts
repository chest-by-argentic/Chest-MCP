// Writes: a dry run first, then the commit with the confirmation it gave —
// the same request, once, within five minutes —; never sent again when its
// outcome is uncertain. And the Chest's refusals, as results the model reads.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fakeChest, json, labEnv, spawnServer, type FakeChest, type Received } from "./harness.js";

let chest: FakeChest;
before(async () => (chest = await fakeChest()));
after(() => chest.close());

const sent = (): Received[] => chest.received.splice(0);

/** A console that answers a statement as the Chest does, and remembers commits. */
function console_(): { committed: string[] } {
  const state = { committed: [] as string[] };
  chest.handle((request, response) => {
    const body = JSON.parse(request.body || "{}") as { sql?: string; write?: boolean; commit?: boolean };
    if (body.commit) state.committed.push(body.sql ?? "");
    json(response, 200, { columns: [], rows: [], truncated: false, command: "UPDATE", affected: 3, committed: Boolean(body.commit), ms: 1 });
  });
  return state;
}

test("a statement that writes: the Chest's dry run, then the commit with the confirmation, once", async () => {
  const state = console_();
  sent();
  const server = spawnServer(labEnv(chest));
  const request = { app: "webdb", sql: "UPDATE notes SET text = 'x'", write: true };
  const dry = await server.tool("db_query", request);
  assert.equal(dry.isError, undefined);
  assert.equal(dry.structuredContent.dryRun, true);
  assert.equal(dry.structuredContent.affected, 3);
  assert.match(dry.structuredContent.summary, /UPDATE notes SET text = 'x'/u);
  assert.match(dry.structuredContent.confirmation, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u);
  assert.match(dry.content[0].text, /^DRY RUN: nothing was changed\./u);
  assert.equal(dry.structuredContent.preview.untrusted, true);
  const [dryRequest] = sent();
  assert.deepEqual(JSON.parse(dryRequest!.body), { sql: request.sql, write: true });
  assert.equal(dryRequest!.url, "/api/v1/tools/webdb/database/query");

  const commit = await server.tool("db_query", { ...request, confirmation: dry.structuredContent.confirmation });
  assert.equal(commit.structuredContent.committed, true);
  assert.deepEqual(state.committed, [request.sql]);
  assert.deepEqual(JSON.parse(sent()[0]!.body), { sql: request.sql, write: true, commit: true });

  // The same confirmation again: refused, nothing sent.
  const again = await server.tool("db_query", { ...request, confirmation: dry.structuredContent.confirmation });
  assert.equal(again.structuredContent.error, "confirmation_unknown");
  assert.deepEqual(sent(), []);
  assert.deepEqual(state.committed, [request.sql]);
  await server.end();
});

test("a confirmation for another request, or invented, commits nothing", async () => {
  const state = console_();
  const server = spawnServer(labEnv(chest));
  const request = { app: "webdb", sql: "DELETE FROM notes WHERE id = 1", write: true };
  const dry = await server.tool("db_query", request);
  sent();
  const changed = await server.tool("db_query", { ...request, sql: "DELETE FROM notes", confirmation: dry.structuredContent.confirmation });
  assert.equal(changed.structuredContent.error, "confirmation_mismatch");
  assert.equal(changed.isError, true);
  // Spent by the attempt: the right request cannot use it after.
  assert.equal((await server.tool("db_query", { ...request, confirmation: dry.structuredContent.confirmation })).structuredContent.error, "confirmation_unknown");
  const [nonce] = dry.structuredContent.confirmation.split(".");
  assert.equal((await server.tool("db_query", { ...request, confirmation: `${nonce}.forged` })).structuredContent.error, "confirmation_unknown");
  assert.equal((await server.tool("db_query", { ...request, confirmation: "nothing" })).structuredContent.error, "confirmation_unknown");
  // A read needs no confirmation and takes none.
  assert.equal((await server.tool("db_query", { app: "webdb", sql: "SELECT 1", confirmation: "x" })).structuredContent.error, "invalid_arguments");
  assert.deepEqual(sent(), []);
  assert.deepEqual(state.committed, []);
  await server.end();
});

test("a confirmation is bound to its tool and to the process that gave it", async () => {
  console_();
  const server = spawnServer(labEnv(chest));
  const dry = await server.tool("db_insert", { app: "webdb", schema: "public", table: "notes", values: { text: "a" } });
  sent();
  const other = await server.tool("db_delete", { app: "webdb", schema: "public", table: "notes", key: ["1"], version: "7", confirmation: dry.structuredContent.confirmation });
  assert.equal(other.structuredContent.error, "confirmation_mismatch");
  const dryAgain = await server.tool("db_insert", { app: "webdb", schema: "public", table: "notes", values: { text: "a" } });
  await server.end();
  const restarted = spawnServer(labEnv(chest));
  const late = await restarted.tool("db_insert", { app: "webdb", schema: "public", table: "notes", values: { text: "a" }, confirmation: dryAgain.structuredContent.confirmation });
  assert.equal(late.structuredContent.error, "confirmation_unknown");
  assert.deepEqual(sent(), []);
  await restarted.end();
});

test("a commit whose answer is lost is uncertain, and never sent again", async () => {
  const server = spawnServer(labEnv(chest));
  const request = { app: "webdb", schema: "public", table: "notes", key: ["1"], version: "7" };
  const dry = await server.tool("db_delete", request);
  assert.equal(dry.structuredContent.dryRun, true);
  assert.deepEqual(sent(), [], "the dry run of a row is described, not sent");
  // The Chest takes the request, then the connection goes before any answer.
  chest.handle((_, response) => response.socket?.destroy());
  const lost = await server.tool("db_delete", { ...request, confirmation: dry.structuredContent.confirmation });
  assert.equal(lost.isError, true);
  assert.equal(lost.structuredContent.uncertain, true);
  assert.match(lost.content[0].text, /UNCERTAIN.*Do not send it again/u);
  assert.equal(sent().length, 1);
  const retried = await server.tool("db_delete", { ...request, confirmation: dry.structuredContent.confirmation });
  assert.equal(retried.structuredContent.error, "confirmation_unknown");
  assert.deepEqual(sent(), []);
  // A 5xx on a commit is uncertain too; a 4xx is a refusal, certain.
  chest.handle((_, response) => json(response, 503, { error: "unavailable" }));
  const redeploy = await server.tool("redeploy", { app: "webdb" });
  const failed = await server.tool("redeploy", { app: "webdb", confirmation: redeploy.structuredContent.confirmation });
  assert.equal(failed.structuredContent.uncertain, true);
  assert.equal(sent().length, 1);
  await server.end();
});

test("the Chest's refusals come back as tool errors, in its code and what it means", async () => {
  const server = spawnServer(labEnv(chest));
  const cases: [number, Record<string, unknown>, Record<string, string>, RegExp][] = [
    [403, { error: "read_only", reason: "this token only reads" }, {}, /only reads/u],
    [403, { error: "narrowed", reason: "a token narrowed to tools has none of the rights of the whole Chest" }, {}, /narrowed to some tools/u],
    [403, { error: "not_for_agents", reason: "replacing a tool is decided in the Chest" }, {}, /decided in the Chest, by a human/u],
    [401, { error: "invalid_token" }, { "WWW-Authenticate": 'Bearer error="invalid_token"' }, /unknown, expired or revoked/u],
    [429, { error: "rate_limited" }, { "Retry-After": "17" }, /Wait 17 s/u],
  ];
  for (const [status, body, headers, words] of cases) {
    chest.handle((_, response) => json(response, status, body, headers));
    const result = await server.tool("catalogue_list");
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, body["error"]);
    assert.equal(result.structuredContent.status, status);
    assert.equal(result.structuredContent.uncertain, false);
    assert.match(result.content[0].text, words);
  }
  chest.handle((_, response) => json(response, 429, { error: "rate_limited" }, { "Retry-After": "3" }));
  assert.equal((await server.tool("whoami")).structuredContent.retryAfter, 3);
  // A change of structure: the migration the Chest proposes, as untrusted data.
  chest.handle((_, response) => json(response, 422, { error: "structure", migration: { name: "0002_add_pinned.sql", sql: "ALTER TABLE notes ADD pinned boolean" } }));
  const structure = await server.tool("db_query", { app: "webdb", sql: "ALTER TABLE notes ADD pinned boolean", write: true });
  assert.equal(structure.structuredContent.error, "structure");
  assert.equal(structure.structuredContent.details.data.migration.name, "0002_add_pinned.sql");
  assert.match(structure.content[0].text, /migration in the tool's source/u);
  sent();
  await server.end();
});

test("installing from the catalogue approves exactly the entry the dry run showed", async () => {
  const entry = { name: "forms", title: "Formulaires", repository: "chest-by-argentic/forms", commit: "a".repeat(40), permissions: ["public"], roles: ["editor"], approval: "b".repeat(64), state: "available" };
  chest.handle((request, response) => (request.method === "GET" ? json(response, 200, { state: "ready", tools: [entry] }) : json(response, 202, { state: "installing" })));
  sent();
  const server = spawnServer(labEnv(chest));
  const dry = await server.tool("install_from_catalogue", { name: "forms" });
  assert.equal(dry.structuredContent.preview.data.commit, entry.commit);
  assert.deepEqual(dry.structuredContent.preview.data.permissions, ["public"]);
  assert.equal(dry.structuredContent.preview.source, "catalogue:forms");
  const done = await server.tool("install_from_catalogue", { name: "forms", confirmation: dry.structuredContent.confirmation });
  assert.equal(done.structuredContent.committed, true);
  const [read, install] = sent();
  assert.equal(read!.url, "/api/v1/catalogue");
  assert.deepEqual(JSON.parse(install!.body), { name: "forms", approval: entry.approval });
  const missing = await server.tool("install_from_catalogue", { name: "nothing" });
  assert.equal(missing.structuredContent.error, "not_found");
  await server.end();
});

test("a variable: its dry run reads names, its commit sends the value once; values are never shown", async () => {
  chest.handle((request, response) =>
    request.method === "GET"
      ? json(response, 200, { variables: [{ name: "API_KEY", secret: true }, { name: "MODE", secret: false, value: "plain-value" }], expected: ["API_KEY", "MODE", "REGION"] })
      : response.writeHead(204).end(),
  );
  sent();
  const server = spawnServer(labEnv(chest));
  const listed = await server.tool("list_variables", { app: "web" });
  assert.deepEqual(listed.structuredContent.data, { variables: [{ name: "API_KEY", secret: true }, { name: "MODE", secret: false }], expected: ["API_KEY", "MODE", "REGION"], missing: ["REGION"] });
  assert.ok(!JSON.stringify(listed).includes("plain-value"));
  const args = { app: "web", name: "API_KEY", operation: "set", value: "very-secret-value", secret: true };
  const dry = await server.tool("set_variable", args);
  assert.match(dry.structuredContent.summary, /as a secret.*replacing its value \(secret\).*expects it/u);
  const done = await server.tool("set_variable", { ...args, confirmation: dry.structuredContent.confirmation });
  assert.equal(done.structuredContent.committed, true);
  assert.ok(!(server.stdout.join("\n") + server.stderr()).includes("very-secret-value"));
  const posted = sent().filter(request => request.method === "POST");
  assert.deepEqual(posted.map(request => JSON.parse(request.body)), [{ operation: "set", name: "API_KEY", value: "very-secret-value", secret: true }]);
  assert.equal((await server.tool("set_variable", { app: "web", name: "API_KEY", operation: "set", value: "v" })).structuredContent.error, "invalid_arguments");
  assert.equal((await server.tool("set_variable", { app: "web", name: "NOPE", operation: "remove" })).structuredContent.error, "not_found");
  await server.end();
});

test("a proposal: from the catalogue by name, or from GitHub by repository and branch, never both", async () => {
  chest.handle((request, response) => (request.url === "/api/v1/github/read" ? json(response, 200, { name: "todo", permissions: [], roles: [], commit: "c".repeat(40) }) : json(response, 201, { id: "p1" })));
  sent();
  const server = spawnServer(labEnv(chest));
  assert.equal((await server.tool("propose_tool", { source: "github", name: "forms" })).structuredContent.error, "invalid_arguments");
  assert.equal((await server.tool("propose_tool", { source: "catalogue", name: "forms", repository: "a/b" })).structuredContent.error, "invalid_arguments");
  const args = { source: "github", repository: "PaulWCZ/todo", branch: "main" };
  const dry = await server.tool("propose_tool", args);
  assert.equal(dry.structuredContent.preview.source, "github:PaulWCZ/todo@main");
  await server.tool("propose_tool", { ...args, confirmation: dry.structuredContent.confirmation });
  const [read, proposed] = sent();
  assert.deepEqual(JSON.parse(read!.body), { repository: "PaulWCZ/todo", branch: "main" });
  assert.equal(proposed!.url, "/api/v1/proposals");
  assert.deepEqual(JSON.parse(proposed!.body), args);
  await server.end();
});
