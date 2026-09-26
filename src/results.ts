// What a call of a tool answers: a text for the model and the same in
// structured form. The server's own words are said plainly; what the Chest
// returns of tools and people is untrusted, fenced in the text. An error of
// a tool — a refusal of the Chest, an argument refused — is a result with
// isError, so that the model can read it and act.
import { ChestError } from "./chest.js";
import type { Refusal } from "./confirm.js";
import { clean, fence, untrusted, type Untrusted } from "./untrusted.js";

/** The result of tools/call (CallToolResult). */
export type Outcome = {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: Record<string, unknown>;
  readonly isError?: true;
};

function outcome(text: string, structured: Record<string, unknown>, isError = false): Outcome {
  return { content: [{ type: "text", text }], structuredContent: structured, ...(isError ? { isError: true as const } : {}) };
}

/** Data read from the Chest: a line of the server's, then the data fenced. */
export function data(intro: string, value: Untrusted, extra: Record<string, unknown> = {}): Outcome {
  return outcome(`${intro}\n${fence(value)}`, { ...value, ...extra });
}

/** What a dry run says of a write, and what may commit it. */
export type Plan = {
  /** What would happen, in the server's words. */
  readonly summary: string;
  /** How many rows the write would change, when the Chest says it. */
  readonly affected?: number;
  /** What the Chest showed of what would be done: an entry, a manifest, rows. */
  readonly preview?: Untrusted;
};

/** A dry run: nothing was changed; how to commit once a human approves. */
export function dryRun(tool: string, plan: Plan, confirmation: string, expiresAt: string): Outcome {
  const lines = [
    "DRY RUN: nothing was changed.",
    plan.summary,
    ...(plan.affected === undefined ? [] : [`Rows that would change: ${plan.affected}.`]),
    `To commit, show this to the human and wait for their explicit approval; then call ${tool} again with the same arguments and "confirmation": "${confirmation}" (valid once, until ${expiresAt}).`,
    ...(plan.preview ? [fence(plan.preview)] : []),
  ];
  return outcome(lines.join("\n"), {
    dryRun: true,
    summary: plan.summary,
    ...(plan.affected === undefined ? {} : { affected: plan.affected }),
    confirmation,
    expiresAt,
    ...(plan.preview ? { preview: plan.preview } : {}),
  });
}

/** A write committed, and what the Chest answered of it. */
export function done(summary: string, result?: Untrusted): Outcome {
  return outcome(`Done: ${summary}${result ? "\n" + fence(result) : ""}`, { committed: true, summary, ...(result ? { result } : {}) });
}

/** The words of a confirmation refused. */
const confirmationWords: Record<Refusal, string> = {
  missing: "No confirmation was given.",
  unknown: "This confirmation is unknown: it was never given, or it was already used.",
  expired: "This confirmation expired (five minutes).",
  mismatch: "This confirmation was given for another request: the tool and every argument must be the same as in the dry run.",
};

/** A commit refused for its confirmation: nothing was sent to the Chest. */
export function confirmationRefused(tool: string, refusal: Refusal): Outcome {
  return outcome(`Refused, nothing was sent: ${confirmationWords[refusal]} Call ${tool} again without "confirmation" for a new dry run, and let the human approve it.`, { error: "confirmation_" + refusal }, true);
}

/** Arguments a tool refuses that its schema alone cannot say. */
export class ArgumentError extends Error {
  override readonly name = "ArgumentError";
}

/** Arguments refused before anything was sent. */
export function invalid(reason: string): Outcome {
  return outcome(`Invalid arguments, nothing was sent: ${clean(reason)}.`, { error: "invalid_arguments", reason: clean(reason) }, true);
}

/**
 * What a refusal of the Chest means for the model, by its code, or by its
 * code and status where one code says two things.
 */
const refusalWords: Record<string, string> = {
  invalid_token: "The token is unknown, expired or revoked. A member creates a new one in the Chest (Profile, « Jetons d'accès ») and sets it as CHEST_TOKEN.",
  "read_only 403": "This token only reads: it can neither write nor dry-run a write.",
  "read_only 422": "This is read-only here: a statement that writes needs write: true (a dry run first); a view, a table without a primary key or chest_migrations is never edited.",
  narrowed: "This token is narrowed to some tools: it has none of the rights of the whole Chest (catalogue, proposals, GitHub).",
  not_for_agents: "Replacing a tool is decided in the Chest, by a human, from its page.",
  forbidden: "The member of this token may not do this.",
  rate_limited: "Too many requests for this token.",
  row_changed: "The row changed since it was read: read it again (db_rows) and start from its new version.",
  sql: "PostgreSQL refused the statement; its words are below.",
  structure: "A change of structure is never run here: it is a migration in the tool's source (see chest://rules). The Chest proposes it below.",
  cancelled: "The request was cancelled.",
};

/**
 * A failure as a result: a refusal of the Chest in its own code with what
 * it means; an uncertain write said so, never to be sent again.
 */
export function failure(error: unknown): Outcome {
  if (error instanceof ArgumentError) return invalid(error.message);
  if (!(error instanceof ChestError)) {
    return outcome("The server failed on this request; nothing more is known.", { error: "internal_error" }, true);
  }
  const { status, reason, retryAfter, more, uncertain } = error.details;
  const lines = [error.message + (reason ? ` (${clean(reason).slice(0, 200)})` : "") + "."];
  const words = [`${error.code} ${status}`, error.code].find(key => Object.hasOwn(refusalWords, key));
  if (words) lines.push(refusalWords[words]!);
  if (retryAfter !== undefined) lines.push(`Wait ${retryAfter} s before another request.`);
  if (uncertain) lines.push("The outcome is UNCERTAIN: the write may or may not have been done. Do not send it again; read the state first and tell the human.");
  const details = more ? untrusted("chest:refusal", more) : undefined;
  if (details) lines.push(fence(details));
  return outcome(
    lines.join("\n"),
    {
      error: error.code,
      ...(status === undefined ? {} : { status }),
      ...(reason === undefined ? {} : { reason: clean(reason).slice(0, 200) }),
      ...(retryAfter === undefined ? {} : { retryAfter }),
      uncertain,
      ...(details ? { details } : {}),
    },
    true,
  );
}
