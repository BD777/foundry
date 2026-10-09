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
import type { ChatContextSelection } from "./chat-types";

export function useChatContextDetail(threadKey: string) {
  const [selection, setSelection] = useState<ChatContextSelection>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
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
    const request =
      selection.kind === "subagent"
        ? readAgentSubagentTranscript(selection.sessionId, selection.taskId, {
            signal,
          }).then((value) => {
            if (!signal.aborted) {
              setTranscript(value);
            }
          })
        : readSessionFile(selection.sessionId, selection.path, {
            signal,
          }).then((value) => {
            if (!signal.aborted) {
              setFile(value);
            }
          });
    void request
      .catch((reason: unknown) => {
        if (signal.aborted || isAbortError(reason)) {
          return;
        }
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!signal.aborted) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [selection]);

  const close = useCallback(() => setSelection(undefined), []);
  return {
    close,
    error,
    file,
    loading,
    selection,
    setSelection,
    transcript,
  };
}
