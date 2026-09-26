// Check the package as a client receives it: npm pack, install the tarball
// into a throwaway project, then run its bin as `npx -y @argentic/chest-mcp`
// would — refused without configuration, and answering server/discover
// over stdio with one.
//
//   npm run check:package        (node scripts/check-package.mjs)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const modules = readdirSync(join(root, "src")).filter(name => name.endsWith(".ts")).map(name => `dist/${name.replace(/\.ts$/u, ".js")}`);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Run from prepublishOnly, npm passes its own flags down: a dry run would
// keep npm pack from writing the tarball this check installs.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_dry_run"));
function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
function step(title) {
  console.log(`\n== ${title}`);
}

const work = mkdtempSync(join(tmpdir(), "chest-mcp-check-"));
try {
  step("npm pack");
  const [packed] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", work], root).replace(/^[^[]*/su, ""));
  const shipped = packed.files.map(file => file.path).sort();
  console.log(`${packed.filename}: ${shipped.length} files, ${packed.size} bytes`);
  for (const path of shipped) console.log("  " + path);
  assert.deepEqual(shipped, ["LICENSE", "README.md", ...modules, "package.json"].sort(), "the package ships the compiled modules, the README, the licence and nothing else");

  step("install the tarball into a throwaway project");
  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }) + "\n");
  run(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", join(work, packed.filename)], consumer);
  assert.deepEqual(readdirSync(join(consumer, "node_modules")).filter(name => !name.startsWith(".")), ["@argentic"], "no dependency comes with the package");
  const bin = join(consumer, "node_modules", ".bin", "chest-mcp");

  step("the bin refuses to start without configuration");
  const bare = spawnSync(bin, [], { env: { PATH: process.env.PATH }, input: "", encoding: "utf8" });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /^chest-mcp: CHEST_URL is not set/u);
  assert.equal(bare.stdout, "");

  step("the bin answers server/discover over stdio");
  const token = "chest_pat_0123456789ab_" + "A".repeat(43);
  const discover = { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } };
  const served = spawnSync(bin, [], { env: { PATH: process.env.PATH, CHEST_URL: "https://chest.example.test", CHEST_TOKEN: token }, input: JSON.stringify(discover) + "\n", encoding: "utf8" });
  assert.equal(served.status, 0, served.stderr);
  const answer = JSON.parse(served.stdout);
  assert.deepEqual(answer.result.supportedVersions, ["2026-07-28"]);
  assert.equal(answer.result._meta["io.modelcontextprotocol/serverInfo"].version, manifest.version);
  console.log(`${manifest.name}@${manifest.version}: bin runs, ${answer.result.supportedVersions.join(", ")}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
