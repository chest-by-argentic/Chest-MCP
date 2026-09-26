// The client of the API of the agents of a Chest (/api/v1): one HTTPS request
// per call, with the token in Authorization and nothing else of the caller —
// no cookie, no Origin —, over a fresh connection whose certificate is
// verified. A redirect is never followed, an answer is bounded, and nothing
// here ever puts the token in an error.
import { Agent, request } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";
import { VERSION } from "./version.js";

/** The largest answer read: a result of the console is 4 MiB at most. */
const MAX_ANSWER = 8 << 20;

/**
 * How long a request may take. Some routes of the Chest take their time on
 * purpose: a redeploy waits up to 130 s for the new instance, a read of
 * GitHub or of the catalogue up to 95 s.
 */
const TIMEOUT = 150_000;

/** What the Chest answered: the status and the body, JSON or text. */
export type Answer = {
  readonly status: number;
  /** The parsed JSON, the text of a text answer, or null for none (204). */
  readonly body: unknown;
};

/**
 * A request that did not end in an answer of the Chest. `code` is the
 * Chest's own (`read_only`, `narrowed`, `not_for_agents`, `rate_limited`,
 * `row_changed`…) or this client's (`unreachable`, `timeout`,
 * `redirect_refused`, `too_large`, `invalid_answer`). `uncertain` says a
 * write may or may not have been done: it must not be sent again.
 */
export class ChestError extends Error {
  override readonly name = "ChestError";
  constructor(
    readonly code: string,
    message: string,
    readonly details: {
      readonly status?: number;
      readonly reason?: string;
      /** Seconds to wait before another request (429). */
      readonly retryAfter?: number;
      /** What else the Chest said: a proposed migration, PostgreSQL's refusal. */
      readonly more?: Record<string, unknown>;
      readonly uncertain: boolean;
    },
  ) {
    super(message);
  }
}

/** A request of the API: its method, its path under /api/v1, its body. */
export type Call = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  /** A write: an answer that is not the Chest's leaves its outcome uncertain. */
  readonly write: boolean;
  /** Stops a read no one waits for any more; a write is never stopped. */
  readonly signal?: AbortSignal;
};

/** The Chest a server acts on. */
export class Chest {
  // No connection is kept between calls: each request is its own, and the
  // process ends as soon as its input does.
  readonly #agent = new Agent({ keepAlive: false });
  readonly #origin: string;
  readonly #token: string;

  constructor(config: Config) {
    this.#origin = config.origin;
    this.#token = config.token;
  }

  /**
   * Sends one request and reads its answer: the parsed body of a 2xx, a
   * ChestError otherwise. A request is sent once, never again.
   */
  send(call: Call): Promise<Answer> {
    const payload = call.body === undefined ? undefined : Buffer.from(JSON.stringify(call.body), "utf8");
    const headers: Record<string, string> = {
      Authorization: "Bearer " + this.#token,
      Accept: "application/json, text/plain",
      "User-Agent": "chest-mcp/" + VERSION,
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    return new Promise<Answer>((resolve, reject) => {
      // Before the TLS handshake ends, nothing reached the Chest: a failure
      // there is certain, whatever the request.
      let connected = false;
      const fail = (code: string, message: string, status?: number) =>
        reject(new ChestError(code, message, { ...(status === undefined ? {} : { status }), uncertain: call.write && connected }));
      const req = request(
        new URL("/api/v1" + call.path, this.#origin),
        {
          method: call.method,
          headers,
          agent: this.#agent,
          // Explicit, so that NODE_TLS_REJECT_UNAUTHORIZED cannot turn it off.
          rejectUnauthorized: true,
          timeout: TIMEOUT,
          ...(call.signal && !call.write ? { signal: call.signal } : {}),
        },
        response => {
          read(response, MAX_ANSWER).then(
            raw => {
              try {
                resolve(answer(response, raw, call.write));
              } catch (error) {
                reject(error);
              }
            },
            () => fail("too_large", "The answer of the Chest is larger than 8 MiB", response.statusCode),
          );
        },
      );
      req.on("socket", socket => socket.once("secureConnect", () => (connected = true)));
      req.on("timeout", () => req.destroy(new ChestError("timeout", "The Chest did not answer in time", { uncertain: call.write })));
      req.on("error", error => {
        if (error instanceof ChestError) {
          reject(new ChestError(error.code, error.message, { uncertain: call.write && connected }));
          return;
        }
        // The message of a network error is Node's, and never carries a
        // header; its code is enough to say what happened.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ABORT_ERR") fail("cancelled", "The request was cancelled");
        else fail("unreachable", `The Chest could not be reached (${code ?? "network error"})`);
      });
      req.end(payload);
    });
  }
}

/** Reads a response whole, or rejects beyond max bytes. */
function read(response: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        response.destroy();
        reject(new Error("too large"));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", reject);
  });
}

/**
 * The answer of a response read whole: its body for a 2xx; a ChestError
 * for anything else — the Chest's refusal `{error, reason?}` as it says it,
 * a redirect refused, a body that is not what the status promises.
 */
function answer(response: IncomingMessage, raw: Buffer, write: boolean): Answer {
  const status = response.statusCode ?? 0;
  const media = (response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (status >= 300 && status < 400) {
    throw new ChestError("redirect_refused", `The Chest answered a redirect (${status}); it is never followed: check CHEST_URL`, { status, uncertain: false });
  }
  let body: unknown = null;
  if (raw.length > 0) {
    const text = raw.toString("utf8");
    if (media === "application/json") {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    } else if (media === "text/plain") {
      body = text;
    } else {
      body = undefined;
    }
  }
  if (status >= 200 && status < 300) {
    if (body === undefined) throw new ChestError("invalid_answer", `The Chest answered ${status} with a body it never sends`, { status, uncertain: write });
    return { status, body };
  }
  // A 5xx leaves a write uncertain: the Chest may have acted before failing
  // (a redeploy not confirmed, an answer lost). A 4xx is a refusal.
  const uncertain = write && status >= 500;
  const refusal = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const code = typeof refusal["error"] === "string" ? refusal["error"] : `http_${status}`;
  const reason = typeof refusal["reason"] === "string" ? refusal["reason"] : undefined;
  const more = Object.fromEntries(Object.entries(refusal).filter(([key]) => key !== "error" && key !== "reason"));
  const retry = Number(response.headers["retry-after"]);
  throw new ChestError(code, `The Chest answered ${status} ${code}`, {
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(Object.keys(more).length > 0 ? { more } : {}),
    ...(status === 429 && Number.isInteger(retry) && retry >= 0 ? { retryAfter: retry } : {}),
    uncertain,
  });
}
