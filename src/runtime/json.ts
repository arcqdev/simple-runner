export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry));
  }
  if (typeof value === "object" && "toJSON" in value && typeof value.toJSON === "function") {
    return toJsonValue(value.toJSON());
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }
  return Object.prototype.toString.call(value);
}

export function toJsonObject(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
}

export function stringifyJson(value: unknown, indent?: number): string {
  return JSON.stringify(toJsonValue(value), null, indent);
}
