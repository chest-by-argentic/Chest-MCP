// The files of a tool, as its Storage view reads them: a folder, a search,
// one file, and a private link — each checked before it is sent, its answer
// checked before it is given, the names fenced as untrusted data.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fakeChest, json, labEnv, spawnServer, type FakeChest, type Received } from "./harness.js";

let chest: FakeChest;
before(async () => (chest = await fakeChest()));
after(() => chest.close());

const sent = (): Received[] => chest.received.splice(0);

const usage = { bytes: 3000, objects: 3, quota: 1 << 30, max_objects: 10000, max_object: 32 << 20, asked: 1 << 30, set: false, choices: [] };
const cat = { name: "photos/cat.png", type: "image/png", size: 2000, updated: "2026-09-28T00:00:00Z", width: 640, height: 480 };

test("files_list: a folder, a search, one file; the next page's offset", async () => {
  chest.handle((request, response) => {
    const url = new URL(request.url, "https://chest");
    if (url.searchParams.has("name")) return json(response, 200, { file: cat });
    const folders = url.searchParams.has("q") ? [] : [{ name: "photos/", objects: 1, bytes: 2000 }];
    json(response, 200, { usage, folders, files: [{ name: "a.txt", type: "text/plain", size: 1000, updated: "2026-09-28T00:00:00Z" }], total: 250 });
  });
  sent();
  const server = spawnServer(labEnv(chest));
  const top = await server.tool("files_list", { app: "web" });
  assert.equal(top.isError, undefined);
  assert.equal(top.structuredContent.source, "files:web");
  assert.equal(top.structuredContent.data.folders[0].name, "photos/");
  assert.equal(top.structuredContent.next, 2);
  assert.match(top.content[0].text, /at the top: rows 1 to 2 of 250\. For the next page, call again with offset: 2\./u);
  const searched = await server.tool("files_list", { app: "web", q: "Cat", sort: "size", desc: true, offset: 200 });
  assert.equal(searched.structuredContent.next, 201);
  const one = await server.tool("files_list", { app: "web", name: "photos/cat.png" });
  assert.deepEqual(one.structuredContent.data, cat);
  assert.deepEqual(sent().map(request => [request.method, request.url]), [
    ["GET", "/api/v1/tools/web/files"],
    ["GET", "/api/v1/tools/web/files?q=Cat&sort=size&desc=1&offset=200"],
    ["GET", "/api/v1/tools/web/files?name=photos%2Fcat.png"],
  ]);
  await server.end();
});

test("files_list and files_link refuse what the Chest would, before anything is sent", async () => {
  const server = spawnServer(labEnv(chest));
  for (const args of [
    { app: "web", folder: "photos/", q: "cat" },
    { app: "web", name: "a.txt", sort: "size" },
    { app: "web", name: "../etc/passwd" },
    { app: "web", folder: "photos" },
    { app: "web", folder: "/" },
    { app: "web", sort: "type" },
    { app: "web", offset: -1 },
  ]) {
    assert.equal((await server.tool("files_list", args)).structuredContent.error, "invalid_arguments", JSON.stringify(args));
  }
  assert.equal((await server.tool("files_link", { app: "web", name: "a b" })).structuredContent.error, "invalid_arguments");
  assert.deepEqual(sent(), []);
  await server.end();
});

test("files_link: a private link, read not written, its answer checked", async () => {
  const link = "https://web-chest.atelier.example/_chest/files/eyJ0b29sIjoid2ViIn0.c2lnbmF0dXJl";
  chest.handle((_, response) => json(response, 200, { url: link, expires_in: 900 }));
  sent();
  const server = spawnServer(labEnv(chest));
  const result = await server.tool("files_link", { app: "web", name: "photos/cat.png", download: true });
  assert.deepEqual(result.structuredContent.data, { url: link, expires_in: 900 });
  assert.match(result.content[0].text, /valid 900 s; for the human who asked only/u);
  const [request] = sent();
  assert.equal(request!.url, "/api/v1/tools/web/files/url");
  assert.deepEqual(JSON.parse(request!.body), { name: "photos/cat.png", download: true });
  for (const url of ["http://web-chest.atelier.example/_chest/files/a.b", "https://evil.example/elsewhere", "https://a@evil.example/_chest/files/a.b"]) {
    chest.handle((_, response) => json(response, 200, { url, expires_in: 900 }));
    assert.equal((await server.tool("files_link", { app: "web", name: "a.txt" })).structuredContent.error, "invalid_answer", url);
  }
  chest.handle((_, response) => json(response, 404, { error: "not_found" }));
  assert.equal((await server.tool("files_link", { app: "web", name: "none.txt" })).structuredContent.error, "not_found");
  await server.end();
});

test("a storage the Chest answers in another shape is refused", async () => {
  const server = spawnServer(labEnv(chest));
  for (const body of [{ usage, folders: [], files: "x", total: 1 }, { usage, folders: [], files: [], total: -1 }, { folders: [], files: [], total: 0 }]) {
    chest.handle((_, response) => json(response, 200, body));
    assert.equal((await server.tool("files_list", { app: "web" })).structuredContent.error, "invalid_answer", JSON.stringify(body));
  }
  chest.handle((_, response) => json(response, 200, { file: "cat" }));
  assert.equal((await server.tool("files_list", { app: "web", name: "cat.png" })).structuredContent.error, "invalid_answer");
  sent();
  await server.end();
});
