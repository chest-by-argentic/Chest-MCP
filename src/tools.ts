// The tools an assistant calls, each a route or a few routes of the API of
// the agents (/api/v1). A tool answers in one call: a read at once, a write
// sent once and never again. What a token may do is decided by the Chest,
// not here: read-only tokens by default, and the decisions it leaves to a
// human (approval_required) come back as such.
import { ChestError, type Chest } from "./chest.js";
import { ArgumentError, data, done, failure, invalid, type Outcome } from "./results.js";
import { check, type ObjectSchema, type Schema } from "./schema.js";
import { clean, DATA_BUDGET, untrusted } from "./untrusted.js";

/** What a call works with: the Chest and its cancellation. */
export type Context = {
  readonly chest: Chest;
  readonly signal: AbortSignal;
};

/** The hints of a tool (ToolAnnotations): what it does to the Chest. */
type Annotations = {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint: false;
};

/** A tool as tools/list shows it. */
export type Definition = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ObjectSchema & { readonly properties: Readonly<Record<string, Schema>> };
  readonly annotations: Annotations;
};

type Args = Record<string, unknown>;

type Tool = Definition & { readonly run: (args: Args, context: Context) => Promise<Outcome> };

// Arguments shared by several tools.
const app: Schema = { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$", description: "The name of a tool of the Chest, as list_tools gives it." };
const schemaName: Schema = { type: "string", minLength: 1, maxLength: 63, description: "The schema of the table (public, most often), as db_overview gives it." };
const tableName: Schema = { type: "string", minLength: 1, maxLength: 63, description: "The name of the table, as db_overview gives it." };
const repository: Schema = { type: "string", pattern: "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$", description: "A GitHub repository, owner/name." };
const branch: Schema = { type: "string", pattern: "^[A-Za-z0-9._/-]{1,200}$", description: "A branch of the repository." };
const toolName: Schema = { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$", description: "The name of a tool of the catalogue, as catalogue_list gives it." };
const as: Schema = { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$", description: "The name to install the tool under, when not its own." };
const key: Schema = { type: "array", maxItems: 32, items: { type: "string", maxLength: 8192 }, description: "The primary key of the row, as db_rows gives it (row.key)." };
const version: Schema = { type: "string", pattern: "^[0-9]{1,10}$", description: "The version of the row read, as db_rows gives it (row.version): a row changed since is refused." };
const values: Schema = { type: "object", description: "The values by column: a string (the text form of the value), null, or another JSON value." };
const fileName: Schema = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$",
  description: "The full name of a file of the tool, as files_list gives it.",
};
const folder: Schema = { type: "string", pattern: "^([A-Za-z0-9][A-Za-z0-9._-]{0,99}/){1,7}$", description: "A folder of the tool's files: a prefix ending in '/', as files_list gives it." };
/** An object of arguments, exactly these. */
function input(properties: Record<string, Schema>, required: string[] = []): Definition["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false };
}

/** A tool that only reads. */
function reader(name: string, title: string, description: string, schema: Definition["inputSchema"], run: Tool["run"]): Tool {
  return { name, title, description, inputSchema: schema, annotations: { title, readOnlyHint: true, openWorldHint: false }, run };
}

/** A tool that writes: sent once, never again, even when its outcome is uncertain. */
function writer(name: string, title: string, description: string, schema: Definition["inputSchema"], hints: { readonly destructive: boolean; readonly idempotent?: boolean }, run: Tool["run"]): Tool {
  return {
    name,
    title,
    description,
    inputSchema: schema,
    annotations: { title, readOnlyHint: false, destructiveHint: hints.destructive, idempotentHint: hints.idempotent ?? false, openWorldHint: false },
    run,
  };
}

/** A segment of a path, from an argument checked by its pattern. */
function segment(value: unknown): string {
  return encodeURIComponent(value as string);
}

async function get(context: Context, path: string): Promise<unknown> {
  return (await context.chest.send({ method: "GET", path, write: false, signal: context.signal })).body;
}

async function post(context: Context, path: string, body: unknown, write: boolean): Promise<unknown> {
  return (await context.chest.send({ method: "POST", path, body, write, signal: context.signal })).body;
}

/** An answer of the Chest that is not the shape its route gives. */
function unexpected(): ChestError {
  return new ChestError("invalid_answer", "The Chest answered in a shape it never gives", { uncertain: false });
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unexpected();
  return value as Record<string, unknown>;
}

function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw unexpected();
  return value.map(object);
}

/** A text given by the model, as the server's words show it: cleaned and bounded. */
function quoted(value: unknown, max = 2000): string {
  const text = clean(typeof value === "string" ? value : JSON.stringify(value));
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** The table of the console an argument names. */
function table(args: Args): { schema: unknown; name: unknown } {
  return { schema: args["schema"], name: args["table"] };
}

/** The entry of the catalogue a tool is, as the Chest discovered it. */
async function catalogueEntry(context: Context, name: unknown): Promise<Record<string, unknown>> {
  const catalogue = object(await get(context, "/catalogue"));
  const entry = objects(catalogue["tools"]).find(tool => tool["name"] === name);
  if (!entry) throw new ChestError("not_found", "This tool is not in the catalogue of this Chest", { uncertain: false });
  return entry;
}

/** The manifest at the head of a branch, read by the Chest; nothing built. */
async function manifest(context: Context, args: Args) {
  const read = await post(context, "/github/read", { repository: args["repository"], branch: args["branch"] }, false);
  return untrusted(`github:${args["repository"]}@${args["branch"]}`, read);
}

/** A listing of a tool's files, its shape checked: {usage, folders, files, total}. */
async function listing(context: Context, app: unknown, query: URLSearchParams): Promise<Record<string, unknown>> {
  const page = object(await get(context, `/tools/${segment(app)}/files${query.size ? "?" + query.toString() : ""}`));
  object(page["usage"]);
  objects(page["files"]);
  objects(page["folders"]);
  if (typeof page["total"] !== "number" || !Number.isInteger(page["total"]) || page["total"] < 0) throw unexpected();
  return page;
}

/** A whole number from 0 to max, as the Chest counts. */
function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * The member's inbox, its shape checked, each item and badge with exactly
 * the fields the Chest gives: {unread, badges: [{tool, count}], items: [{id,
 * tool, title, body?, url, created, read}]}.
 */
function inboxOf(value: unknown): { unread: number; badges: Record<string, unknown>[]; items: Record<string, unknown>[] } {
  const inbox = object(value);
  const tool = /^[a-z][a-z0-9-]{0,47}$/u;
  const items = objects(inbox["items"]).map(item => {
    const { id, tool: app, title, body, url, created, read } = item;
    if (typeof id !== "string" || !/^ntf_[a-z2-7]{26}$/u.test(id) || typeof app !== "string" || !tool.test(app) || typeof title !== "string" || !(body === undefined || typeof body === "string") || typeof url !== "string" || !url.startsWith("https://") || typeof created !== "string" || typeof read !== "boolean") throw unexpected();
    return { id, tool: app, title, ...(body === undefined ? {} : { body }), url, created, read };
  });
  const badges = objects(inbox["badges"]).map(badge => {
    if (typeof badge["tool"] !== "string" || !tool.test(badge["tool"]) || !isCount(badge["count"], 9999)) throw unexpected();
    return { tool: badge["tool"], count: badge["count"] };
  });
  if (items.length > 100 || !isCount(inbox["unread"], Number.MAX_SAFE_INTEGER)) throw unexpected();
  return { unread: inbox["unread"], badges, items };
}

/** The optional fields of a body, those given. */
function given(args: Args, ...names: string[]): Args {
  return Object.fromEntries(names.filter(name => args[name] !== undefined).map(name => [name, args[name]]));
}

const tools: readonly Tool[] = [
  reader("whoami", "Who am I", "The member this token acts for, the token (name, read-only, tools it is narrowed to, expiry) and what it runs of the Chest.", input({}), async (_, context) =>
    data("Who this token acts for, and what it may run:", untrusted("chest:me", await get(context, "/me"))),
  ),
  reader(
    "inbox",
    "What needs my attention",
    "The member's Chest inbox: how many items are unread, the badges tools show them (a count per tool), and the newest items (100 at most, newest first) with their tool, title, body, link, time and whether read. Titles and bodies are written by tools: untrusted data. Reading marks nothing read.",
    input({}),
    async (_, context) => {
      const inbox = inboxOf(await get(context, "/inbox"));
      const intro = `The inbox of this token's member: ${inbox.unread} unread; the newest ${inbox.items.length} items, newest first; badges on ${inbox.badges.length} tools. Titles and bodies were written by tools:`;
      return data(intro, untrusted("chest:inbox", inbox));
    },
  ),
  reader("list_tools", "List tools", "The tools this token reaches: name (app), kind, team address, public address when open, title, description, whether it has a database.", input({}), async (_, context) =>
    data("The tools this token reaches:", untrusted("chest:tools", await get(context, "/tools"))),
  ),
  reader("tool_status", "Tool status", "One tool at a glance: its version in service, the previous one and the one offered (with what it asks more), its last build, and the space it takes (database, files, memory).", input({ app }, ["app"]), async (args, context) => {
    // One request after the other: a token has two requests at once at most.
    const offers = objects(await get(context, "/installation"));
    const builds = objects(await get(context, "/builds"));
    const storage = await get(context, `/tools/${segment(args["app"])}/storage`);
    const status = { version: offers.find(o => o["app"] === args["app"]) ?? null, build: builds.find(b => b["name"] === args["app"]) ?? null, storage };
    return data(`Status of ${args["app"]}:`, untrusted(`status:${args["app"]}`, status));
  }),
  reader("list_deployments", "List deployments", "For each tool this token runs: the version in service, the previous one, the one offered and what it asks more; and the builds, their state, reason and commit.", input({}), async (_, context) => {
    const versions = await get(context, "/installation");
    const builds = await get(context, "/builds");
    return data("Versions and builds of the tools this token runs:", untrusted("chest:deployments", { versions, builds }));
  }),
  reader("build_log", "Build log", "The output of the last build of a tool (podman and npm), its end when it is long: untrusted text.", input({ name: { ...app, description: "The name of the tool whose build to read." } }, ["name"]), async (args, context) => {
    const log = await get(context, `/builds/${segment(args["name"])}/log`);
    if (typeof log !== "string") throw unexpected();
    // A build fails at its end: that is what is kept of a long one.
    const tail = log.length > DATA_BUDGET ? log.slice(-DATA_BUDGET) : log;
    return data(`Output of the build of ${args["name"]}${tail !== log ? ", its last part" : ""}:`, untrusted(`build:${args["name"]}`, tail, tail !== log));
  }),
  writer(
    "redeploy",
    "Redeploy",
    "Starts a tool again with its variables as they are now: the new instance takes the traffic once it answers (up to about two minutes); one that does not leaves the instance in service as it was.",
    input({ app }, ["app"]),
    { destructive: false, idempotent: true },
    async (args, context) => {
      await post(context, `/tools/${segment(args["app"])}/redeploy`, {}, true);
      return done(`${args["app"]} was started again and its new instance answers.`);
    },
  ),
  reader(
    "schedules",
    "Schedules",
    "What a tool runs by itself: each schedule (its name, its cron line read on the Chest's clock, its zone, when it runs next, whether a run is under way) and its last runs, newest first — when, how each was started (time, missed, manual), its attempt, its status (waiting, running, ok, failed, skipped), how long it took and why it failed. Never what the tool did.",
    input({ app }, ["app"]),
    async (args, context) => data(`Schedules of ${args["app"]}:`, untrusted(`schedules:${args["app"]}`, await get(context, `/tools/${segment(args["app"])}/schedules`))),
  ),
  writer(
    "run_schedule",
    "Run a schedule now",
    "Asks a run of a tool's schedule now, as its time would: the tool is woken if it sleeps. The run is waiting when this returns; read schedules to follow it. A schedule the version in service does not declare is not_found; a run of it under way is refused (conflict).",
    input({ app, name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$", description: "The name of the schedule, as schedules gives it." } }, ["app", "name"]),
    { destructive: false },
    async (args, context) => {
      const run = await post(context, `/tools/${segment(args["app"])}/schedules/run`, { name: args["name"] }, true);
      return done(`a run of ${args["name"]} of ${args["app"]} was asked; it starts in a moment.`, untrusted(`schedules:${args["app"]}`, run));
    },
  ),
  reader(
    "read_logs",
    "Read logs",
    "The runtime log of a tool — what its instances print and the Chest's lines on them —, oldest first, after a cursor: untrusted text. Give the cursor it returns as after to read what follows.",
    input(
      {
        app,
        after: { type: "string", pattern: "^[0-9]{1,18}$", description: "The cursor a previous read returned; without it, the last lines." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "How many lines at most (100 by default)." },
      },
      ["app"],
    ),
    async (args, context) => {
      const query = new URLSearchParams({ limit: String(args["limit"] ?? 100), ...given(args, "after") } as Record<string, string>);
      const page = object(await get(context, `/tools/${segment(args["app"])}/logs?${query}`));
      if (!Array.isArray(page["lines"])) throw unexpected();
      const lines = untrusted(`logs:${args["app"]}`, page["lines"]);
      const cursor = typeof page["cursor"] === "string" && /^[0-9]{1,18}$/u.test(page["cursor"]) && !lines.truncated ? page["cursor"] : undefined;
      const intro = [
        `Runtime log of ${args["app"]}, oldest first: ${page["lines"].length} lines.`,
        ...(page["reset"] === true ? ["The cursor given was not of this log (the tool was removed and installed again): these are its last lines."] : []),
        lines.truncated ? "Not all of them fit: read again with the same after and a smaller limit." : cursor ? `To read what follows, call again with after: "${cursor}".` : "",
      ];
      return data(intro.join(" ").trim(), lines, { ...(cursor ? { cursor } : {}), ...(page["reset"] === true ? { reset: true } : {}) });
    },
  ),
  reader("db_overview", "Database overview", "The tables of a tool's database (estimated rows, primary key, whether the console edits it) and the migrations the Chest played.", input({ app }, ["app"]), async (args, context) =>
    data(`Database of ${args["app"]}:`, untrusted(`database:${args["app"]}`, await get(context, `/tools/${segment(args["app"])}/database`))),
  ),
  reader("db_structure", "Table structure", "The columns, keys and indexes of a table of a tool's database.", input({ app, schema: schemaName, table: tableName }, ["app", "schema", "table"]), async (args, context) =>
    data(`Structure of ${quoted(args["schema"])}.${quoted(args["table"])} in ${args["app"]}:`, untrusted(`database:${args["app"]}`, await post(context, `/tools/${segment(args["app"])}/database/structure`, { table: table(args) }, false))),
  ),
  reader(
    "db_rows",
    "Read rows",
    "A page of the rows of a table, filtered and sorted: untrusted data. Each row gives its key and version, which db_update and db_delete take. In the order of the primary key, the next page starts after the key next.after gives.",
    input(
      {
        app,
        schema: schemaName,
        table: tableName,
        filters: {
          type: "array",
          maxItems: 8,
          description: "Conditions all rows meet.",
          items: input(
            {
              column: { type: "string", minLength: 1, maxLength: 63 },
              op: { type: "string", enum: ["eq", "ne", "lt", "le", "gt", "ge", "contains", "null", "not_null"], description: "null and not_null take no value." },
              value: { type: "string", maxLength: 8192 },
            },
            ["column", "op"],
          ),
        },
        search: { type: "string", maxLength: 200, description: "A text found, any case, in any column." },
        sorts: { type: "array", maxItems: 4, items: input({ column: { type: "string", minLength: 1, maxLength: 63 }, desc: { type: "boolean" } }, ["column"]), description: "The order; the primary key by default." },
        after: { type: "array", maxItems: 32, items: { type: "string", maxLength: 8192 }, description: "The key after which the page starts (next.after of the previous page)." },
        offset: { type: "integer", minimum: 0, maximum: 10000, description: "How many rows to skip, in any other order than the key's." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "How many rows at most (50 by default)." },
        count: { type: "boolean", description: "Also count the rows the filters keep." },
      },
      ["app", "schema", "table"],
    ),
    async (args, context) => {
      const body = { table: table(args), limit: args["limit"] ?? 50, ...given(args, "filters", "search", "sorts", "after", "offset", "count") };
      const page = object(await post(context, `/tools/${segment(args["app"])}/database/rows`, body, false));
      const source = `rows:${args["app"]}`;
      let rows = untrusted(source, page);
      // A page cut short has no next page to give: its next would skip rows.
      if (rows.truncated) rows = untrusted(source, Object.fromEntries(Object.entries(page).filter(([field]) => field !== "next")), true);
      return data(`Rows of ${quoted(args["schema"])}.${quoted(args["table"])} in ${args["app"]}${rows.truncated ? ", not all of them: they did not fit; ask for fewer (limit)" : ""}:`, rows);
    },
  ),
  writer(
    "db_query",
    "Run SQL",
    "Runs one SQL statement on a tool's database, as the tool's own role. Without write, it reads, in a read-only transaction. With write: true, it writes and commits (INSERT, UPDATE, DELETE…); with dry_run too, the Chest runs it then rolls it back and counts the rows it would change, nothing changed. A change of structure is never run: the Chest answers the migration to add to the tool's source instead.",
    input(
      {
        app,
        sql: { type: "string", minLength: 1, maxLength: 65536, description: "One statement." },
        write: { type: "boolean", description: "The statement writes (INSERT, UPDATE, DELETE…): it is committed." },
        dry_run: { type: "boolean", description: "With write: true, run the statement then roll it back, and count the rows it would change: nothing is changed." },
      },
      ["app", "sql"],
    ),
    { destructive: true },
    async (args, context) => {
      const path = `/tools/${segment(args["app"])}/database/query`;
      if (args["write"] !== true) {
        if (args["dry_run"] !== undefined) throw new ArgumentError("dry_run is only for a statement run with write: true");
        return data(`Result of the statement on ${args["app"]} (read only):`, untrusted(`rows:${args["app"]}`, await post(context, path, { sql: args["sql"] }, false)));
      }
      if (args["dry_run"] === true) {
        // The Chest's own dry run: run, counted, rolled back — nothing to be uncertain of.
        const result = object(await post(context, path, { sql: args["sql"], write: true }, false));
        const affected = typeof result["affected"] === "number" ? `; it would change ${result["affected"]} rows` : "";
        return data(`Dry run of the statement on ${args["app"]}: run then rolled back, nothing was changed${affected}:`, untrusted(`rows:${args["app"]}`, result));
      }
      const result = await post(context, path, { sql: args["sql"], write: true, commit: true }, true);
      const affected = (result as Record<string, unknown> | null)?.["affected"];
      return done(`the statement was committed on ${args["app"]}${typeof affected === "number" ? `, ${affected} rows changed` : ""}.`, untrusted(`rows:${args["app"]}`, result));
    },
  ),
  writer(
    "db_insert",
    "Add a row",
    "Adds a row to a table of a tool's database; the columns not named take their default. A view, a table without a primary key or chest_migrations is never edited.",
    input({ app, schema: schemaName, table: tableName, values }, ["app", "schema", "table", "values"]),
    { destructive: false },
    async (args, context) => {
      const row = await post(context, `/tools/${segment(args["app"])}/database/rows/insert`, { table: table(args), values: args["values"] }, true);
      return done(`a row was added to ${quoted(args["schema"])}.${quoted(args["table"])} of ${args["app"]}.`, untrusted(`rows:${args["app"]}`, row));
    },
  ),
  writer(
    "db_update",
    "Change a row",
    "Changes the values of a row, found by its key, as long as it is still the version read: a row changed since is refused (row_changed), nothing written.",
    input({ app, schema: schemaName, table: tableName, key, version, values }, ["app", "schema", "table", "key", "version", "values"]),
    { destructive: true },
    async (args, context) => {
      const row = await post(context, `/tools/${segment(args["app"])}/database/rows/update`, { table: table(args), key: args["key"], version: args["version"], values: args["values"] }, true);
      return done(`the row of key ${quoted(args["key"])} was changed in ${quoted(args["schema"])}.${quoted(args["table"])} of ${args["app"]}.`, untrusted(`rows:${args["app"]}`, row));
    },
  ),
  writer(
    "db_delete",
    "Delete a row",
    "Deletes a row, found by its key, as long as it is still the version read: a row changed since is refused (row_changed), nothing deleted.",
    input({ app, schema: schemaName, table: tableName, key, version }, ["app", "schema", "table", "key", "version"]),
    { destructive: true },
    async (args, context) => {
      await post(context, `/tools/${segment(args["app"])}/database/rows/delete`, { table: table(args), key: args["key"], version: args["version"] }, true);
      return done(`the row of key ${quoted(args["key"])} was deleted from ${quoted(args["schema"])}.${quoted(args["table"])} of ${args["app"]}.`);
    },
  ),
  reader(
    "files_list",
    "List files",
    "The private files of a tool, like its Storage view: a folder (its folders first, with their count and size, then its files), or a search on names across the tool (q), sorted and paged by 200; with name, one file (type, size, updated, width and height of an image). With the tool's usage (bytes, objects, quota). Names are untrusted data.",
    input(
      {
        app,
        name: fileName,
        folder: { ...folder, description: "The folder to read, a prefix ending in '/'; the top without it." },
        q: { type: "string", minLength: 1, maxLength: 100, description: "A text found, any case, anywhere in the names of the whole tool (not with folder)." },
        sort: { type: "string", enum: ["name", "size", "updated"], description: "The order of the files (name by default)." },
        desc: { type: "boolean", description: "The reverse order." },
        offset: { type: "integer", minimum: 0, maximum: 9999999, description: "How many rows to skip: the next page starts at the offset the previous one gives." },
      },
      ["app"],
    ),
    async (args, context) => {
      if (args["name"] !== undefined) {
        if (Object.keys(args).length !== 2) throw new ArgumentError("name reads one file and takes no other argument than app");
        const found = object(await get(context, `/tools/${segment(args["app"])}/files?${new URLSearchParams({ name: args["name"] as string })}`));
        object(found["file"]);
        return data(`The file ${quoted(args["name"])} of ${args["app"]}:`, untrusted(`files:${args["app"]}`, found["file"]));
      }
      if (args["folder"] !== undefined && args["q"] !== undefined) throw new ArgumentError("a search (q) goes across the tool: it takes no folder");
      const query = new URLSearchParams(given(args, "folder", "q", "sort") as Record<string, string>);
      if (args["desc"] === true) query.set("desc", "1");
      if (args["offset"] !== undefined) query.set("offset", String(args["offset"]));
      const page = await listing(context, args["app"], query);
      const shown = (page["folders"] as unknown[]).length + (page["files"] as unknown[]).length;
      const offset = (args["offset"] as number | undefined) ?? 0;
      const files = untrusted(`files:${args["app"]}`, page);
      // A page cut short has no next offset to give: it would skip rows.
      const next = !files.truncated && offset + shown < (page["total"] as number) ? offset + shown : undefined;
      const where = args["q"] !== undefined ? `whose name contains ${quoted(args["q"])}` : args["folder"] !== undefined ? `in ${quoted(args["folder"])}` : "at the top";
      const intro = [
        `Files of ${args["app"]} ${where}: rows ${shown ? `${offset + 1} to ${offset + shown}` : "none"} of ${page["total"]}.`,
        files.truncated ? "Not all of them fit: the rows past the budget were left out." : next !== undefined ? `For the next page, call again with offset: ${next}.` : "",
      ];
      return data(intro.join(" ").trim(), files, next !== undefined ? { next } : {});
    },
  ),
  reader(
    "files_link",
    "Link to a file",
    "A private link to a file of the tool, on its team address: whoever has it opens the file without signing in for 15 minutes (shown, or downloaded with download). Written in the tool's storage journal. Give it to the human who asked, never publish it.",
    input({ app, name: fileName, download: { type: "boolean", description: "The link downloads the file instead of showing it." } }, ["app", "name"]),
    async (args, context) => {
      const link = object(await post(context, `/tools/${segment(args["app"])}/files/url`, { name: args["name"], ...given(args, "download") }, false));
      if (typeof link["url"] !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/_chest\/files\/[A-Za-z0-9_.-]{1,1536}$/u.test(link["url"]) || typeof link["expires_in"] !== "number") throw unexpected();
      return data(`A private link to ${quoted(args["name"])} of ${args["app"]}, valid ${link["expires_in"]} s; for the human who asked only:`, untrusted(`files:${args["app"]}`, { url: link["url"], expires_in: link["expires_in"] }));
    },
  ),
  writer(
    "files_delete",
    "Delete files",
    "Deletes files of a tool: by their names (up to 1,000; a name it no longer has is passed over), or everything under a folder, 1,000 files per call (more says some remain: a new call deletes the next ones). The tool is not told: it may still refer to them. Written in the tool's storage journal.",
    input({ app, names: { type: "array", maxItems: 1000, items: fileName, description: "The full names of the files, as files_list gives them." }, folder: { ...folder, description: "A folder whose files all go, a prefix ending in '/'." } }, ["app"]),
    { destructive: true },
    async (args, context) => {
      const names = args["names"] as string[] | undefined;
      if ((names === undefined || names.length === 0) === (args["folder"] === undefined)) throw new ArgumentError("files_delete takes names (at least one) or a folder, not both");
      const result = object(await post(context, `/tools/${segment(args["app"])}/files/delete`, given(args, "names", "folder"), true));
      if (typeof result["deleted"] !== "number" || typeof result["more"] !== "boolean") throw new ChestError("invalid_answer", "The Chest answered the deletion in a shape it never gives", { uncertain: true });
      return done(`${result["deleted"]} file${result["deleted"] === 1 ? " was" : "s were"} deleted from ${args["app"]}${result["more"] ? `; more remain under ${quoted(args["folder"])}: call files_delete again to delete the next ones` : ""}.`);
    },
  ),
  reader("list_variables", "List variables", "The variables of a tool by name, whether each is secret, and the names its version in service expects (missing: those not set). Never a value.", input({ app }, ["app"]), async (args, context) => {
    const listed = object(await get(context, `/tools/${segment(args["app"])}/variables`));
    const variables = objects(listed["variables"]).map(variable => ({ name: variable["name"], secret: variable["secret"] === true }));
    const expected = Array.isArray(listed["expected"]) ? listed["expected"] : [];
    const missing = expected.filter(name => !variables.some(variable => variable.name === name));
    return data(`Variables of ${args["app"]}, by name (values are never given):`, untrusted(`variables:${args["app"]}`, { variables, expected, missing }));
  }),
  writer(
    "set_variable",
    "Set a variable",
    "Sets (operation set, with value and secret) or removes (operation remove) a variable of a tool; it applies at the next start (redeploy). A secret value is never shown again, not even to this server: a human had better set it in the Chest.",
    input(
      {
        app,
        name: { type: "string", pattern: "^[A-Z_][A-Z0-9_]{0,63}$", description: "The name of the variable." },
        operation: { type: "string", enum: ["set", "remove"] },
        value: { type: "string", maxLength: 8192, description: "The value, for set." },
        secret: { type: "boolean", description: "For set: the value is a secret, never shown again." },
      },
      ["app", "name", "operation"],
    ),
    { destructive: true, idempotent: true },
    async (args, context) => {
      const set = args["operation"] === "set";
      const withValue = args["value"] !== undefined;
      const withSecret = args["secret"] !== undefined;
      if (set ? !(withValue && withSecret) : withValue || withSecret) throw new ArgumentError("set takes a value and secret; remove takes neither");
      await post(context, `/tools/${segment(args["app"])}/variables`, { operation: args["operation"], name: args["name"], ...given(args, "value", "secret") }, true);
      return done(`the variable ${args["name"]} of ${args["app"]} was ${args["operation"] === "set" ? "set" : "removed"}; it applies at the next start (redeploy).`);
    },
  ),
  reader("catalogue_list", "List the catalogue", "The tools of the store the Chest offers, their state in this Chest, what each asks (permissions, roles) and its repository and commit. Not for a token narrowed to tools.", input({}), async (_, context) =>
    data("The catalogue of this Chest:", untrusted("catalogue", await get(context, "/catalogue"))),
  ),
  writer(
    "install_from_catalogue",
    "Install from the catalogue",
    "Asks to install a tool of the catalogue, exactly as its entry says (repository, commit, permissions, roles). The Chest never installs it for a token: it records a request the owner or an admin approves in the Chest, and answers approval_required with the page where they decide. A member proposes a tool with propose_tool. Replacing a running tool is not for agents.",
    input({ name: toolName, as, open_public: { type: "boolean", description: "Open its public part once installed, for a tool that declares one." } }, ["name"]),
    { destructive: false },
    async (args, context) => {
      // The digest of the entry read: the Chest refuses it if the entry changed since, so what a human approves is this entry.
      const entry = await catalogueEntry(context, args["name"]);
      if (typeof entry["approval"] !== "string" || !/^[a-f0-9]{64}$/u.test(entry["approval"])) throw unexpected();
      const started = await post(context, "/catalogue/install", { name: args["name"], approval: entry["approval"], ...given(args, "as", "open_public") }, true);
      return done(`the installation of ${args["name"]} started; follow it with tool_status.`, untrusted(`catalogue:${args["name"]}`, started));
    },
  ),
  reader(
    "github_preview",
    "Preview a GitHub branch",
    "The manifest at the head of a branch of a repository the member's GitHub installation reaches (name, presentation, permissions, roles, commit), read by the Chest; nothing is built nor kept. The Chest counts it among the writes: a read-only token cannot.",
    input({ repository, branch }, ["repository", "branch"]),
    async (args, context) => data(`The manifest at the head of ${args["branch"]} of ${args["repository"]}:`, await manifest(context, args)),
  ),
  writer(
    "link_github",
    "Link a GitHub repository",
    "Asks to link a branch of a repository to the tool its manifest names (or as), to build and install its head and, with auto, its pushes. The Chest never links for a token: for a new tool it records a request the owner or an admin approves; a tool already in service is linked by its owner from the tool's settings page. It answers approval_required with the page where they decide.",
    input({ repository, branch, as, auto: { type: "boolean", description: "Build and install each new push of the branch." } }, ["repository", "branch"]),
    { destructive: false },
    async (args, context) => {
      const linked = await post(context, "/github/links", { repository: args["repository"], branch: args["branch"], ...given(args, "as", "auto") }, true);
      return done(`${args["repository"]} is linked; its head is being built. Follow it with tool_status.`, untrusted(`github:${args["repository"]}@${args["branch"]}`, linked));
    },
  ),
  writer(
    "propose_tool",
    "Propose a tool",
    "Proposes a tool — of the catalogue (name), or of a GitHub repository (repository, branch) — to whoever runs the Chest, who decides in the Chest. Show the human what is proposed first: catalogue_list or github_preview.",
    input({ source: { type: "string", enum: ["catalogue", "github"] }, name: toolName, repository, branch, as }, ["source"]),
    { destructive: false },
    async (args, context) => {
      const catalogue = args["source"] === "catalogue";
      const named = args["name"] !== undefined;
      const repositoryGiven = args["repository"] !== undefined;
      const branchGiven = args["branch"] !== undefined;
      if (catalogue ? !named || repositoryGiven || branchGiven : named || !repositoryGiven || !branchGiven) {
        throw new ArgumentError("a proposal from the catalogue takes a name; one from GitHub takes a repository and a branch");
      }
      const proposed = await post(context, "/proposals", given(args, "source", "name", "repository", "branch", "as"), true);
      return done("the proposal was sent to whoever runs the Chest.", untrusted("proposal", proposed));
    },
  ),
];

/** The tools, as tools/list shows them, in a fixed order. */
export const definitions: readonly Definition[] = tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));

/**
 * Calls a tool: its arguments checked against its schema before anything
 * is sent, its failures given as results. Undefined for a tool unknown.
 */
export async function call(name: string, args: Args, context: Context): Promise<Outcome | undefined> {
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) return undefined;
  const refused = check(tool.inputSchema, args);
  if (refused) return invalid(refused);
  try {
    return await tool.run(args, context);
  } catch (error) {
    return failure(error);
  }
}
