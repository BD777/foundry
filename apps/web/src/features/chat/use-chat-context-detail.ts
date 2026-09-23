import { useEffect, useState } from "react";
import type {
  AgentSubagentTranscript,
  WorkspaceFileRead,
} from "@foundry/protocol";
import {
  isAbortError,
  readAgentSubagentTranscript,
  readWorkspaceFile,
} from "../../api";
import type { ChatContextSelection } from "./chat-types";

export function useChatContextDetail(threadKey: string) {
  const [selection, setSelection] = useState<ChatContextSelection>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [file, setFile] = useState<WorkspaceFileRead>();
  const [transcript, setTranscript] = useState<AgentSubagentTranscript>();

  useEffect(() => setSelection(undefined), [threadKey]);
  useEffect(() => {
    setError(undefined);
    setFile(undefined);
    setTranscript(undefined);
    if (
      !selection ||
      selection.kind === "web" ||
      selection.kind === "source" ||
      selection.kind === "timer"
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
        : selection.workspaceId
          ? readWorkspaceFile(
              {
                path: selection.target,
                workspaceId: selection.workspaceId,
              },
              { signal },
            ).then((value) => {
              if (!signal.aborted) {
                setFile(value);
              }
            })
          : Promise.reject(new Error("这个文件没有关联工作区，无法读取。"));
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

  return {
    close: () => setSelection(undefined),
    error,
    file,
    loading,
    selection,
    setSelection,
    transcript,
  };
}
