// The MCP methods this server answers, in both eras of the protocol:
//
// - modern (2026-07-28): no handshake; every request carries its protocol
//   version and the client's capabilities in _meta, and is served alone;
//   server/discover says what the server is;
// - legacy (2025-11-25 and before): initialize opens the session of this
//   process, ping answers, requests without _meta follow.
//
// Tools and resources are the same in both; a modern result also says its
// resultType, how long it may be cached, and the server's identity.
import type { Chest } from "./chest.js";
import type { Confirmations } from "./confirm.js";
import { RULES, RULES_URI } from "./rules.js";
import { call, definitions } from "./tools.js";
import { VERSION } from "./version.js";

/** The protocol versions served per request (modern). */
export const MODERN_VERSIONS: readonly string[] = ["2026-07-28"];

/** The protocol versions served after initialize (legacy), newest first. */
export const LEGACY_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26"];

// Error codes: JSON-RPC's, and MCP's.
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** A resource unknown, before 2026-07-28 (INVALID_PARAMS since). */
const LEGACY_RESOURCE_NOT_FOUND = -32002;

const PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** A request refused, as a JSON-RPC error. */
export class RpcError extends Error {
  override readonly name = "RpcError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const serverInfo = { name: "chest-mcp", title: "Chest", version: VERSION };
const capabilities = { tools: {}, resources: {} };

/** How long a list may be cached: what this server offers never changes while it runs. */
const cache = { ttlMs: 3_600_000, cacheScope: "public" } as const;

type Params = Record<string, unknown>;

/** The MCP server of one Chest, for one process. */
export class Server {
  readonly #chest: Chest;
  readonly #confirmations: Confirmations;
  /** The legacy version initialize agreed on, if a legacy client opened. */
  #legacy: string | undefined;

  constructor(chest: Chest, confirmations: Confirmations) {
    this.#chest = chest;
    this.#confirmations = confirmations;
  }

  /** Answers a request: its result, or an RpcError thrown. */
  async request(method: string, params: Params, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (method === "initialize") return this.#initialize(params);
    const meta = params["_meta"];
    const version = meta !== null && typeof meta === "object" ? (meta as Params)[PROTOCOL_VERSION] : undefined;
    if (version !== undefined) {
      if (typeof version !== "string" || !MODERN_VERSIONS.includes(version)) {
        throw new RpcError(UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: MODERN_VERSIONS, requested: String(version) });
      }
      const declared = (meta as Params)[CLIENT_CAPABILITIES];
      if (declared === null || typeof declared !== "object" || Array.isArray(declared)) {
        throw new RpcError(INVALID_PARAMS, `${CLIENT_CAPABILITIES} is required in _meta`);
      }
      const result = await this.#serve(method, params, signal, true);
      return { ...result, resultType: "complete", _meta: { [SERVER_INFO]: serverInfo } };
    }
    // A legacy client may ping before it initializes.
    if (method === "ping") return {};
    if (this.#legacy === undefined) {
      throw new RpcError(INVALID_REQUEST, `No protocol version: send ${PROTOCOL_VERSION} in _meta, or initialize first for a version before 2026-07-28`, { supported: MODERN_VERSIONS });
    }
    return this.#serve(method, params, signal, false);
  }

  /** The legacy handshake: the client's version if served, the newest legacy one otherwise. */
  #initialize(params: Params): Record<string, unknown> {
    if (this.#legacy !== undefined) throw new RpcError(INVALID_REQUEST, "Already initialized");
    const requested = params["protocolVersion"];
    this.#legacy = typeof requested === "string" && LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0]!;
    return { protocolVersion: this.#legacy, capabilities, serverInfo, instructions: RULES };
  }

  async #serve(method: string, params: Params, signal: AbortSignal, modern: boolean): Promise<Record<string, unknown>> {
    const cached = modern ? cache : {};
    switch (method) {
      case "server/discover":
        if (!modern) break;
        return { supportedVersions: MODERN_VERSIONS, capabilities, instructions: RULES, ...cached };
      case "tools/list":
        refuseCursor(params);
        return { tools: definitions, ...cached };
      case "tools/call": {
        const name = params["name"];
        const args = params["arguments"] ?? {};
        if (typeof name !== "string") throw new RpcError(INVALID_PARAMS, "name is required");
        if (args === null || typeof args !== "object" || Array.isArray(args)) throw new RpcError(INVALID_PARAMS, "arguments must be an object");
        const outcome = await call(name, args as Params, { chest: this.#chest, confirmations: this.#confirmations, signal });
        if (!outcome) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name.slice(0, 100)}`);
        return outcome;
      }
      case "resources/list":
        refuseCursor(params);
        return {
          resources: [{ uri: RULES_URI, name: "rules", title: "Rules for agents on a Chest", description: "What an assistant must and must not do on a Chest.", mimeType: "text/markdown" }],
          ...cached,
        };
      case "resources/read":
        if (params["uri"] !== RULES_URI) throw new RpcError(modern ? INVALID_PARAMS : LEGACY_RESOURCE_NOT_FOUND, "Resource not found", { uri: String(params["uri"]).slice(0, 200) });
        return { contents: [{ uri: RULES_URI, mimeType: "text/markdown", text: RULES }], ...cached };
    }
    throw new RpcError(METHOD_NOT_FOUND, "Method not found");
  }
}

/** Every list fits in one page: no cursor was ever given out. */
function refuseCursor(params: Params): void {
  if (params["cursor"] !== undefined) throw new RpcError(INVALID_PARAMS, "Invalid cursor");
}
