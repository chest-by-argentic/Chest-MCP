// Data that tools and people wrote — log lines, rows, build output, the text
// of a manifest, names — reaches the model as data, never as instructions:
// cleaned of what a terminal or a text renderer would act on, bounded, and
// fenced by a mark its author cannot know.
import { randomBytes } from "node:crypto";

/** How much of one piece of data is given: characters of its strings in all. */
export const DATA_BUDGET = 64 * 1024;

/** The longest string given whole; beyond, it is cut. */
const MAX_STRING = 8 * 1024;

/** What a response carries of untrusted data. */
export type Untrusted = {
  readonly untrusted: true;
  /** Where it comes from: `logs:<app>`, `rows:<app>`, `build:<name>`… */
  readonly source: string;
  readonly data: unknown;
  /** Some of it was left out or cut to stay within DATA_BUDGET. */
  readonly truncated?: true;
};

// Escape sequences of a terminal: CSI (ESC [ … final), OSC (ESC ] … BEL or
// ESC \), other two-byte ones (ESC x); and the same in their 8-bit forms.
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u009c]*[\u0007\u009c]?|\u001b[@-_]?/gu;
// Control characters but tab and line feed, and the characters that reorder
// or hide text (bidirectional overrides and isolates, zero-width marks).
const control = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/** A text as it may be shown: escape sequences and control characters removed. */
export function clean(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(ansi, "").replace(control, "");
}

/**
 * Wraps data from the Chest as untrusted: every string cleaned (keys
 * included), the whole bounded to DATA_BUDGET characters — a text given
 * alone cut there, a long string inside cut at MAX_STRING, the items and
 * fields past the budget left out —, `truncated` said; `cut` says the caller
 * already left some out.
 */
export function untrusted(source: string, data: unknown, cut = false): Untrusted {
  const state = { left: DATA_BUDGET, cut };
  const bounded = bound(data, state, DATA_BUDGET);
  return { untrusted: true, source: clean(source), data: bounded, ...(state.cut ? { truncated: true as const } : {}) };
}

/** A value within what is left of the budget, its strings within longest. */
function bound(value: unknown, state: { left: number; cut: boolean }, longest = MAX_STRING): unknown {
  if (typeof value === "string") {
    const text = clean(value);
    const room = Math.min(longest, Math.max(state.left, 0));
    state.left -= Math.min(text.length, room);
    if (text.length <= room) return text;
    state.cut = true;
    return text.slice(0, room) + "…";
  }
  if (value === null || typeof value !== "object") {
    state.left -= 8;
    return value;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      if (state.left <= 0) {
        state.cut = true;
        break;
      }
      items.push(bound(item, state));
    }
    return items;
  }
  const fields: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (state.left <= 0) {
      state.cut = true;
      break;
    }
    const name = clean(key);
    state.left -= name.length;
    fields[name] = bound(item, state);
  }
  return fields;
}

/**
 * The text form of untrusted data: fenced by `<untrusted-data source=…
 * id=…>` and `</untrusted-data id=…>`, id a random nonce drawn for this
 * response, so that no data can close the fence it does not know. A mark of
 * the fence inside the data is broken all the same, whatever its id.
 */
export function fence(value: Untrusted): string {
  const id = randomBytes(12).toString("hex");
  const body = typeof value.data === "string" ? value.data : JSON.stringify(value.data, null, 1);
  const inert = body.replace(/<(\/?untrusted-data)/giu, "\u2039$1");
  const note = value.truncated ? " truncated" : "";
  return `<untrusted-data source="${attribute(value.source)}" id="${id}"${note}>\n${inert}\n</untrusted-data id="${id}">`;
}

/** A value of an attribute of the fence: no quote, no angle bracket, no line. */
function attribute(text: string): string {
  return text.replace(/["<>\n]/gu, "_");
}
