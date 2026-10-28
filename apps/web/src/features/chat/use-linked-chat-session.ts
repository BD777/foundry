import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSession } from "@bd777/foundry-protocol";
import { getAgentSession, isAbortError, isNotFoundForCaller } from "../../api";
import { mergeLoadedAgentSession } from "../../lib/agent-session-events";
import { openChatInItsWorkspace } from "../../lib/in-app-navigation";

/**
 * A chat opened by id (a link, the address bar) that the workspace's list
 * does not hold: older than the list reaches, or not in this workspace.
 */
export type LinkedChatSession =
  | { state: "none" }
  | { state: "loading" }
  | { state: "found"; session: AgentSession }
  | { state: "elsewhere"; workspaceId: string }
  | { state: "missing" }
  | { state: "failed"; retry: () => void };

type LookupResult = Exclude<
  LinkedChatSession,
  { state: "none" } | { state: "loading" } | { state: "failed" }
>;

/** What a session read by id means for the workspace shown. */
export function linkedChatOutcome(
  session: AgentSession,
  workspaceId: string,
): LookupResult {
  if (session.workspaceId !== workspaceId) {
    return { state: "elsewhere", workspaceId: session.workspaceId };
  }
  // The transcript loads as for any chat: a recent window, older on request.
  return { state: "found", session: { ...session, events: undefined } };
}

/**
 * Looks up the selected chat by id when the workspace's list does not hold
 * it (`listed` false), once the workspace shown is settled (`ready`).
 * `mergeLoaded` takes the transcript loads of a session found so.
 */
export function useLinkedChatSession({
  id,
  listed,
  ready,
  workspaceId,
}: {
  id: string;
  listed: boolean;
  ready: boolean;
  workspaceId: string;
}): {
  linked: LinkedChatSession;
  mergeLoaded: (sessions: readonly AgentSession[]) => void;
} {
  const key = `${workspaceId}\u0000${id}`;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    attempt: number;
    key: string;
    value: LookupResult | { state: "failed" };
  }>();
  const resultRef = useRef(result);
  resultRef.current = result;
  const wanted = Boolean(id && workspaceId && ready && !listed);

  useEffect(() => {
    const held = resultRef.current;
    if (!wanted || (held?.key === key && held.attempt === attempt)) return;
    const controller = new AbortController();
    getAgentSession(id, { signal: controller.signal }).then(
      (session) => {
        if (controller.signal.aborted) return;
        setResult({
          attempt,
          key,
          value: linkedChatOutcome(session, workspaceId),
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setResult({
          attempt,
          key,
          value: isNotFoundForCaller(error)
            ? { state: "missing" }
            : { state: "failed" },
        });
      },
    );
    return () => controller.abort();
  }, [attempt, id, key, wanted, workspaceId]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const mergeLoaded = useCallback(
    (sessions: readonly AgentSession[]) =>
      setResult((current) => {
        if (current?.value.state !== "found") return current;
        const shown = current.value.session;
        const loaded = sessions.find((session) => session.id === shown.id);
        return loaded
          ? {
              ...current,
              value: {
                state: "found",
                session: mergeLoadedAgentSession(shown, loaded),
              },
            }
          : current;
      }),
    [],
  );

  let linked: LinkedChatSession;
  if (!id || listed) linked = { state: "none" };
  else if (result?.key !== key || result.attempt !== attempt)
    linked = { state: "loading" };
  else if (result.value.state === "failed") linked = { state: "failed", retry };
  else linked = result.value;
  return { linked, mergeLoaded };
}

/**
 * A chat opened by id that is another workspace's opens there: a link
 * names a chat, so following it is the person's choice, and the address is
 * corrected in place. True while the switch runs (`ready` false). A switch
 * that fails is not repeated: the notice offers it instead.
 */
export function useFollowLinkedChat(
  linked: LinkedChatSession,
  chatId: string,
  ready: boolean,
): boolean {
  const workspaceId = linked.state === "elsewhere" ? linked.workspaceId : "";
  const target = workspaceId ? `${chatId}\u0000${workspaceId}` : "";
  // The chat and workspace followed, until the chat shows where it is.
  const followed = useRef("");
  useEffect(() => {
    if (!target) {
      followed.current = "";
      return;
    }
    if (followed.current === target) return;
    followed.current = target;
    openChatInItsWorkspace(chatId, workspaceId);
  }, [chatId, target, workspaceId]);
  return Boolean(target) && (followed.current !== target || !ready);
}
