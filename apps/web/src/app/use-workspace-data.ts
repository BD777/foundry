import type { ToastTone } from "../components/ui/toast";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import {
  backgroundReadTimeoutMs,
  isAbortError,
  loadFoundryWorkspace,
} from "../api";
import type {
  FoundryData,
  FoundryDataField,
  FoundryStreamEvent,
} from "../api-types";
import {
  useSelectionFlight,
  type FieldRequest,
  type FieldSelection,
} from "../lib/single-flight";
import { preferredIssueId } from "../lib/issue-meta";
import { isSessionLive } from "../lib/session-status";
import { firstLoadedChatId } from "./chat-selection";
import { mergeLoadedFoundryData } from "./foundry-data-projection";
import { demoFoundryData, emptyFoundryData } from "./initial-data";
import {
  applyAnsweredEvent,
  applyFoundryDataAnswer,
  chatSelectionAfterRead,
  loadedChatSelection,
  readFoundryDataSelection,
} from "./loaded-foundry-data";
import {
  addressNamesIssue,
  initialWorkspaceId,
  persistWorkspaceId,
  workspaceIdFromLocation,
  type NavView,
} from "./navigation";
import { createStreamTouchLedger } from "./stream-touches";
import { useFoundryLiveData } from "./use-foundry-live-data";
import { useRequestChannels } from "./use-request-channels";

export type ApiState = "connected" | "fallback" | "loading" | "saving";

export interface RefreshDataOptions {
  silent?: boolean;
  throwOnError?: boolean;
  fields?: readonly FoundryDataField[];
}

// The skill library's catalog, which only the Skills pages read.
const catalogFields: readonly FoundryDataField[] = ["promotedSkills"];
const noFields: readonly FoundryDataField[] = [];

export function demoFallbackEnabled(): boolean {
  return (
    import.meta.env.VITE_DEMO_FALLBACK === "1" ||
    new URLSearchParams(window.location.search).get("demo") === "1"
  );
}

/** What the app shows before its first read. */
export function initialFoundryData(): FoundryData {
  return demoFallbackEnabled() ? demoFoundryData : emptyFoundryData;
}

export interface UseWorkspaceDataInput {
  activeView: NavView;
  /** The Issue selected when the app opens, kept by its first read. */
  selectedIssueId: string;
  setNotice: (message: string, tone?: ToastTone) => void;
  setSelectedChatId: Dispatch<SetStateAction<string>>;
  setSelectedIssueId: Dispatch<SetStateAction<string>>;
}

/**
 * Owns the workspace data shown: its reads (one at a time, see refreshData),
 * workspace switches, and the live data that keeps it fresh. Reads that land
 * re-resolve the selected Issue and chat against what they show.
 */
export function useWorkspaceData({
  activeView,
  selectedIssueId,
  setNotice,
  setSelectedChatId,
  setSelectedIssueId,
}: UseWorkspaceDataInput) {
  const { t } = useTranslation("shell");
  const demoFallback = demoFallbackEnabled();
  const [apiState, setApiState] = useState<ApiState>("loading");
  const [data, setData] = useState<FoundryData>(initialFoundryData);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() =>
    initialWorkspaceId(initialFoundryData().workspace.id),
  );
  const workspaceLoadSeqRef = useRef(0);
  const workspaceLoadingRef = useRef(false);
  const requestChannels = useRequestChannels();
  const [streamTouches] = useState(createStreamTouchLedger);
  const pendingIssueSelectionRef = useRef<string | undefined>(undefined);
  const readDataOnce = useSelectionFlight(readLatestData, {
    timeoutMs: backgroundReadTimeoutMs,
  });
  const dataRef = useRef(data);
  dataRef.current = data;
  const readContext = {
    touches: streamTouches,
    shown: () => dataRef.current,
    setData,
    setActiveWorkspaceId,
    setApiState,
  };
  // What a workspace switch left to read, once the switch has rendered.
  const [switchRead, setSwitchRead] =
    useState<FieldRequest<FoundryDataField>>();
  useEffect(() => {
    if (!switchRead) return;
    setSwitchRead(undefined);
    void readDataOnce(switchRead);
  }, [switchRead]);

  // Reads workspace data once (see refreshData): the default set, or the
  // fields selected; a read that stalls fails after backgroundReadTimeoutMs.
  // Whatever live events changed after the read started stays as shown
  // when it lands.
  async function readLatestData(
    selection: FieldSelection<FoundryDataField>,
    signal: AbortSignal,
  ): Promise<"applied" | "failed" | "skipped"> {
    if (workspaceLoadingRef.current) return "skipped";
    const workspaceSeq = workspaceLoadSeqRef.current;
    const nextSelectedIssueId = pendingIssueSelectionRef.current;
    pendingIssueSelectionRef.current = undefined;
    try {
      const result = await readFoundryDataSelection(
        activeWorkspaceId,
        selection,
        signal,
      );
      if (workspaceSeq !== workspaceLoadSeqRef.current) return "skipped";
      const { data: loaded, fields } = result;
      // The answer may have started in another tab, before this call.
      const mark = streamTouches.markAt(result.requestedAt);
      const touched = () => streamTouches.since(mark);
      const missed = applyFoundryDataAnswer(result, mark, readContext);
      if (missed) setSwitchRead(missed);
      if (result.notModified) return "applied";
      const read = (field: FoundryDataField) =>
        !fields || fields.includes(field);
      if (read("issues"))
        setSelectedIssueId((current) => {
          if (
            nextSelectedIssueId &&
            loaded.issues.some((issue) => issue.id === nextSelectedIssueId)
          ) {
            return nextSelectedIssueId;
          }
          // The Issue the address names stays selected though the read does
          // not list it: its page looks it up (useLinkedIssue).
          return loaded.issues.some((issue) => issue.id === current) ||
            addressNamesIssue(current)
            ? current
            : preferredIssueId(loaded.issues);
        });
      if (read("chats") || read("agentSessions")) {
        // Resolve against what the read shows: merged with what live events
        // (and answered actions) changed after it started.
        const shown = mergeLoadedFoundryData(
          dataRef.current,
          loaded,
          touched(),
          fields,
        );
        setSelectedChatId((current) => chatSelectionAfterRead(shown, current));
      }
      return "applied";
    } catch {
      if (workspaceSeq !== workspaceLoadSeqRef.current) return "skipped";
      // A transient reconnect must not erase the task or unmount its draft.
      setData((current) =>
        current.workspace.id ? current : initialFoundryData(),
      );
      setApiState("fallback");
      return "failed";
    }
  }

  // The page fields the view shown reads (see useFoundryLiveData).
  const pageFields =
    activeView === "skills" || activeView === "library"
      ? catalogFields
      : noFields;

  // At most one read runs; callers meanwhile share one more read that starts
  // after it, so each caller sees data read after its call: the default set
  // with the page fields the view shows, or only `fields` (see view-fields).
  async function refreshData(options: RefreshDataOptions = {}): Promise<void> {
    const outcome = await readDataOnce(
      options.fields
        ? { fields: options.fields }
        : { all: true, fields: pageFields },
    );
    if (outcome === "applied") {
      if (!options.silent) setNotice(t("notices.dataRefreshed"));
      return;
    }
    if (outcome !== "failed") return;
    if (options.throwOnError) throw new Error(t("notices.readFailed"));
    if (!options.silent) {
      setNotice(
        demoFallback ? t("notices.readFallback") : t("notices.readFailed"),
        "error",
      );
    }
  }

  async function loadWorkspace(
    workspaceId: string,
    noticeMessage?: string,
    options: { selectedChatId?: string } = {},
  ): Promise<boolean> {
    if (!workspaceId || workspaceId === data.workspace.id) {
      return workspaceId === data.workspace.id;
    }
    const requestSeq = workspaceLoadSeqRef.current + 1;
    workspaceLoadSeqRef.current = requestSeq;
    workspaceLoadingRef.current = true;
    const signal = requestChannels.signalFor("workspace-load");
    try {
      setApiState("loading");
      // With nothing shown yet there is nothing to keep: read it whole.
      const result = await loadFoundryWorkspace(workspaceId, {
        signal,
        whole: !data.workspace.id,
      });
      const loaded = result.data;
      // The sequence guard still protects state that a resolved-but-stale
      // response could clobber before its abort is observed.
      if (workspaceLoadSeqRef.current !== requestSeq) {
        return false;
      }
      if (loaded.workspace.id !== workspaceId) {
        throw new Error("The requested workspace is no longer available.");
      }
      const missed = applyFoundryDataAnswer(
        result,
        streamTouches.markAt(result.requestedAt),
        readContext,
      );
      if (missed) setSwitchRead(missed);
      setSelectedChatId(
        options.selectedChatId ??
          firstLoadedChatId(loadedChatSelection(loaded)),
      );
      setApiState("connected");
      if (noticeMessage) {
        setNotice(noticeMessage);
      }
      return true;
    } catch (error) {
      if (isAbortError(error) || workspaceLoadSeqRef.current !== requestSeq) {
        return false;
      }
      setApiState("fallback");
      setNotice(t("notices.switchFailed"), "error");
      return false;
    } finally {
      if (workspaceLoadSeqRef.current === requestSeq) {
        workspaceLoadingRef.current = false;
      }
    }
  }

  // The live-data layer reads once the stream opens; the demo reads here.
  useEffect(() => {
    const routeWorkspaceId = workspaceIdFromLocation();
    if (routeWorkspaceId) {
      persistWorkspaceId(routeWorkspaceId);
    }
    pendingIssueSelectionRef.current = selectedIssueId || undefined;
    if (demoFallback) void refreshData({ silent: true });
  }, []);

  const pageFieldsLoaded = useFoundryLiveData({
    activeSession:
      data.agentSessions.some(isSessionLive) ||
      data.issues.some((issue) => issue.status === "in_progress"),
    devices: data.devices,
    enabled: !demoFallback,
    onRefresh: readDataOnce,
    pageFields,
    setData,
    touches: streamTouches,
    workspaceId: activeWorkspaceId,
  });

  return {
    activeWorkspaceId,
    apiState,
    /** Shows a change the server answered before its live event arrives. */
    applyAnswered: (event: FoundryStreamEvent) =>
      applyAnsweredEvent(readContext, event),
    data,
    demoFallback,
    loadWorkspace,
    pageFieldsLoaded,
    refreshData,
    setData,
  };
}

export type WorkspaceData = ReturnType<typeof useWorkspaceData>;
