/**
 * src/ai/schema.ts
 *
 * A small JSON-schema checker for model replies, covering the subset our
 * schemas use (object, array, string, number, integer, boolean, null, enum,
 * anyOf, type arrays, required, additionalProperties: false). A reply that
 * fails is never acted on, whichever provider produced it.
 */

type Schema = Record<string, unknown>;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

/** Returns null when `value` fits `schema`, else a short description of the first problem. */
export function checkSchema(value: unknown, schema: Schema, path = '$'): string | null {
  if (Array.isArray(schema.anyOf)) {
    const ok = (schema.anyOf as Schema[]).some((s) => checkSchema(value, s, path) === null);
    return ok ? null : `${path}: matches none of the allowed shapes`;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => typeMatches(value, t)))
      return `${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`;
  }
  if (Array.isArray(schema.enum) && value !== null && !(schema.enum as unknown[]).includes(value)) {
    return `${path}: ${JSON.stringify(value)} is not one of the allowed values`;
  }
  if (typeOf(value) === 'object' && schema.properties) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties as Record<string, Schema>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in obj)) return `${path}.${key}: missing`;
    }
    for (const [key, v] of Object.entries(obj)) {
      if (!props[key]) {
        if (schema.additionalProperties === false) return `${path}.${key}: not allowed`;
        continue;
      }
      const problem = checkSchema(v, props[key], `${path}.${key}`);
      if (problem) return problem;
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      const problem = checkSchema(arr[i], schema.items as Schema, `${path}[${i}]`);
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * Groq's strict mode documents nullable fields as type unions
 * (`"type": ["string", "null"]`). Rewrite our `anyOf: [{type: X, …}, {type: "null"}]`
 * into that form, adding null to any enum so the union stays valid.
 */
export function toGroqSchema(schema: Schema): Schema {
  if (Array.isArray(schema.anyOf)) {
    const parts = schema.anyOf as Schema[];
    const nonNull = parts.filter((p) => p.type !== 'null');
    if (parts.length === 2 && nonNull.length === 1 && typeof nonNull[0].type === 'string') {
      const base = toGroqSchema(nonNull[0]);
      return {
        ...base,
        type: [base.type as string, 'null'],
        ...(Array.isArray(base.enum) ? { enum: [...(base.enum as unknown[]), null] } : {}),
      };
    }
    return { ...schema, anyOf: parts.map(toGroqSchema) };
  }
  const out: Schema = { ...schema };
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, Schema>).map(([k, v]) => [k, toGroqSchema(v)]),
    );
  }
  if (schema.items) out.items = toGroqSchema(schema.items as Schema);
  return out;
}
