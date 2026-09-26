// What the server is given, from its environment: the Chest it talks to and
// the token it acts with. Nothing else is read; nothing is written.
import { isIP } from "node:net";

/** The Chest and the token: CHEST_URL, CHEST_TOKEN (and CHEST_MCP_LAB). */
export type Config = {
  /** The origin of the Chest, `https://<host>[:<port>]`, without a path. */
  readonly origin: string;
  /** The personal access token, `chest_pat_<id>_<secret>`: never shown. */
  readonly token: string;
};

/**
 * A configuration refused. Its message names the variable and why, never
 * the value of CHEST_TOKEN.
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** The shape of a personal access token of a Chest: 12 hex digits, 32 bytes. */
const tokenPattern = /^chest_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/u;

/**
 * Reads the configuration from an environment. CHEST_URL must be an HTTPS
 * origin — no credentials, path, query or fragment —; a loopback host
 * (localhost, 127.0.0.0/8, ::1) is refused unless CHEST_MCP_LAB is "1", the
 * lab's own switch. CHEST_TOKEN must be a token of a Chest.
 */
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const raw = env["CHEST_URL"];
  if (!raw) throw new ConfigError("CHEST_URL is not set: give the address of your Chest, https://<chest>.argentic.app");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("CHEST_URL is not a URL");
  }
  if (url.protocol !== "https:") throw new ConfigError("CHEST_URL must use https://");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ConfigError("CHEST_URL must be the address of the Chest alone, without credentials, path, query or fragment");
  }
  if (loopback(url.hostname) && env["CHEST_MCP_LAB"] !== "1") {
    throw new ConfigError("CHEST_URL names this machine: only a lab does that (CHEST_MCP_LAB=1)");
  }
  const token = env["CHEST_TOKEN"];
  if (!token) throw new ConfigError("CHEST_TOKEN is not set: create a token in your Chest, Profile, « Jetons d'accès »");
  if (!tokenPattern.test(token)) throw new ConfigError("CHEST_TOKEN is not a token of a Chest (chest_pat_…)");
  return { origin: url.origin, token };
}

/** Whether a host of a URL is this machine. */
function loopback(hostname: string): boolean {
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  if (isIP(host) === 6) return host === "::1" || /^::ffff:(127\.|7f)/u.test(host);
  return false;
}
