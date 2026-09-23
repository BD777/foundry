import { useEffect, useState } from "react";
import type {
  AgentModelOption,
  AgentProfileProjection,
  AgentProjection,
  ClaudeEffort,
  CodexReasoningEffort,
  CodexSpeed,
  WorkerRuntimeId,
} from "@foundry/protocol";
import { listAgentModels } from "../../api";
import type { AgentRuntimeControlsProps } from "../../components/ui/agent-runtime-controls";

type Draft = {
  model?: string;
  effort?: ClaudeEffort | CodexReasoningEffort;
  speed?: CodexSpeed;
};

export function useIssueModels(
  runtime: WorkerRuntimeId,
  agents: AgentProjection[],
  profiles: AgentProfileProjection[],
  workspaceId: string,
) {
  const [agentId, setAgentId] = useState("");
  const agent =
    agents.find(
      (item) =>
        item.id === agentId &&
        item.provider === runtime &&
        item.status === "healthy",
    ) ??
    agents.find(
      (item) => item.provider === runtime && item.status === "healthy",
    );
  // Mirrors the chat picker: when a profile exists as both the machine's
  // configuration and the server definition, the definition is what runs.
  const matchingProfiles = agent?.profileId
    ? profiles.filter(
        (item) =>
          item.id === agent.profileId && item.deviceId === agent.deviceId,
      )
    : [];
  const profile =
    matchingProfiles.find((item) => item.origin === "server") ??
    matchingProfiles[0];
  const key = `${runtime}:${profile?.id ?? "default"}`;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [discovery, setDiscovery] = useState<{
    key: string;
    models: AgentModelOption[];
    loading: boolean;
    failed: boolean;
  }>({ key: "", models: [], loading: false, failed: false });
  const [retry, setRetry] = useState(0);
  const model = drafts[key]?.model ?? profile?.model ?? "";
  const speed = drafts[key]?.speed ?? profile?.codexSpeed ?? "standard";
  const effort =
    drafts[key]?.effort ??
    (runtime === "claude"
      ? profile?.claudeEffort
      : profile?.codexReasoningEffort) ??
    "high";
  // Only stable request inputs are dependencies; live status updates do not reload models.
  const request =
    agent && profile
      ? JSON.stringify({
          id: profile.id,
          workspaceId,
          deviceId: agent.deviceId,
          runtime: profile.runtime,
          label: profile.label,
          configScope: profile.configScope,
          connectionType: profile.connectionType,
          model: profile.model,
          baseUrl: profile.baseUrl,
        })
      : "";
  useEffect(() => {
    let current = true;
    setDiscovery({ key, models: [], loading: Boolean(request), failed: false });
    if (request)
      void listAgentModels(JSON.parse(request)).then(
        (models) => {
          if (current)
            setDiscovery({ key, models, loading: false, failed: false });
        },
        () => {
          if (current)
            setDiscovery({ key, models: [], loading: false, failed: true });
        },
      );
    return () => {
      current = false;
    };
  }, [key, request, retry]);
  const discoveredModels = discovery.key === key ? discovery.models : [];
  // The profile's configured models stay selectable even when the native
  // directory refresh fails; discovery only augments the curated list.
  const options: Array<{ value: string; label: string }> = [
    { value: "", label: "Provider default" },
  ];
  const seenValues = new Set([""]);
  for (const configured of profile?.models ?? []) {
    const value = configured.trim();
    if (value && !seenValues.has(value)) {
      seenValues.add(value);
      options.push({ value, label: value });
    }
  }
  for (const item of discoveredModels) {
    if (!seenValues.has(item.id)) {
      seenValues.add(item.id);
      options.push({ value: item.id, label: item.label ?? item.id });
    }
  }
  if (model && !seenValues.has(model))
    options.push({ value: model, label: model });
  const setModel = (value: string) =>
    setDrafts((values) => ({
      ...values,
      [key]: { ...values[key], model: value },
    }));
  const setEffort = (value: ClaudeEffort | CodexReasoningEffort | "") =>
    setDrafts((values) => ({
      ...values,
      [key]: { ...values[key], effort: value || undefined },
    }));
  const controls: AgentRuntimeControlsProps = {
    selectedRuntime: runtime === "codex" ? "codex" : "claude",
    modelValue: model,
    modelOptions: options.map((option) => ({
      id: option.value,
      label: option.label,
    })),
    modelLoading: discovery.key === key && discovery.loading,
    modelLoadFailed: discovery.key === key && discovery.failed,
    claudeEffort: runtime === "claude" ? (effort as ClaudeEffort) : "",
    codexReasoningEffort:
      runtime === "codex" ? (effort as CodexReasoningEffort) : "",
    codexSpeed: speed,
    claudePermissionMode: "bypassPermissions",
    codexApprovalPolicy: "never",
    codexSandboxMode: "danger-full-access",
    onModelChange: setModel,
    onClaudeEffortChange: setEffort,
    onCodexReasoningEffortChange: setEffort,
    onCodexSpeedChange: (value) =>
      setDrafts((values) => ({
        ...values,
        [key]: { ...values[key], speed: value },
      })),
    onResetControls: () => {
      setDrafts((values) => {
        const next = { ...values };
        delete next[key];
        return next;
      });
      setRetry((value) => value + 1);
    },
    onRetryModels: () => setRetry((value) => value + 1),
    onClaudePermissionModeChange: () => {},
    onCodexApprovalPolicyChange: () => {},
    onCodexSandboxModeChange: () => {},
  };
  return {
    controls,
    agent,
    selectAgent: setAgentId,
    speed,
    model,
    effort,
    profileId: profile?.id,
  };
}
