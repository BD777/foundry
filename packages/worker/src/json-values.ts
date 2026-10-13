/** Reading values of unknown shape, such as parsed JSON log records. */

export type JSONRecord = Record<string, unknown>;

export function record(value: unknown): JSONRecord {
  return value && typeof value === "object" ? (value as JSONRecord) : {};
}

export function optionalRecord(value: unknown): JSONRecord | undefined {
  return value && typeof value === "object" ? (value as JSONRecord) : undefined;
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A positive count, rounded; 0 for anything else. */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/** A message's text: a string, or the text of its parts, a blank line apart. */
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      typeof part === "string" ? part : string(record(part).text),
    )
    .filter(Boolean)
    .join("\n\n");
}

export function json(value: unknown): string {
  return typeof value === "string"
    ? value
    : JSON.stringify(value ?? {}, null, 2);
}
