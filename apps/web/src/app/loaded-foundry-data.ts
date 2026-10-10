import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { loadFoundryData, type FoundryDataLoadResult } from "../api";
import type { FoundryData, FoundryDataField } from "../api-types";
import {
  chatThreadsFromSessions,
  isChatSession,
  preferredChatId,
} from "../features/chat";
import {
  resolveLoadedChatSelection,
  type LoadedChatSelection,
} from "./chat-selection";
import {
  applyFoundryStreamEvents,
  compactFoundryStreamEvents,
  foundryDataFields,
  foundryDataPageFields,
  mergeLoadedFoundryData,
} from "./foundry-data-projection";
import { dataChangeConcerns } from "./use-foundry-live-data";
import { parseAppRoute, persistWorkspaceId } from "./navigation";
import type { StreamTouchLedger, StreamTouches } from "./stream-touches";
import type { FieldRequest, FieldSelection } from "../lib/single-flight";

// Project a freshly-loaded payload into the chat identities the selection
// policy needs. Thread grouping stays owned by the chat feature.
export function loadedChatSelection(loaded: FoundryData): LoadedChatSelection {
  const chatSessions = loaded.agentSessions.filter(isChatSession);
  return {
    chatSessions,
    chatThreads: chatThreadsFromSessions(chatSessions),
    chats: loaded.chats,
    preferredChatId: preferredChatId(loaded.chats),
  };
}

// Resolve which chat should stay selected after a data load. Shared by
// refreshData and the workspace deletion handler. The route check stays here
// because it reads live browser location.
export function resolveChatSelection(
  loaded: FoundryData,
  current: string,
  options: { respectChatRoute?: boolean } = {},
): string {
  if (options.respectChatRoute) {
    const chatRoute = parseAppRoute(window.location.pathname);
    if (chatRoute.view === "chats" && !chatRoute.selectedChatId) {
      return "";
    }
  }
  return resolveLoadedChatSelection(loadedChatSelection(loaded), current);
}

// Apply a freshly-loaded FoundryData payload: merge it into state, update
// the active workspace id, and mark the API as connected. Shared by
// refreshData, loadWorkspace, and the workspace deletion handler. `touched`
// names what live events changed since the read started (kept as shown);
// `fields` what the read selected (see mergeLoadedFoundryData).
export function applyLoadedData(
  setData: Dispatch<SetStateAction<FoundryData>>,
  setActiveWorkspaceId: (id: string) => void,
  setApiState: (state: "connected" | "fallback" | "loading" | "saving") => void,
  loaded: FoundryData,
  touched?: () => StreamTouches,
  fields?: readonly FoundryDataField[],
): void {
  setData((current) =>
    mergeLoadedFoundryData(current, loaded, touched?.(), fields),
  );
  setActiveWorkspaceId(loaded.workspace.id);
  persistWorkspaceId(loaded.workspace.id);
  setApiState("connected");
}

/**
 * Reads what `selection` asks for. A read covering the default set is a
 * whole read: it changes every field but the pages' own (and may switch
 * workspace, as the first read does), and brings the page fields asked for
 * besides. Otherwise only the named fields are read and changed. `fields`
 * is what the answer changes (undefined: a whole read).
 */
export async function readFoundryDataSelection(
  workspaceId: string,
  selection: FieldSelection<FoundryDataField>,
  signal: AbortSignal,
): Promise<FoundryDataLoadResult> {
  const named = [...selection.fields];
  const request = !selection.all
    ? named
    : named.length
      ? [
          ...new Set([
            ...foundryDataFields.filter(
              (field) => !foundryDataPageFields.includes(field),
            ),
            ...named,
          ]),
        ]
      : undefined;
  const result = await loadFoundryData(workspaceId, {
    signal,
    fields: request,
  });
  return { ...result, fields: selection.all ? undefined : result.fields };
}

/** What the app's data reads change and say. */
export interface FoundryDataReadContext {
  touches: StreamTouchLedger;
  /** The data shown now. */
  shown: () => FoundryData;
  setData: Dispatch<SetStateAction<FoundryData>>;
  setActiveWorkspaceId: (id: string) => void;
  setApiState: (state: "connected" | "fallback" | "loading" | "saving") => void;
}

/**
 * Applies a read's answer as the app shows it: merged over what is shown,
 * keeping what live events changed after `mark` (taken when the read
 * started). An answer for another workspace than shown (the first read, a
 * switch) replaces it, with the live events since its request applied
 * over it: they did not apply to the workspace shown. Returns what those
 * events said only a read shows, if anything.
 */
export function applyFoundryDataAnswer(
  result: FoundryDataLoadResult,
  mark: number,
  context: FoundryDataReadContext,
): FieldRequest<FoundryDataField> | undefined {
  const { data: loaded, fields } = result;
  const switched =
    !fields && loaded.workspace.id !== context.shown().workspace.id;
  applyLoadedData(
    context.setData,
    context.setActiveWorkspaceId,
    context.setApiState,
    loaded,
    () => context.touches.since(mark),
    fields,
  );
  if (!switched) return undefined;
  const missed = replayMissedEvents(
    context.touches,
    result.requestedAt,
    loaded.workspace.id,
    context.setData,
  );
  return missed.all || missed.fields.length ? missed : undefined;
}

/**
 * Applies over a read of another workspace the live events that arrived
 * since it was requested (`requestedAt`): shown so far, they did not apply
 * to the workspace it answers. Returns what changes named that only a read
 * can show: `all` when any change (or events the ledger no longer holds)
 * may touch any field.
 */
export function replayMissedEvents(
  touches: StreamTouchLedger,
  requestedAt: number,
  workspaceId: string,
  setData: Dispatch<SetStateAction<FoundryData>>,
): { all: boolean; fields: FoundryDataField[] } {
  const missed = touches.eventsSince(requestedAt);
  if (!missed) return { all: true, fields: [] };
  if (missed.length)
    setData((current) =>
      applyFoundryStreamEvents(current, compactFoundryStreamEvents(missed)),
    );
  let all = false;
  const fields = new Set<FoundryDataField>();
  for (const event of missed) {
    if (
      event.type !== "foundry_data_changed" ||
      !dataChangeConcerns(event, workspaceId)
    )
      continue;
    if (!event.payload.resources?.length) all = true;
    event.payload.resources?.forEach((field) => fields.add(field));
  }
  return { all, fields: [...fields] };
}

/**
 * The selected chat, removed by a live change (another tab or device
 * deleted it, a session took it over), is replaced as a read would replace
 * it.
 */
export function useRemovedChatSelection(
  data: FoundryData,
  selectedChatId: string,
  setSelectedChatId: Dispatch<SetStateAction<string>>,
): void {
  const previous = useRef(data.chats);
  useEffect(() => {
    const before = previous.current;
    previous.current = data.chats;
    if (
      !selectedChatId ||
      !before.some((chat) => chat.id === selectedChatId) ||
      data.chats.some((chat) => chat.id === selectedChatId)
    )
      return;
    setSelectedChatId((current) =>
      current === selectedChatId
        ? resolveChatSelection(data, current, { respectChatRoute: true })
        : current,
    );
  }, [data.chats]);
}
