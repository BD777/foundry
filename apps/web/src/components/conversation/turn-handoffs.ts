/**
 * Work one turn handed to another session or workspace, read from the tool
 * call that handed it over (DEV-250). The worker serializes a tool call as
 * its name and JSON sections — Claude's call detail is the name and its
 * input; Codex's is the name, `Arguments`, `Result` and `Error` — so a
 * handoff is read from that structured record, never from the answer's prose.
 *
 * The rows are a footnote under the turn's answer: they say where work went
 * (a started session, a messaged session, a dispatched list item), and a
 * failed call stays visible, muted, instead of disappearing into the
 * collapsed process group.
 */
export type TurnHandoffKind =
  "create_session" | "send_message" | "dispatch_item";

const handoffToolKinds = new Set<TurnHandoffKind>([
  "create_session",
  "send_message",
  "dispatch_item",
]);

/** The fields a turn's tool steps give to a handoff. */
export interface TurnHandoff {
  /** The tool call's id: two reports of one call become one row. */
  id: string;
  kind: TurnHandoffKind;
  /** The session whose turn made the call: a created session's parent. */
  fromSessionId?: string;
  /** The session the call names: messaged, created or continued. */
  sessionId?: string;
  workspaceId?: string;
  /** A session title the call or its result carries. */
  title?: string;
  /** The list item a dispatch starts or continues. */
  itemId?: string;
  /** A send_message delivery other than the default (boundary). */
  delivery?: "interrupt" | "turn_end";
  /** A session or operation status its result stated. */
  status?: string;
  /** The call was refused or errored. */
  failed?: boolean;
  /** The short reason a failed call gave. */
  failure?: string;
}

/** One tool step of a transcript, as both adapters and events provide it. */
export interface TurnHandoffToolStep {
  id: string;
  callId?: string;
  title?: string;
  status?: string;
  text: string;
}

/** What the Web knows about a session a handoff names. */
export interface TurnHandoffSession {
  title?: string;
  workspaceId?: string;
  status?: string;
}

/** A child session found by its parent and title (create_session). */
export type TurnHandoffChild = TurnHandoffSession & { sessionId: string };

/** The Web's lookups for names a tool call only names by id. */
export interface TurnHandoffLookups {
  session?: (sessionId: string) => TurnHandoffSession | undefined;
  /** A session a parent created with this title, when the result is absent. */
  childSession?: (
    parentSessionId: string,
    title: string,
    workspaceId: string | undefined,
  ) => TurnHandoffChild | undefined;
  workspace?: (workspaceId: string) => string | undefined;
  item?: (itemId: string) => string | undefined;
}

/** A handoff with the names and link target the transcript renders. */
export interface TurnHandoffView {
  id: string;
  kind: TurnHandoffKind;
  sessionId?: string;
  workspaceId?: string;
  /** The workspace's name, never its id. */
  workspace?: string;
  title?: string;
  itemTitle?: string;
  delivery?: "interrupt" | "turn_end";
  status?: string;
  failed?: boolean;
  failure?: string;
}

/**
 * The handoffs a turn's tool steps made. Steps of one call (a start and its
 * completion, or a call and its result) share a callId and make one handoff;
 * no prose is inspected, only the worker's own tool-call serialization.
 */
export function toolHandoffs(
  steps: readonly TurnHandoffToolStep[],
  fromSessionId?: string,
): TurnHandoff[] {
  const byCall = new Map<string, TurnHandoffToolStep[]>();
  for (const step of steps) {
    if (!step.text) continue;
    const callId = step.callId?.trim() || step.id;
    const group = byCall.get(callId);
    if (group) group.push(step);
    else byCall.set(callId, [step]);
  }
  const handoffs: TurnHandoff[] = [];
  for (const [callId, group] of byCall) {
    const name = group
      .map((step) => foundryToolName(step.text))
      .find((value): value is TurnHandoffKind => Boolean(value));
    if (!name) continue;
    const call = group.find((step) => foundryToolName(step.text) === name)!;
    const input = toolInputFields(call.text);
    const result: Record<string, unknown> = {};
    let error = "";
    for (const step of group) {
      const resultBody = toolResultBody(step.text);
      if (resultBody !== undefined)
        Object.assign(result, jsonFields(resultBody));
      else if (
        step !== call &&
        !foundryToolName(step.text) &&
        looksLikeJSON(step.text)
      )
        // A native transcript's tool result is the result JSON itself.
        Object.assign(result, jsonFields(step.text));
      const stepError = toolError(step.text);
      if (stepError) error = stepError;
    }
    const failed =
      group.some(
        (step) =>
          step.status === "failed" || /\bfailed\b/i.test(step.title ?? ""),
      ) ||
      Boolean(error) ||
      fieldString(result, "error") !== undefined;
    const handoff: TurnHandoff = {
      ...(error ? { failure: error } : {}),
      ...(failed ? { failed: true } : {}),
      ...(fromSessionId ? { fromSessionId } : {}),
      id: callId,
      kind: name,
    };
    const title = fieldString(input, "title") ?? fieldString(result, "title");
    switch (name) {
      case "create_session":
        handoff.sessionId =
          fieldString(result, "id") ?? fieldString(result, "sessionId");
        handoff.workspaceId =
          fieldString(input, "workspaceId") ??
          fieldString(result, "workspaceId");
        if (title) handoff.title = title;
        handoff.status = fieldString(result, "status");
        break;
      case "send_message": {
        handoff.sessionId =
          fieldString(input, "sessionId") ?? fieldString(result, "id");
        handoff.workspaceId = fieldString(result, "workspaceId");
        if (title) handoff.title = title;
        handoff.status = fieldString(result, "status");
        const delivery = fieldString(input, "delivery");
        if (delivery === "interrupt" || delivery === "turn_end")
          handoff.delivery = delivery;
        break;
      }
      case "dispatch_item":
        handoff.workspaceId =
          fieldString(input, "workspaceId") ??
          fieldString(result, "workspaceId");
        handoff.itemId =
          fieldString(input, "itemId") ?? fieldString(result, "itemId");
        handoff.sessionId =
          fieldString(input, "sessionId") ??
          fieldString(result, "sessionId") ??
          fieldString(result, "targetSessionId");
        handoff.status = fieldString(result, "status");
        break;
    }
    if (handoff.failure === undefined) {
      const reason = fieldString(result, "error");
      if (reason) handoff.failure = shortenReason(reason);
    }
    if (handoff.failed) delete handoff.delivery;
    handoffs.push(handoff);
  }
  return handoffs;
}

/** The render view, with names the transcript's hosts resolved. */
export function viewHandoff(
  handoff: TurnHandoff,
  lookups: TurnHandoffLookups = {},
): TurnHandoffView {
  let sessionId = handoff.sessionId;
  let title = handoff.title;
  let status = handoff.status;
  let workspaceId = handoff.workspaceId;
  let session: TurnHandoffSession | undefined;
  if (sessionId) {
    session = lookups.session?.(sessionId);
    if (session) {
      title ??= session.title;
      workspaceId ??= session.workspaceId;
      status ??= session.status;
    }
  }
  // A created session's result is not in every transcript (Claude reports
  // only the call): the child of this turn's session with that title is it.
  if (
    handoff.kind === "create_session" &&
    !sessionId &&
    handoff.fromSessionId &&
    title
  ) {
    const child = lookups.childSession?.(
      handoff.fromSessionId,
      title,
      handoff.workspaceId,
    );
    if (child) {
      sessionId = child.sessionId;
      workspaceId ??= child.workspaceId;
      title ??= child.title;
      status ??= child.status;
    }
  }
  const workspace = workspaceId ? lookups.workspace?.(workspaceId) : undefined;
  return {
    id: handoff.id,
    kind: handoff.kind,
    ...(sessionId ? { sessionId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspace ? { workspace } : {}),
    ...(title ? { title } : {}),
    ...(handoff.itemId ? { itemTitle: lookups.item?.(handoff.itemId) } : {}),
    ...(handoff.delivery ? { delivery: handoff.delivery } : {}),
    ...(status ? { status } : {}),
    ...(handoff.failed ? { failed: true } : {}),
    ...(handoff.failure ? { failure: handoff.failure } : {}),
  };
}

export function viewHandoffs(
  handoffs: readonly TurnHandoff[] | undefined,
  lookups: TurnHandoffLookups = {},
): TurnHandoffView[] | undefined {
  if (!handoffs?.length) return undefined;
  return handoffs.map((handoff) => viewHandoff(handoff, lookups));
}

/** "mcp__foundry__create_session" and "foundry.create_session" alike. */
function foundryToolName(text: string): TurnHandoffKind | undefined {
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /^(?:mcp__foundry__|foundry\.)([a-z][a-z0-9_]*)$/.exec(
    firstLine,
  );
  const name = match?.[1];
  return name && handoffToolKinds.has(name as TurnHandoffKind)
    ? (name as TurnHandoffKind)
    : undefined;
}

interface FencedBlock {
  body: string;
}

/** The first fenced block at or after `from`. */
function fencedBlock(text: string, from = 0): FencedBlock | undefined {
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)(?:```|$)/gi;
  fence.lastIndex = from;
  const match = fence.exec(text);
  return match ? { body: match[1] ?? "" } : undefined;
}

/** Where a line that is exactly one of `labels` starts. */
function sectionStart(
  text: string,
  labels: string,
  from = 0,
): number | undefined {
  const section = new RegExp(`^[\\t ]*(?:${labels})[\\t ]*$`, "gim");
  section.lastIndex = from;
  return section.exec(text)?.index;
}

/** A fenced block under a section label, ending before the next section. */
function sectionBlock(
  text: string,
  labels: string,
  stopLabels?: string,
): string | undefined {
  const start = sectionStart(text, labels);
  if (start === undefined) return undefined;
  const stop =
    stopLabels === undefined
      ? undefined
      : sectionStart(text, stopLabels, start + 1);
  const region =
    stop === undefined ? text.slice(start) : text.slice(start, stop);
  return fencedBlock(region)?.body;
}

/** The call's input: Claude's bare fenced JSON, or Codex's Arguments. */
function toolInputFields(text: string): Record<string, unknown> {
  const labeled = sectionBlock(text, "Arguments|Input", "Result|Output|Error");
  if (labeled !== undefined) return jsonFields(labeled);
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd < 0) return {};
  return jsonFields(fencedBlock(text, firstLineEnd)?.body);
}

/** The call's result: Codex's Result section, when it has one. */
function toolResultBody(text: string): string | undefined {
  return sectionBlock(text, "Result|Output", "Error");
}

/**
 * The short reason under an Error section part of the call's detail. A body
 * of exactly `null` is no error: the worker wrote it for a call whose error
 * was null (DEV-288), and stored transcripts still carry it.
 */
function toolError(text: string): string {
  const start = sectionStart(text, "Error");
  if (start === undefined) return "";
  const lineStart = text.indexOf("\n", start);
  const body = (lineStart < 0 ? "" : text.slice(lineStart + 1)).trim();
  if (!body || body === "null") return "";
  return shortenReason(body);
}

function looksLikeJSON(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("{") || value.startsWith("[");
}

function shortenReason(text: string): string {
  const line =
    text
      .replace(/```[\w-]*/g, "")
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  return line.slice(0, 200);
}

function fieldString(
  fields: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The fields a tool detail states. A complete JSON object is parsed as such;
 * the worker truncates long inputs, so a cut-off object is read field by
 * field, stopping where the text stops.
 */
function jsonFields(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  const value = text.trim();
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    return {};
  } catch {
    return readTopLevelFields(value);
  }
}

/**
 * Top-level scalar fields of an object that may end mid-value. Strings are
 * read whole (an unterminated one keeps what was cut in), nested objects and
 * arrays are skipped, and a trailing partial value is ignored.
 */
function readTopLevelFields(source: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let index = source.indexOf("{");
  if (index < 0) return fields;
  index += 1;
  const skipSpace = () => {
    while (index < source.length && /\s/.test(source[index]!)) index += 1;
  };
  const readString = (): string | undefined => {
    if (source[index] !== '"') return undefined;
    index += 1;
    let value = "";
    while (index < source.length) {
      const character = source[index++]!;
      if (character === '"') return value;
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escaped = source[index++];
      if (escaped === undefined) return value;
      switch (escaped) {
        case "b":
          value += "\b";
          break;
        case "f":
          value += "\f";
          break;
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "u": {
          const hex = source.slice(index, index + 4);
          if (/^[0-9a-f]{4}$/i.test(hex)) {
            value += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
          }
          break;
        }
        default:
          value += escaped;
      }
    }
    return value;
  };
  const skipValue = () => {
    let depth = 0;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        readString();
        continue;
      }
      if (character === "{" || character === "[") {
        depth += 1;
        index += 1;
        continue;
      }
      if (character === "}" || character === "]") {
        depth -= 1;
        index += 1;
        if (depth <= 0) return;
        continue;
      }
      index += 1;
    }
  };
  while (index < source.length) {
    skipSpace();
    const character = source[index];
    if (character === "}") break;
    if (character === ",") {
      index += 1;
      continue;
    }
    if (character !== '"') {
      index += 1;
      continue;
    }
    const key = readString();
    if (key === undefined) break;
    skipSpace();
    if (source[index] !== ":") continue;
    index += 1;
    skipSpace();
    const start = source[index];
    if (start === '"') {
      const value = readString();
      if (value !== undefined) fields[key] = value;
      continue;
    }
    if (source.startsWith("true", index)) {
      fields[key] = true;
      index += 4;
      continue;
    }
    if (source.startsWith("false", index)) {
      fields[key] = false;
      index += 5;
      continue;
    }
    if (source.startsWith("null", index)) {
      fields[key] = null;
      index += 4;
      continue;
    }
    if (start === "{" || start === "[") {
      skipValue();
      continue;
    }
    const valueStart = index;
    while (index < source.length && !/[,\]}\s]/.test(source[index]!))
      index += 1;
    const value = source.slice(valueStart, index);
    if (value && Number.isFinite(Number(value))) fields[key] = Number(value);
  }
  return fields;
}
