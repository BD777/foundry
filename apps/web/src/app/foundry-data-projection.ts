import type {
  FoundryData,
  FoundryDataField,
  FoundryStreamEvent,
} from "../api-types";
import { workspaceSwitchFields } from "../api";
import {
  loadedMerges,
  streamProjection,
  type StreamTouches,
} from "./projections";

export { streamedDevice } from "./projections/devices";

// Every field of workspace data besides the workspace; the record makes
// the list complete.
const fieldFlags: Record<FoundryDataField, true> = {
  runs: true,
  agentProfiles: true,
  agents: true,
  agentSessions: true,
  assets: true,
  chats: true,
  deviceProfiles: true,
  deviceSkillRoots: true,
  devices: true,
  issues: true,
  profiles: true,
  promotedSkills: true,
  builtinSkills: true,
  providerHealth: true,
  skills: true,
  workspaceFiles: true,
  workspaceSkillBindings: true,
  defaultSkillIds: true,
  inheritedSkillIds: true,
  offSkillIds: true,
  deviceTools: true,
  skillBundles: true,
  workspaceBundleIds: true,
  defaultBundleIds: true,
  workspaces: true,
  workspaceSkills: true,
};
export const foundryDataFields = Object.keys(fieldFlags) as FoundryDataField[];

/**
 * Fields a read without a selection leaves out: the skill library's
 * catalog, which the pages showing it read themselves, and skills, which
 * nothing shows. They are not tied to a workspace.
 */
export const foundryDataPageFields: readonly FoundryDataField[] = [
  "promotedSkills",
  "skills",
];

/**
 * Whether a read of another workspace than shown switches to it: a whole
 * read, or a selection of every field that differs between workspaces
 * (workspaceSwitchFields); any other selection cannot.
 */
export function switchesWorkspace(
  fields: readonly FoundryDataField[] | undefined,
): boolean {
  return (
    !fields || workspaceSwitchFields.every((field) => fields.includes(field))
  );
}

/** What a selection read changes: its fields; one it lacks is empty. */
function selectedFields(
  current: FoundryData,
  loaded: FoundryData,
  fields: readonly FoundryDataField[],
): FoundryData {
  const merged: Record<string, unknown> = {
    ...current,
    workspace: loaded.workspace,
  };
  for (const field of fields) {
    if (loaded[field] === undefined) delete merged[field];
    else merged[field] = loaded[field];
  }
  return merged as unknown as FoundryData;
}

/** A whole read keeps the pages' own fields, which it leaves out. */
function withPageFields(
  loaded: FoundryData,
  current: FoundryData,
): FoundryData {
  const kept = foundryDataPageFields.filter(
    (field) => loaded[field] === undefined && current[field] !== undefined,
  );
  if (kept.length === 0) return loaded;
  const merged: Record<string, unknown> = { ...loaded };
  for (const field of kept) merged[field] = current[field];
  return merged as unknown as FoundryData;
}

/**
 * Merges a read's answer over what is shown. `touched` names what live
 * events changed after the read started, which is at least as new as the
 * read: each slice merges the fields it owns with it (see loadedMerges in
 * projections; e.g. a session an event replaced stays as shown); the other
 * fields are taken as read.
 *
 * `fields` names what the read selected: only those change (a field the
 * answer leaves out is empty). Without it the read answered every field but
 * the pages' own, which stay as they are.
 */
export function mergeLoadedFoundryData(
  current: FoundryData,
  loaded: FoundryData,
  touched?: StreamTouches,
  fields?: readonly FoundryDataField[],
): FoundryData {
  if (current === loaded) {
    return current;
  }
  const read = (field: FoundryDataField) =>
    fields ? fields.includes(field) : !foundryDataPageFields.includes(field);
  const answered = fields
    ? selectedFields(current, loaded, fields)
    : withPageFields(loaded, current);
  if (current.workspace.id !== loaded.workspace.id) {
    // Another workspace: nothing shown is newer than the read. A selection
    // switches only when it holds what differs between workspaces.
    return switchesWorkspace(fields) ? answered : current;
  }
  // The read may be the cached answer of a later 304: never change it.
  const merged: Record<string, unknown> = { ...answered };
  for (const field of Object.keys(loadedMerges) as FoundryDataField[]) {
    const merge = loadedMerges[field] as
      | ((...args: [FoundryData, FoundryData, StreamTouches?]) => unknown)
      | undefined;
    if (merge && read(field)) merged[field] = merge(current, loaded, touched);
  }
  return merged as unknown as FoundryData;
}

/**
 * Keep transport bursts cheap without changing the semantic event order: an
 * event its successor supersedes (see StreamProjection.supersedes) is left
 * out.
 */
export function compactFoundryStreamEvents(
  events: FoundryStreamEvent[],
): FoundryStreamEvent[] {
  const compacted: FoundryStreamEvent[] = [];
  for (const event of events) {
    const previous = compacted[compacted.length - 1];
    if (
      previous?.type === event.type &&
      streamProjection(event.type)?.supersedes?.(
        previous.payload,
        event.payload,
      )
    ) {
      compacted[compacted.length - 1] = event;
    } else {
      compacted.push(event);
    }
  }
  return compacted;
}

/** Apply a stream event to the shared application projection. */
export function applyFoundryStreamEvent(
  current: FoundryData,
  streamEvent: FoundryStreamEvent,
): FoundryData {
  return applyFoundryStreamEvents(current, [streamEvent]);
}

/**
 * Applies one frame's stream events in order. Each run of consecutive events
 * of one type is applied in one step (one copy per session for transcript
 * events, however many arrived); a type the workspace data does not follow
 * changes nothing.
 */
export function applyFoundryStreamEvents(
  current: FoundryData,
  streamEvents: readonly FoundryStreamEvent[],
): FoundryData {
  let next = current;
  for (let start = 0; start < streamEvents.length;) {
    const type = streamEvents[start]!.type;
    let end = start + 1;
    while (end < streamEvents.length && streamEvents[end]!.type === type) end++;
    const apply = streamProjection(type)?.apply;
    if (apply)
      next = apply(
        next,
        streamEvents.slice(start, end).map((event) => event.payload),
      );
    start = end;
  }
  return next;
}
