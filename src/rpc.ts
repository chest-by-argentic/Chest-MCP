// JSON-RPC 2.0 over the stdio transport of MCP: one message per line on the
// input, one per line on the output, nothing else ever written there. Lines
// are bounded; requests are served concurrently, each answered once, or
// never when the client cancelled it. Every line written goes through
// redact, which takes out what must never leave the process.
import type { Readable, Writable } from "node:stream";
import { INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, RpcError, type Server } from "./server.js";

/** The longest line read: a statement is 64 KiB, a request of the console 1 MiB. */
const MAX_LINE = 4 << 20;

const PARSE_ERROR = -32700;

type Id = string | number;

/**
 * Serves the messages of input on output until input ends and every
 * request under way is answered. `report` writes a line for the operator
 * (stderr); both it and the output get redacted text only.
 */
export function serve(input: Readable, output: Writable, server: Server, redact: (text: string) => string, report: (line: string) => void): Promise<void> {
  const running = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const write = (message: object) => output.write(redact(JSON.stringify(message)) + "\n");
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
      });
    pending.add(done);
  }

  return new Promise(resolve => {
    let buffer = "";
    // A line past MAX_LINE is dropped up to its end.
    let skipping = false;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/u, "");
        buffer = buffer.slice(end + 1);
        if (skipping) skipping = false;
        else if (line.trim() !== "") receive(line);
      }
      if (buffer.length > MAX_LINE) {
        if (!skipping) fail(null, INVALID_REQUEST, "Message too large");
        skipping = true;
        buffer = "";
      }
    });
    input.on("end", () => {
      // A last message without its line feed is read all the same.
      if (!skipping && buffer.trim() !== "") receive(buffer.replace(/\r$/u, ""));
      Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}
