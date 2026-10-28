import { useCallback, useEffect, useState } from "react";
import {
  getAgentDefaults,
  setAgentDefault,
  type AgentDefault,
  type AgentDefaultScope,
  type SetAgentDefaultInput,
  type WorkspaceAgentDefaults,
} from "../../api";
import { useReadOrder } from "../../lib/read-order";

/**
 * A workspace's default agents: read once per workspace (and on `reloadKey`
 * changes), saved one level at a time. A failed read or save throws to the
 * caller's `onError`.
 */
export function useAgentDefaults(
  workspaceId: string,
  {
    enabled = true,
    reloadKey,
    onError,
  }: {
    enabled?: boolean;
    reloadKey?: unknown;
    onError?: (error: unknown) => void;
  } = {},
) {
  const [answer, setAnswer] = useState<WorkspaceAgentDefaults>();
  const order = useReadOrder();
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    let active = true;
    const current = order.started();
    getAgentDefaults(workspaceId).then(
      (next) => {
        if (active && current()) setAnswer(next);
      },
      (error: unknown) => {
        if (active) onError?.(error);
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, workspaceId, reloadKey]);

  const save = useCallback(
    async (input: SetAgentDefaultInput) => {
      const next = await setAgentDefault(workspaceId, input);
      order.changed();
      setAnswer(next);
      return next;
    },
    [workspaceId],
  );
  return { answer, save };
}

/** The default set at one level, if any. */
export function agentDefaultAt(
  answer: WorkspaceAgentDefaults | undefined,
  scope: AgentDefaultScope,
  routeId?: string,
): AgentDefault | undefined {
  return answer?.defaults.find(
    (value) =>
      value.scope === scope &&
      (scope !== "feishu_chat" || value.routeId === routeId),
  );
}
