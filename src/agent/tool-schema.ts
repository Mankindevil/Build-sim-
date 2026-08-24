type Schema = Record<string, unknown>;

function kind(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}
export function validateJsonSchema(value: unknown, schema: Schema, path = "input"): string[] {
  const errors: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    return [`${path} must be one of ${schema.enum.map(String).join(", ")}`];
  }
  const expected = schema.type;
  const actual = kind(value);
  if (typeof expected === "string") {
    const valid = expected === actual || (expected === "number" && typeof value === "number" && Number.isFinite(value));
    if (!valid) return [`${path} must be ${expected}`];
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has invalid format`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${path} must be finite`);
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} is below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} is above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path} must contain unique items`);
    if (schema.items && typeof schema.items === "object") value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items as Schema, `${path}[${index}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Schema> : {};
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const name of required) if (!(name in record)) errors.push(`${path}.${name} is required`);
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(record)) if (!(name in properties)) errors.push(`${path}.${name} is not allowed`);
    }
    for (const [name, child] of Object.entries(properties)) if (name in record) errors.push(...validateJsonSchema(record[name], child, `${path}.${name}`));
  }
  return [...new Set(errors)];
}
