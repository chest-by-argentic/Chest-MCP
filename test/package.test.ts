// What must agree between the package and its code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERSION } from "../src/version.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the version the server says is the version of the package", () => {
  assert.equal(VERSION, (JSON.parse(read("../../package.json")) as { version: string }).version);
});

test("the package has no runtime dependency", () => {
  const manifest = JSON.parse(read("../../package.json")) as Record<string, unknown>;
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"]) assert.equal(manifest[field], undefined, field);
});

test("the licence of the package is the repository's", () => {
  assert.equal(read("../../LICENSE"), read("../../../LICENSE"));
});
