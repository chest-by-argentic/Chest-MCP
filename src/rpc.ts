// JSON-RPC 2.0 over the stdio transport of MCP: one message per line on the
// input, one per line on the output, nothing else ever written there. Every
// line is bounded, whole or still arriving, however its bytes are split.
// Requests are served concurrently up to the capacity of the process, each
// answered once, or never when the client cancelled it; past that capacity,
// or while the output is full, the input is no longer read. Every line
// written goes through redact, which takes out what must never leave the
// process.
import type { Readable, Writable } from "node:stream";
import { getHeapStatistics } from "node:v8";
import { MAX_ANSWER } from "./chest.js";
import { INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, RpcError, type Server } from "./server.js";

/** The longest line read, in bytes: a statement is 64 KiB, a request of the console 1 MiB. */
export const MAX_LINE = 4 << 20;

/**
 * How many requests may be under way at once: as many as half the heap
 * holds when each carries its largest line and its largest answer.
 */
const ACTIVE = Math.max(1, Math.floor(getHeapStatistics().heap_size_limit / 2 / (MAX_LINE + MAX_ANSWER)));

const PARSE_ERROR = -32700;
const LINE_FEED = 0x0a;

/** A line refused for its size, kept in its place among the lines read. */
const TOO_LARGE = Symbol("too large");

type Id = string | number;

/**
 * Serves the messages of input on output until input ends and every
 * request under way is answered. `report` writes a line for the operator
 * (stderr); both it and the output get redacted text only. `active` bounds
 * the requests under way (the capacity of the process by default).
 */
export function serve(
  input: Readable,
  output: Writable,
  server: Pick<Server, "request">,
  redact: (text: string) => string,
  report: (line: string) => void,
  active: number = ACTIVE,
): Promise<void> {
  const running = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  // The output is full: nothing more is read until it drains.
  let full = false;
  const write = (message: object) => {
    if (!output.write(redact(JSON.stringify(message)) + "\n") && !full) {
      full = true;
      output.once("drain", () => {
        full = false;
        pump();
      });
    }
  };
  const fail = (id: Id | null, code: number, message: string, data?: unknown) =>
    write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  function receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      fail(null, PARSE_ERROR, "Parse error");
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      fail(null, INVALID_REQUEST, "Invalid request: one JSON-RPC object per line, no batch");
      return;
    }
    const { jsonrpc, id, method, params } = message as Record<string, unknown>;
    const validId = typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
    if (jsonrpc !== "2.0" || (method === undefined && id === undefined)) {
      fail(validId ? (id as Id) : null, INVALID_REQUEST, "Invalid request");
      return;
    }
    // A response of the client: this server sends no request, it has none to read.
    if (method === undefined) return;
    if (typeof method !== "string" || (id !== undefined && !validId)) {
      fail(validId ? (id as Id) : null, INVALID_REQUEST, "Invalid request");
      return;
    }
    if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params))) {
      if (validId) fail(id as Id, INVALID_PARAMS, "params must be an object");
      return;
    }
    const given = (params ?? {}) as Record<string, unknown>;
    if (id === undefined) {
      if (method === "notifications/cancelled") {
        const target = given["requestId"];
        running.get(JSON.stringify(target))?.abort();
      }
      // Every other notification (initialized, …) asks nothing of this server.
      return;
    }
    const key = JSON.stringify(id);
    if (running.has(key)) {
      fail(id as Id, INVALID_REQUEST, "A request with this id is under way");
      return;
    }
    const controller = new AbortController();
    running.set(key, controller);
    const done = server
      .request(method, given, controller.signal)
      .then(
        result => {
          if (!controller.signal.aborted) write({ jsonrpc: "2.0", id, result });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof RpcError) {
            fail(id as Id, error.code, error.message, error.data);
            return;
          }
          report(`internal error on ${method}: ${error instanceof Error ? error.message : "unknown"}`);
          fail(id as Id, INTERNAL_ERROR, "Internal error");
        },
      )
      .finally(() => {
        running.delete(key);
        pending.delete(done);
        pump();
      });
    pending.add(done);
  }

  // The lines read and not yet served, in their order; the line still
  // arriving, in pieces, and its size; whether the rest of a line refused
  // for its size is being dropped.
  const lines: (string | typeof TOO_LARGE)[] = [];
  let pieces: Buffer[] = [];
  let size = 0;
  let skipping = false;
  let ended = false;
  let finish: () => void = () => {};

  // Cuts a chunk into lines. The limit counts every byte before the line
  // feed, so a line is refused whether it arrives whole or in pieces.
  function take(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(LINE_FEED, start);
      const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (!skipping) {
        size += piece.length;
        if (size > MAX_LINE) {
          lines.push(TOO_LARGE);
          skipping = true;
          pieces = [];
        } else if (piece.length > 0) pieces.push(piece);
      }
      if (end < 0) return;
      if (!skipping) queue();
      skipping = false;
      pieces = [];
      size = 0;
      start = end + 1;
    }
  }

  function queue(): void {
    const line = Buffer.concat(pieces, size).toString("utf8").replace(/\r$/u, "");
    if (line.trim() !== "") lines.push(line);
  }

  // Serves the lines read while there is room for another request and the
  // output takes more; reads again once every line is served.
  function pump(): void {
    while (lines.length > 0 && pending.size < active && !full) {
      const line = lines.shift()!;
      if (line === TOO_LARGE) fail(null, INVALID_REQUEST, "Message too large");
      else receive(line);
    }
    if (ended) {
      if (lines.length === 0 && pending.size === 0) finish();
    } else if (lines.length > 0 || full || pending.size >= active) input.pause();
    else input.resume();
  }


  return new Promise(resolve => {
    finish = resolve;
    input.on("data", (chunk: Buffer | string) => {
      take(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      pump();
    });
    input.on("end", () => {
      // A last message without its line feed is read all the same.
      if (!skipping && size > 0) queue();
      ended = true;
      pump();
    });
  });
}
