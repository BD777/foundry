import { useCallback, useEffect, useState } from "react";
import type {
  AgentSubagentTranscript,
  SessionFileRead,
} from "@bd777/foundry-protocol";
import {
  isAbortError,
  readAgentSubagentTranscript,
  readSessionFile,
} from "../../api";
import { requestDeviceFile } from "./device-file-request";
import type { ChatContextSelection } from "./chat-types";

export function useChatContextDetail(threadKey: string) {
  const [selection, setSelection] = useState<ChatContextSelection>();
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<unknown>();
  const [file, setFile] = useState<SessionFileRead>();
  const [transcript, setTranscript] = useState<AgentSubagentTranscript>();

  useEffect(() => setSelection(undefined), [threadKey]);
  useEffect(() => {
    setError(undefined);
    setFile(undefined);
    setTranscript(undefined);
    if (
      !selection ||
      (selection.kind !== "subagent" && selection.kind !== "session-file")
    ) {
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    setRetrying(false);
    const request = requestDeviceFile(
      async () => {
        if (selection.kind === "subagent") {
          const value = await readAgentSubagentTranscript(
            selection.sessionId,
            selection.taskId,
            { signal },
          );
          if (!signal.aborted) setTranscript(value);
        } else {
          const value = await readSessionFile(
            selection.sessionId,
            selection.path,
            { signal },
          );
          if (!signal.aborted) setFile(value);
        }
      },
      signal,
      () => setRetrying(true),
    );
    void request
      .catch((reason: unknown) => {
        if (signal.aborted || isAbortError(reason)) {
          return;
        }
        setError(
          selection.kind === "session-file"
            ? reason
            : reason instanceof Error
              ? reason.message
              : String(reason),
        );
      })
      .finally(() => {
        if (!signal.aborted) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [selection, attempt]);

  const close = useCallback(() => setSelection(undefined), []);
  return {
    close,
    retrying,
    retry: useCallback(() => setAttempt((value) => value + 1), []),
    error,
    file,
    loading,
    selection,
    setSelection,
    transcript,
  };
}
