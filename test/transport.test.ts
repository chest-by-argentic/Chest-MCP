// The stdio transport, in the process: lines bounded however their bytes
// are split, requests under way bounded, and an output that is full stops
// the reading.
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { MAX_LINE, serve } from "../src/rpc.js";

/** A request of exactly `bytes` bytes, line feed excluded. */
function sized(id: number, bytes: number, fill = "x"): Buffer {
  const empty = JSON.stringify({ jsonrpc: "2.0", id, method: "probe", params: { pad: "" } });
  const room = bytes - Buffer.byteLength(empty);
  const unit = Buffer.byteLength(fill);
  // What the fill cannot cover exactly is made up with ASCII.
  const pad = fill.repeat(Math.floor(room / unit)) + "x".repeat(room % unit);
  return Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "probe", params: { pad } }), "utf8");
}

/** A server whose requests wait until the test answers them. */
function held() {
  const calls: { id: unknown; answer: () => void }[] = [];
  const server = {
    request: (_method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>(resolve => calls.push({ id: params["id"], answer: () => resolve({ ok: true }) })),
  };
  return { calls, server };
}

/** Serves with a server that answers at once; returns what it served and wrote. */
async function run(chunks: Buffer[]): Promise<{ served: number; lines: Record<string, any>[] }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
  let served = 0;
  const server = { request: async () => (served++, { ok: true }) };
  const done = serve(input, output, server, text => text, () => {});
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await done;
  return { served, lines: written.trim().split("\n").map(line => JSON.parse(line) as Record<string, any>) };
}

/** Cuts bytes into pieces of the sizes given, the rest in one last piece. */
function split(bytes: Buffer, ...sizes: number[]): Buffer[] {
  const pieces: Buffer[] = [];
  let at = 0;
  for (const size of sizes) {
    pieces.push(bytes.subarray(at, at + size));
    at += size;
  }
  pieces.push(bytes.subarray(at));
  return pieces;
}

const tooLarge = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message too large" } };

test("the same oversized message is refused however its bytes are split", async () => {
  const oversized = Buffer.concat([sized(1, MAX_LINE + 1), Buffer.from("\n")]);
  const next = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "probe", params: {} }) + "\n");
  const stream = Buffer.concat([oversized, next]);
  const splits: [string, Buffer[]][] = [
    ["one chunk with the next message", [stream]],
    ["the line whole, then the next", [oversized, next]],
    ["halves", split(stream, stream.length >> 1)],
    ["the limit, then the rest", split(stream, MAX_LINE)],
    ["one byte past the limit, then the rest", split(stream, MAX_LINE + 1)],
    ["the line without its feed, then the feed", split(stream, oversized.length - 1)],
    ["64 KiB pieces", Array.from({ length: Math.ceil(stream.length / 65536) }, (_, i) => stream.subarray(i * 65536, (i + 1) * 65536))],
  ];
  for (const [name, chunks] of splits) {
    const { served, lines } = await run(chunks);
    assert.equal(served, 1, name);
    assert.deepEqual(lines, [tooLarge, { jsonrpc: "2.0", id: 2, result: { ok: true } }], name);
  }
});

test("the limit counts bytes: a line of the limit is served, one byte more is not", async () => {
  assert.equal((await run([Buffer.concat([sized(1, MAX_LINE), Buffer.from("\n")])])).served, 1);
  // Fewer characters than the limit, more bytes.
  const accented = sized(1, MAX_LINE + 1, "é");
  assert.ok(accented.toString("utf8").length < MAX_LINE);
  assert.deepEqual((await run([accented, Buffer.from("\n")])).lines, [tooLarge]);
  // A last message without its line feed is held to the same limit.
  assert.deepEqual((await run([sized(1, MAX_LINE + 1)])).lines, [tooLarge]);
  assert.equal((await run([sized(1, MAX_LINE)])).served, 1);
});

test("requests under way are bounded, and the input waits for room", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const { calls, server } = held();
  const done = serve(input, output, server, text => text, () => {}, 2);
  input.write(Array.from({ length: 5 }, (_, i) => JSON.stringify({ jsonrpc: "2.0", id: i, method: "probe", params: { id: i } }) + "\n").join(""));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(input.isPaused(), true);
  calls[0]!.answer();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call.id), [0, 1, 2]);
  input.end();
  for (let i = 1; i < 5; i++) {
    calls[i]!.answer();
    await new Promise(resolve => setImmediate(resolve));
  }
  await done;
  assert.equal(calls.length, 5);
});

test("a full output stops the reading until it drains", async () => {
  const input = new PassThrough();
  const flushed: (() => void)[] = [];
  const written: string[] = [];
  // An output that takes one line and holds it until the test flushes it.
  const output = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString("utf8"));
      flushed.push(callback);
    },
  });
  const served: unknown[] = [];
  const server = { request: async (_method: string, params: Record<string, unknown>) => (served.push(params["id"]), { ok: true }) };
  const done = serve(input, output, server, text => text, () => {});
  const line = (i: number) => JSON.stringify({ jsonrpc: "2.0", id: i, method: "probe", params: { id: i } }) + "\n";
  input.write(line(0));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(written.length, 1);
  // The first answer filled the output: the requests read after it wait.
  input.write(line(1) + line(2));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(served, [0]);
  assert.equal(input.isPaused(), true);
  input.end();
  while (served.length < 3 || flushed.length > 0) {
    flushed.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
  }
  await done;
  assert.deepEqual(served, [0, 1, 2]);
  assert.equal(written.length, 3);
});
