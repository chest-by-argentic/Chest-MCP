// The tools an assistant calls, each a route or a few routes of the API of
// the agents (/api/v1). A tool that reads answers at once. A tool that
// writes is two calls: without a confirmation it is a dry run — the Chest's
// own when it has one (a statement), a read of what would be approved
// (a catalogue entry, a manifest), a description otherwise — which hands one
// out; with it, once a human approved, the write is sent, once.
import { ChestError, type Chest } from "./chest.js";
import type { Confirmations } from "./confirm.js";
import { ArgumentError, confirmationRefused, data, done, dryRun, failure, invalid, type Outcome, type Plan } from "./results.js";
import { check, type ObjectSchema, type Schema } from "./schema.js";
import { clean, DATA_BUDGET, untrusted } from "./untrusted.js";

/** What a call works with: the Chest, the confirmations, its cancellation. */
export type Context = {
  readonly chest: Chest;
  readonly confirmations: Confirmations;
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
const confirmation: Schema = {
  type: "string",
  maxLength: 200,
  description: "The confirmation the dry run gave. Leave it out for the dry run; give it only after a human approved what the dry run showed.",
};

/** An object of arguments, exactly these. */
function input(properties: Record<string, Schema>, required: string[] = []): Definition["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false };
}

/** A tool that only reads. */
function reader(name: string, title: string, description: string, schema: Definition["inputSchema"], run: Tool["run"]): Tool {
  return { name, title, description, inputSchema: schema, annotations: { title, readOnlyHint: true, openWorldHint: false }, run };
}

/** A plan of a write, and what the commit needs of what the dry run read. */
type Planned = Plan & { readonly bound?: Record<string, unknown> };

/**
 * A tool that writes, in two calls: `plan` makes the dry run, `commit` the
 * write, given what the plan bound. A confirmation is the only way from one
 * to the other; the commit is sent once and never again.
 */
function writer(
  name: string,
  title: string,
  description: string,
  schema: Definition["inputSchema"],
  hints: { readonly destructive: boolean; readonly idempotent?: boolean },
  plan: (args: Args, context: Context) => Promise<Planned>,
  commit: (args: Args, bound: Record<string, unknown>, context: Context) => Promise<Outcome>,
): Tool {
  return {
    name,
    title,
    description: description + " Two calls: a dry run without confirmation, then the commit with it, once a human approved.",
    inputSchema: { ...schema, properties: { ...schema.properties, confirmation } },
    annotations: { title, readOnlyHint: false, destructiveHint: hints.destructive, idempotentHint: hints.idempotent ?? false, openWorldHint: false },
    run: (args, context) => twoSteps(name, args, context, plan, commit),
  };
}

/** The dry run, or the commit of a request with its confirmation. */
async function twoSteps(name: string, args: Args, context: Context, plan: (args: Args, context: Context) => Promise<Planned>, commit: (args: Args, bound: Record<string, unknown>, context: Context) => Promise<Outcome>): Promise<Outcome> {
  const { confirmation: given, ...request } = args;
  if (given === undefined) {
    const planned = await plan(request, context);
    const issued = context.confirmations.issue(name, request, planned.bound);
    return dryRun(name, planned, issued.confirmation, issued.expiresAt);
  }
  const redeemed = context.confirmations.redeem(name, request, given as string);
  if ("refused" in redeemed) return confirmationRefused(name, redeemed.refused);
  return commit(request, redeemed.bound, context);
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

/** A text given by the model, as a summary shows it: cleaned and bounded. */
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

/** What an entry of the catalogue shows of what would be approved. */
function entryPreview(name: unknown, entry: Record<string, unknown>) {
  const shown = ["title", "description", "repository", "commit", "permissions", "roles", "state", "reason", "update", "more"];
  return untrusted(`catalogue:${name}`, Object.fromEntries(shown.filter(field => field in entry).map(field => [field, entry[field]])));
}

/** The manifest at the head of a branch, read by the Chest; nothing built. */
async function manifest(context: Context, args: Args) {
  const read = await post(context, "/github/read", { repository: args["repository"], branch: args["branch"] }, false);
  return untrusted(`github:${args["repository"]}@${args["branch"]}`, read);
}

/** The optional fields of a body, those given. */
function given(args: Args, ...names: string[]): Args {
  return Object.fromEntries(names.filter(name => args[name] !== undefined).map(name => [name, args[name]]));
}

/**
 * A statement that writes, in two calls: the Chest's dry run (run, counted,
 * rolled back), then its commit. db_query gives it the calls with write.
 */
const queryWrite = writer(
  "db_query",
  "Run SQL",
  "Runs one SQL statement on a tool's database, as the tool's own role. Without write, it reads, in a read-only transaction, in one call. With write: true, it writes: the first call is the Chest's dry run (run then rolled back, the rows it would change counted). A change of structure is never run: the Chest answers the migration to add to the tool's source instead.",
  input(
    {
      app,
      sql: { type: "string", minLength: 1, maxLength: 65536, description: "One statement." },
      write: { type: "boolean", description: "The statement writes (INSERT, UPDATE, DELETE…): a dry run first, then the commit with the confirmation." },
    },
    ["app", "sql"],
  ),
  { destructive: true },
  async (args, context) => {
    const result = object(await post(context, `/tools/${segment(args["app"])}/database/query`, { sql: args["sql"], write: true }, true));
    return {
      summary: `Would commit on the database of ${args["app"]} the statement:\n${quoted(args["sql"])}`,
      ...(typeof result["affected"] === "number" ? { affected: result["affected"] } : {}),
      preview: untrusted(`rows:${args["app"]}`, result),
    };
  },
  async (args, _, context) => {
    const result = await post(context, `/tools/${segment(args["app"])}/database/query`, { sql: args["sql"], write: true, commit: true }, true);
    const affected = (result as Record<string, unknown> | null)?.["affected"];
    return done(`the statement was committed on ${args["app"]}${typeof affected === "number" ? `, ${affected} rows changed` : ""}.`, untrusted(`rows:${args["app"]}`, result));
  },
);

const tools: readonly Tool[] = [
  reader("whoami", "Who am I", "The member this token acts for, the token (name, read-only, tools it is narrowed to, expiry) and what it runs of the Chest.", input({}), async (_, context) =>
    data("Who this token acts for, and what it may run:", untrusted("chest:me", await get(context, "/me"))),
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
    async args => ({ summary: `Would start ${args["app"]} again with its variables as they are now; the instance in service keeps the traffic until the new one answers.` }),
    async (args, _, context) => {
      await post(context, `/tools/${segment(args["app"])}/redeploy`, {}, true);
      return done(`${args["app"]} was started again and its new instance answers.`);
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
  {
    ...queryWrite,
    run: async (args, context) => {
      if (args["write"] === true) return queryWrite.run(args, context);
      if (args["confirmation"] !== undefined) return invalid("a confirmation is only for a statement run with write: true");
      const result = await post(context, `/tools/${segment(args["app"])}/database/query`, { sql: args["sql"] }, false);
      return data(`Result of the statement on ${args["app"]} (read only):`, untrusted(`rows:${args["app"]}`, result));
    },
  },
  writer(
    "db_insert",
    "Add a row",
    "Adds a row to a table of a tool's database; the columns not named take their default. A view, a table without a primary key or chest_migrations is never edited.",
    input({ app, schema: schemaName, table: tableName, values }, ["app", "schema", "table", "values"]),
    { destructive: false },
    async args => ({
      summary: `Would add to ${quoted(args["schema"])}.${quoted(args["table"])} of ${args["app"]} a row with the values: ${quoted(args["values"])}`,
      affected: 1,
    }),
    async (args, _, context) => {
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
    async args => ({
      summary: `Would change in ${quoted(args["schema"])}.${quoted(args["table"])} of ${args["app"]} the row of key ${quoted(args["key"])} (version ${args["version"]}) to the values: ${quoted(args["values"])}`,
      affected: 1,
    }),
    async (args, _, context) => {
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
    async args => ({ summary: `Would delete from ${quoted(args["schema"])}.${quoted(args["table"])} of ${args["app"]} the row of key ${quoted(args["key"])} (version ${args["version"]}).`, affected: 1 }),
    async (args, _, context) => {
      await post(context, `/tools/${segment(args["app"])}/database/rows/delete`, { table: table(args), key: args["key"], version: args["version"] }, true);
      return done(`the row of key ${quoted(args["key"])} was deleted from ${quoted(args["schema"])}.${quoted(args["table"])} of ${args["app"]}.`);
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
      const listed = object(await get(context, `/tools/${segment(args["app"])}/variables`));
      const current = objects(listed["variables"]).find(variable => variable["name"] === args["name"]);
      const expected = Array.isArray(listed["expected"]) && listed["expected"].includes(args["name"]);
      if (!set && !current) throw new ChestError("not_found", `${args["name"]} is not a variable of ${args["app"]}: nothing to remove`, { uncertain: false });
      const what = set
        ? `Would set the variable ${args["name"]} of ${args["app"]}${args["secret"] ? " as a secret" : ""} (the value is not repeated here)${current ? `, replacing its value${current["secret"] === true ? " (secret)" : ""}` : ", a new variable"}.`
        : `Would remove the variable ${args["name"]} of ${args["app"]}.`;
      return { summary: `${what} The version in service ${expected ? "expects" : "does not name"} it. It applies at the next start (redeploy).` };
    },
    async (args, _, context) => {
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
    "Installs a tool of the catalogue, exactly as its entry says (repository, commit, permissions, roles): the Chest builds and installs it in the background. For whoever runs the Chest (owner, admins); a member proposes it instead (propose_tool). Replacing a running tool is not for agents.",
    input({ name: toolName, as, open_public: { type: "boolean", description: "Open its public part once installed, for a tool that declares one." } }, ["name"]),
    { destructive: false },
    async (args, context) => {
      const entry = await catalogueEntry(context, args["name"]);
      if (typeof entry["approval"] !== "string" || !/^[a-f0-9]{64}$/u.test(entry["approval"])) throw unexpected();
      return {
        summary: `Would install the catalogue tool ${args["name"]}${args["as"] ? ` under the name ${args["as"]}` : ""}${args["open_public"] ? ", its public part opened" : ""}, exactly as its entry below says: its repository, its commit, the permissions and roles it asks.`,
        preview: entryPreview(args["name"], entry),
        bound: { approval: entry["approval"] },
      };
    },
    async (args, bound, context) => {
      // The digest of the entry shown: the Chest refuses it if the entry changed since.
      const started = await post(context, "/catalogue/install", { name: args["name"], approval: bound["approval"], ...given(args, "as", "open_public") }, true);
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
    "Links a branch of a repository to the tool its manifest names (or as): the head of the branch is built and installed, and with auto its pushes are followed. For whoever runs the Chest. Replacing a running tool is not for agents.",
    input({ repository, branch, as, auto: { type: "boolean", description: "Build and install each new push of the branch." } }, ["repository", "branch"]),
    { destructive: false },
    async (args, context) => ({
      summary: `Would link the branch ${args["branch"]} of ${args["repository"]} to the tool its manifest below names${args["as"] ? `, under the name ${args["as"]}` : ""}: the Chest builds its head and installs it${args["auto"] ? ", then each new push" : ""}. The head may move between this dry run and the commit.`,
      preview: await manifest(context, args),
    }),
    async (args, _, context) => {
      const linked = await post(context, "/github/links", { repository: args["repository"], branch: args["branch"], ...given(args, "as", "auto") }, true);
      return done(`${args["repository"]} is linked; its head is being built. Follow it with tool_status.`, untrusted(`github:${args["repository"]}@${args["branch"]}`, linked));
    },
  ),
  writer(
    "propose_tool",
    "Propose a tool",
    "Proposes a tool — of the catalogue (name), or of a GitHub repository (repository, branch) — to whoever runs the Chest, who decides in the Chest.",
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
      const what = catalogue ? `the catalogue tool ${args["name"]}` : `the branch ${args["branch"]} of ${args["repository"]}`;
      return {
        summary: `Would propose ${what}${args["as"] ? ` under the name ${args["as"]}` : ""} to whoever runs the Chest, as shown below; they decide in the Chest.`,
        preview: catalogue ? entryPreview(args["name"], await catalogueEntry(context, args["name"])) : await manifest(context, args),
      };
    },
    async (args, _, context) => {
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
