import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantSummary } from "@bd777/foundry-protocol";
import { listAssistants } from "../api";
import { serverErrorText } from "../lib/errors";

export type AssistantDirectory =
  | { state: "loading"; assistants: [] }
  | { state: "failed"; assistants: []; message: string }
  | { state: "ready"; assistants: AssistantSummary[] };

/** The person's assistants: the list page, shell count and route aliases. */
export function useAssistants() {
  const [directory, setDirectory] = useState<AssistantDirectory>({
    state: "loading",
    assistants: [],
  });
  const readVersion = useRef(0);

  const reload = useCallback(async () => {
    const version = ++readVersion.current;
    try {
      const answer = await listAssistants();
      if (version === readVersion.current)
        setDirectory({ state: "ready", assistants: answer.assistants });
    } catch (reason) {
      if (version === readVersion.current)
        setDirectory({
          state: "failed",
          assistants: [],
          message: serverErrorText(reason),
        });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { directory, reload };
}
