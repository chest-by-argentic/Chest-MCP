// What the tests run against: a fake Chest over HTTPS on loopback, with a
// certificate drawn for the run, and the server itself, spawned as a client
// spawns it, spoken to over its stdio.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The command a client runs: the compiled server. */
export const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

/** A token of the shape the Chest gives; its secret must never be printed. */
export const TOKEN = "chest_pat_0123456789ab_" + "S3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tx";

/** A request the fake Chest received. */
export type Received = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

/** How the fake Chest answers a request. */
export type Handler = (request: Received, response: ServerResponse) => void;

/** Answers JSON with a status. */
export function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

/** A self-signed certificate for localhost and 127.0.0.1, for one run. */
function certificate(): { key: Buffer; cert: Buffer; caFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "chest-mcp-test-"));
  const keyFile = join(dir, "key.pem");
  const caFile = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyFile, "-out", caFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyFile), cert: readFileSync(caFile), caFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fake Chest: its origin, what it received, and how to stop it. */
export type FakeChest = { origin: string; caFile: string; received: Received[]; handle: (handler: Handler) => void; close: () => Promise<void> };

export async function fakeChest(): Promise<FakeChest> {
  const { key, cert, caFile, cleanup } = certificate();
  const received: Received[] = [];
  let handler: Handler = (_, response) => json(response, 404, { error: "not_found" });
  const server: HttpsServer = createServer({ key, cert }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(entry);
      handler(entry, response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `https://127.0.0.1:${port}`,
    caFile,
    received,
    handle: next => (handler = next),
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(() => {
          cleanup();
          resolve();
        });
      }),
  };
}

/** The version of the protocol the tests speak, per request. */
export const MODERN = "2026-07-28";

/** A server spawned over stdio, and what it wrote. */
export type Spawned = {
  /** Sends a request with the modern _meta; resolves with its response. */
  request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>;
  /** Sends a request as it is, and resolves with its response. */
  raw: (message: Record<string, unknown>) => Promise<Record<string, any>>;
  /** Writes a line as it is (a notification, garbage). */
  send: (line: string) => void;
  /** Calls a tool; resolves with its result. */
  tool: (name: string, args?: Record<string, unknown>) => Promise<Record<string, any>>;
  /** Every line the server wrote: stdout, then stderr. */
  stdout: string[];
  stderr: () => string;
  /** Ends its input; resolves with its exit code. */
  end: () => Promise<number | null>;
  child: ChildProcessWithoutNullStreams;
};

/** Spawns the server as a client does, its environment given. */
export function spawnServer(env: Record<string, string>): Spawned {
  const child = spawn(process.execPath, [CLI], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: string[] = [];
  let stderr = "";
  const waiting = new Map<string, (message: Record<string, any>) => void>();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      stdout.push(line);
      const message = JSON.parse(line) as Record<string, any>;
      const key = JSON.stringify(message["id"]);
      waiting.get(key)?.(message);
      waiting.delete(key);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
  let next = 0;
  const raw = (message: Record<string, unknown>) =>
    new Promise<Record<string, any>>(resolve => {
      waiting.set(JSON.stringify(message["id"]), resolve);
      child.stdin.write(JSON.stringify(message) + "\n");
    });
  const request = (method: string, params: Record<string, unknown> = {}) =>
    raw({
      jsonrpc: "2.0",
      id: ++next,
      method,
      params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} } },
    });
  return {
    request,
    raw,
    send: line => child.stdin.write(line + "\n"),
    tool: async (name, args = {}) => {
      const response = await request("tools/call", { name, arguments: args });
      if (!response["result"]) throw new Error("tools/call failed: " + JSON.stringify(response["error"]));
      return response["result"];
    },
    stdout,
    stderr: () => stderr,
    end: () => {
      child.stdin.end();
      return exited;
    },
    child,
  };
}

/** The environment of a server pointed at a fake Chest. */
export function labEnv(chest: FakeChest, more: Record<string, string> = {}): Record<string, string> {
  return { CHEST_URL: chest.origin, CHEST_TOKEN: TOKEN, CHEST_MCP_LAB: "1", NODE_EXTRA_CA_CERTS: chest.caFile, ...more };
}
