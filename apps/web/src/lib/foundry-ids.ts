/**
 * Foundry object ids as they appear in text: a session (`sess_12`), an
 * Issue (`iss_3`), a device or workspace (`dev_<uuid>`, `ws_<uuid>`), and a
 * device's native chat (`native_claude_<id>`). The server mints them so
 * (sqlitestore); the Feishu cards link them the same way (feishu/ids.go).
 */
export type FoundryIdKind = "session" | "issue" | "device" | "workspace";

export type FoundryIdMatch =
  | { kind: FoundryIdKind; id: string; index: number }
  | { kind: "native"; id: string; index: number };

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const idSource = `sess_\\d+|iss_\\d+|dev_${uuid}|ws_${uuid}|native_(?:claude|codex)_[A-Za-z0-9][\\w.-]*[A-Za-z0-9]`;

// Not part of a longer word, path or address: `foo_sess_1`, `a/sess_1` and
// `sess_1x` are no ids. ASCII `\w` lets CJK text touch an id on either side.
const idPattern = new RegExp(`(?<![\\w/.@#=-])(?:${idSource})(?![\\w-])`, "g");
const wholeIdPattern = new RegExp(`^(?:${idSource})$`);

function kindOf(id: string): FoundryIdMatch["kind"] {
  if (id.startsWith("sess_")) return "session";
  if (id.startsWith("iss_")) return "issue";
  if (id.startsWith("dev_")) return "device";
  if (id.startsWith("ws_")) return "workspace";
  return "native";
}

/** The Foundry ids `text` names, in order. */
export function findFoundryIds(text: string): FoundryIdMatch[] {
  return [...text.matchAll(idPattern)].map((match) => ({
    id: match[0],
    index: match.index ?? 0,
    kind: kindOf(match[0]),
  }));
}

/** What `text` is when it is exactly one Foundry id. */
export function foundryIdKind(
  text: string,
): FoundryIdMatch["kind"] | undefined {
  return wholeIdPattern.test(text) ? kindOf(text) : undefined;
}
