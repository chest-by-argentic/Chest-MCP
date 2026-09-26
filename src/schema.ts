// The arguments of a tool are described once, as JSON Schema: the same
// object is what tools/list shows and what a call is checked against here,
// before anything is sent to the Chest. Only the keywords below are used.

/** A schema of an argument: the subset of JSON Schema 2020-12 this server uses. */
export type Schema =
  | { readonly type: "string"; readonly description?: string; readonly pattern?: string; readonly minLength?: number; readonly maxLength?: number; readonly enum?: readonly string[] }
  | { readonly type: "integer"; readonly description?: string; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: "boolean"; readonly description?: string }
  | { readonly type: "array"; readonly description?: string; readonly items: Schema; readonly maxItems?: number }
  | ObjectSchema;

/**
 * An object: with `properties`, exactly those (`additionalProperties:
 * false`); without, any JSON object (the values of a row).
 */
export type ObjectSchema = {
  readonly type: "object";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
};

/** Why a value does not match a schema, or undefined when it does. */
export function check(schema: Schema, value: unknown, at = "arguments"): string | undefined {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return `${at} must be a string`;
      const length = [...value].length;
      if (schema.minLength !== undefined && length < schema.minLength) return `${at} must have at least ${schema.minLength} characters`;
      if (schema.maxLength !== undefined && length > schema.maxLength) return `${at} must have at most ${schema.maxLength} characters`;
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) return `${at} must match ${schema.pattern}`;
      if (schema.enum !== undefined && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(", ")}`;
      return undefined;
    }
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${at} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be at most ${schema.maximum}`;
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${at} must be true or false`;
    case "array": {
      if (!Array.isArray(value)) return `${at} must be an array`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} must have at most ${schema.maxItems} items`;
      for (const [i, item] of value.entries()) {
        const refused = check(schema.items, item, `${at}[${i}]`);
        if (refused) return refused;
      }
      return undefined;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return `${at} must be an object`;
      if (!schema.properties) return undefined;
      const fields = value as Record<string, unknown>;
      for (const name of schema.required ?? []) {
        if (fields[name] === undefined) return `${at}.${name} is required`;
      }
      for (const [name, item] of Object.entries(fields)) {
        const property = Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined;
        if (!property) return `${at}.${name} is not an argument of this tool`;
        const refused = check(property, item, `${at}.${name}`);
        if (refused) return refused;
      }
      return undefined;
    }
  }
}
