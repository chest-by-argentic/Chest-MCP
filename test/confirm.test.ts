// The confirmations themselves: bound to a request, for five minutes, once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, CONFIRMATION_TTL, Confirmations } from "../src/confirm.js";

test("a confirmation serves once, for the same request, in any order of its keys", () => {
  const confirmations = new Confirmations();
  const { confirmation } = confirmations.issue("db_query", { app: "web", sql: "DELETE", write: true }, { approval: "x" });
  assert.deepEqual(confirmations.redeem("db_query", { write: true, sql: "DELETE", app: "web" }, confirmation), { bound: { approval: "x" } });
  assert.deepEqual(confirmations.redeem("db_query", { app: "web", sql: "DELETE", write: true }, confirmation), { refused: "unknown" });
});

test("a confirmation expires after five minutes", () => {
  let now = 1_000_000;
  const confirmations = new Confirmations(() => now);
  const issued = confirmations.issue("redeploy", { app: "web" });
  assert.equal(issued.expiresAt, new Date(now + CONFIRMATION_TTL).toISOString());
  now += CONFIRMATION_TTL - 1;
  const second = confirmations.issue("redeploy", { app: "web" });
  assert.deepEqual(confirmations.redeem("redeploy", { app: "web" }, second.confirmation), { bound: {} });
  now += 1;
  assert.deepEqual(confirmations.redeem("redeploy", { app: "web" }, issued.confirmation), { refused: "expired" });
});

test("a confirmation is refused without it, for another tool or other arguments, forged or unknown", () => {
  const confirmations = new Confirmations();
  assert.deepEqual(confirmations.redeem("redeploy", { app: "web" }, undefined), { refused: "missing" });
  const one = confirmations.issue("redeploy", { app: "web" }).confirmation;
  assert.deepEqual(confirmations.redeem("db_delete", { app: "web" }, one), { refused: "mismatch" });
  const two = confirmations.issue("redeploy", { app: "web" }).confirmation;
  assert.deepEqual(confirmations.redeem("redeploy", { app: "other" }, two), { refused: "mismatch" });
  const three = confirmations.issue("redeploy", { app: "web" }).confirmation;
  const [nonce, mac] = three.split(".");
  assert.deepEqual(confirmations.redeem("redeploy", { app: "web" }, `${nonce}.${mac!.slice(0, -2)}AA`), { refused: "mismatch" });
  assert.deepEqual(confirmations.redeem("redeploy", { app: "web" }, `${nonce}.${mac}.x`), { refused: "unknown" });
  // Another process's key never matches.
  const elsewhere = new Confirmations().issue("redeploy", { app: "web" }).confirmation;
  assert.deepEqual(confirmations.redeem("redeploy", { app: "web" }, elsewhere), { refused: "unknown" });
});

test("no more than 64 confirmations are kept: the oldest goes first", () => {
  const confirmations = new Confirmations();
  const first = confirmations.issue("redeploy", { app: "a0" }).confirmation;
  for (let i = 1; i <= 64; i++) confirmations.issue("redeploy", { app: `a${i}` });
  assert.deepEqual(confirmations.redeem("redeploy", { app: "a0" }, first), { refused: "unknown" });
});

test("canonical JSON sorts every object's keys and nothing else", () => {
  assert.equal(canonical({ b: [2, { d: 1, c: null }], a: "x" }), '{"a":"x","b":[2,{"c":null,"d":1}]}');
});
