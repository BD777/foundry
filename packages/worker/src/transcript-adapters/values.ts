export type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  return value && typeof value === "object" ? (value as RecordValue) : {};
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
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
