import { parseSchema as parseSchemaValue } from '@engine';
import type { Schema } from '@engine';

export interface ParsedSchema {
  schema: Schema | null;
  /** Parse failure, a shape problem, or a summary of `validate` errors — whichever came first. */
  error: string | null;
}

/**
 * Parse the JSON editor text. The shape and invariant checks live in the engine
 * (`parseSchema`) so the editor and `/api/apply` agree on what a schema is;
 * everything left here is turning the result into something to show a person.
 */
export function parseSchema(text: string): ParsedSchema {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { schema: null, error: `Invalid JSON: ${(e as Error).message}` };
  }

  const result = parseSchemaValue(value);
  return result.errors
    ? { schema: null, error: result.errors.map((e) => `• ${e}`).join('\n') }
    : { schema: result.schema, error: null };
}

export function serializeSchema(schema: Schema): string {
  return JSON.stringify(schema, null, 2);
}
