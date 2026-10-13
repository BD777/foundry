import { useEffect, useRef, useState } from "react";
import type { ConversationProps } from "./conversation-types";
import type { ConversationDrafts } from "./use-conversation-drafts";

/** How long an accepted new chat's message waits for the host to show it. */
const handoffLimitMs = 5000;

/**
 * One request at a time: a send, steer or stop holds the input until it
 * ends. `steeringId` names the queued message being steered.
 */
export function useBusyGate() {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [steeringId, setSteeringId] = useState<string>();
  return {
    pending,
    steeringId,
    held: () => busy.current,
    begin(steering?: string) {
      busy.current = true;
      setPending(true);
      if (steering) setSteeringId(steering);
    },
    end() {
      busy.current = false;
      setPending(false);
      setSteeringId(undefined);
    },
  };
}

/**
 * The composer message on its way to the server: it stays shown, read-only,
 * until accepted, so it is never in two places. It is let go as soon as the
 * server accepted it or the transcript shows it, whichever comes first; a
 * new chat's accepted message is kept until the host shows its new key.
 */
export function useComposerFlight({
  threadKey,
  messages,
  drafts,
  latest,
}: {
  threadKey: string;
  messages: ConversationProps["messages"];
  drafts: ConversationDrafts;
  latest: () => ConversationProps;
}) {
  const [sendingKey, setSendingKey] = useState<string>();
  const sendingKeyRef = useRef<string | undefined>(undefined);
  const handoff = useRef<string | undefined>(undefined);
  const inFlight = useRef<
    | {
        key: string;
        clientId: string;
        attachmentIds: string[];
        released: boolean;
      }
    | undefined
  >(undefined);

  function mark(key: string | undefined) {
    sendingKeyRef.current = key;
    setSendingKey(key);
  }
  function releaseHandoff(key: string) {
    if (handoff.current !== key) return;
    handoff.current = undefined;
    drafts.update("", key);
    mark(undefined);
  }

  useEffect(() => {
    if (handoff.current && handoff.current !== threadKey)
      releaseHandoff(handoff.current);
  }, [threadKey]);
  // The transcript shows the message before the server's reply arrived:
  // the composer lets it go now, and stays free while the reply is awaited.
  useEffect(() => {
    const flight = inFlight.current;
    if (!flight || flight.released) return;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.clientId !== flight.clientId) continue;
      flight.released = true;
      drafts.update("", flight.key);
      flight.attachmentIds.forEach((id) => latest().onAttachmentRemove?.(id));
      if (handoff.current !== flight.key) mark(undefined);
      return;
    }
  }, [messages]);

  return {
    /** The shown conversation's composer text is on its way. */
    sending: sendingKey === threadKey,
    sendingKey: () => sendingKeyRef.current,
    mark,
    start(key: string, clientId: string, attachmentIds: string[]) {
      mark(key);
      inFlight.current = { key, clientId, attachmentIds, released: false };
    },
    /** The transcript already shows the message on its way. */
    released: () => Boolean(inFlight.current?.released),
    finish(key: string) {
      inFlight.current = undefined;
      if (handoff.current !== key) mark(undefined);
    },
    /**
     * The host shows the new key's transcript a moment later; until then
     * the message stays at `key`, read-only, so it is always visible.
     */
    handOff(key: string) {
      handoff.current = key;
      window.setTimeout(() => releaseHandoff(key), handoffLimitMs);
    },
  };
}

/**
 * An accepted send must not drain the next queued message until the host
 * has projected the execution it started (HTTP acknowledgement can beat SSE).
 */
export function useAwaitingExecution(props: ConversationProps) {
  const { threadKey, active, sending, activeExecutionId } = props;
  const [awaiting, setAwaiting] = useState<Record<string, string | undefined>>(
    {},
  );
  const awaitingRef = useRef(awaiting);
  awaitingRef.current = awaiting;
  function clear(key: string) {
    setAwaiting((value) => {
      const { [key]: _done, ...rest } = value;
      return rest;
    });
  }
  useEffect(() => {
    if (!(threadKey in awaiting)) return;
    if (active || sending || activeExecutionId !== awaiting[threadKey])
      clear(threadKey);
  }, [threadKey, active, sending, activeExecutionId, awaiting]);
  return {
    /** The shown conversation waits for its execution to appear. */
    waiting: threadKey in awaiting,
    isWaiting: (key: string) => key in awaitingRef.current,
    set(key: string, executionId: string | undefined) {
      setAwaiting((value) => ({ ...value, [key]: executionId }));
    },
    clear,
  };
}

export type ComposerFlight = ReturnType<typeof useComposerFlight>;
export type BusyGate = ReturnType<typeof useBusyGate>;
export type AwaitingExecution = ReturnType<typeof useAwaitingExecution>;
