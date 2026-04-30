// Minimal JSON Schema validator. Supports a pragmatic subset of Draft 7:
// type, enum, const, minLength/maxLength/pattern, minimum/maximum and their
// exclusive variants, properties, required, additionalProperties, items,
// minItems/maxItems, oneOf/anyOf/allOf. Returns a list of errors (empty
// list = valid).
//
// Scope is intentionally limited so the whole module fits in a Cloudflare
// Worker without bundling a 100KB+ external validator. For richer JSON
// Schema, consumers can validate client-side with Ajv/Standard Schema and
// rely on this server-side check as a coarse boundary defense.

import type { JsonSchema, ValidationErrorDetail } from "./types.js";

export function validate(value: unknown, schema: JsonSchema): ValidationErrorDetail[] {
  const errors: ValidationErrorDetail[] = [];
  validateAt(value, schema, "", errors);
  return errors;
}

function validateAt(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: ValidationErrorDetail[]
): void {
  if (schema.const !== undefined) {
    if (!deepEqual(value, schema.const)) {
      errors.push({ path, message: `must equal const ${JSON.stringify(schema.const)}` });
    }
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((e) => deepEqual(value, e))) {
      errors.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({
        path,
        message: `expected type ${types.join(" | ")}, got ${typeOf(value)}`,
      });
      return; // type mismatch — further checks won't be meaningful
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `string longer than maxLength ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push({ path, message: `string does not match pattern ${schema.pattern}` });
        }
      } catch {
        errors.push({ path, message: `invalid regex pattern ${schema.pattern}` });
      }
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `value below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `value above maximum ${schema.maximum}` });
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push({ path, message: `value not above exclusiveMinimum ${schema.exclusiveMinimum}` });
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push({ path, message: `value not below exclusiveMaximum ${schema.exclusiveMaximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `array shorter than minItems ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `array longer than maxItems ${schema.maxItems}` });
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        validateAt(value[i], schema.items, `${path}[${i}]`, errors);
      }
    }
  }

  if (isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push({ path: joinPath(path, key), message: "is required" });
        }
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) validateAt(obj[key], sub, joinPath(path, key), errors);
      }
    }
    if (schema.additionalProperties !== undefined) {
      const known = schema.properties ? new Set(Object.keys(schema.properties)) : new Set<string>();
      for (const key of Object.keys(obj)) {
        if (known.has(key)) continue;
        if (schema.additionalProperties === false) {
          errors.push({ path: joinPath(path, key), message: "additional property not allowed" });
        } else if (typeof schema.additionalProperties === "object") {
          validateAt(obj[key], schema.additionalProperties, joinPath(path, key), errors);
        }
      }
    }
  }

  if (schema.allOf) {
    for (const sub of schema.allOf) validateAt(value, sub, path, errors);
  }

  if (schema.anyOf) {
    if (!schema.anyOf.some((sub) => validate(value, sub).length === 0)) {
      errors.push({ path, message: `must match at least one schema in anyOf` });
    }
  }

  if (schema.oneOf) {
    const matching = schema.oneOf.filter((sub) => validate(value, sub).length === 0).length;
    if (matching !== 1) {
      errors.push({ path, message: `must match exactly one schema in oneOf (matched ${matching})` });
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":  return typeof value === "string";
    case "number":  return typeof value === "number" && !Number.isNaN(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null":    return value === null;
    case "array":   return Array.isArray(value);
    case "object":  return isPlainObject(value);
    default:        return false;
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function joinPath(parent: string, key: string): string {
  return parent === "" ? `.${key}` : `${parent}.${key}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const aa = a as unknown[], ba = b as unknown[];
    return aa.length === ba.length && aa.every((v, i) => deepEqual(v, ba[i]));
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort(), bk = Object.keys(bo).sort();
  return ak.length === bk.length && ak.every((k, i) => bk[i] === k && deepEqual(ao[k], bo[k]));
}

/**
 * Resolve which schema applies to a key. Pattern semantics:
 *   - `"*"` matches any key (lowest priority)
 *   - prefix patterns end with `/` (e.g. `"users/"`) and match any key starting with that prefix
 *   - exact patterns (no trailing `/`) match only an exact key
 *
 * The most-specific match wins: exact > longest prefix > "*".
 */
export function resolveSchema(
  key: string,
  schemas: Record<string, JsonSchema>
): { schema: JsonSchema; pattern: string } | null {
  if (key in schemas) return { schema: schemas[key]!, pattern: key };

  let bestPrefix = "";
  for (const pattern of Object.keys(schemas)) {
    if (pattern.endsWith("/") && key.startsWith(pattern) && pattern.length > bestPrefix.length) {
      bestPrefix = pattern;
    }
  }
  if (bestPrefix !== "") return { schema: schemas[bestPrefix]!, pattern: bestPrefix };

  if ("*" in schemas) return { schema: schemas["*"]!, pattern: "*" };
  return null;
}
