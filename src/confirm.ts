// A write is two calls: a dry run, which hands out a confirmation, then the
// same request with that confirmation, once a human has said yes. The
// confirmation binds the exact request — the tool and its arguments — for
// five minutes, once: a request changed, late, replayed or without one is
// refused. It lives in this process's memory only.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How long a confirmation is valid. */
export const CONFIRMATION_TTL = 5 * 60 * 1000;

/** Confirmations kept at once; the oldest goes first beyond. */
const MAX_PENDING = 64;

/** Why a confirmation was refused. */
export type Refusal = "missing" | "unknown" | "expired" | "mismatch";

// A confirmation handed out: its nonce is the key it is kept under, its HMAC
// is checked against the request it comes back with.
type Pending = {
  readonly expires: number;
  /** What the dry run read and the commit sends as it was: a digest to approve. */
  readonly bound: Record<string, unknown>;
};

/** The confirmations handed out by this process. */
export class Confirmations {
  // The key of the HMAC, drawn for this process: a confirmation is worth
  // nothing to another, nor after a restart.
  readonly #key = randomBytes(32);
  readonly #pending = new Map<string, Pending>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Hands out the confirmation of a request: `<nonce>.<HMAC-SHA256(nonce,
   * canonical request)>`, valid CONFIRMATION_TTL. `bound` is kept with it.
   */
  issue(tool: string, args: Record<string, unknown>, bound: Record<string, unknown> = {}): { confirmation: string; expiresAt: string } {
    const now = this.#now();
    for (const [nonce, pending] of this.#pending) {
      if (pending.expires <= now) this.#pending.delete(nonce);
    }
    while (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value!);
    const nonce = randomBytes(16).toString("base64url");
    const expires = now + CONFIRMATION_TTL;
    this.#pending.set(nonce, { expires, bound });
    return { confirmation: `${nonce}.${this.#mac(nonce, tool, args).toString("base64url")}`, expiresAt: new Date(expires).toISOString() };
  }

  /**
   * Takes a confirmation for a request, once: whatever the outcome, it is
   * gone. It is valid only for the same tool and the same arguments, before
   * it expires; it then gives back what was bound to it.
   */
  redeem(tool: string, args: Record<string, unknown>, confirmation: string | undefined): { bound: Record<string, unknown> } | { refused: Refusal } {
    if (!confirmation) return { refused: "missing" };
    const [nonce, given, extra] = confirmation.split(".");
    const pending = nonce ? this.#pending.get(nonce) : undefined;
    if (!nonce || given === undefined || extra !== undefined || !pending) return { refused: "unknown" };
    this.#pending.delete(nonce);
    if (pending.expires <= this.#now()) return { refused: "expired" };
    const mac = Buffer.from(given, "base64url");
    const expected = this.#mac(nonce, tool, args);
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return { refused: "mismatch" };
    return { bound: pending.bound };
  }

  #mac(nonce: string, tool: string, args: Record<string, unknown>): Buffer {
    return createHmac("sha256", this.#key).update(nonce + "\n" + canonical({ tool, args })).digest();
  }
}

/** JSON with the keys of every object sorted: one text per value. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
