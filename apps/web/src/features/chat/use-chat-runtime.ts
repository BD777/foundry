import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentModelOption,
  AgentProfileProjection,
  AgentProjection,
  ChatThread,
} from "@foundry/protocol";
import { listAgentModels } from "../../api";
import type { CreateAgentProfileInput } from "../../api-types";
import { mergeModelOptionLists } from "./model-options";
import {
  buildPickerAgentOptions,
  modelControlProfile,
  promotedLegacyAgentIds,
} from "../../lib/agent-picker";
import {
  chatMatchesAgentProfile,
  latestThreadSession,
  type ChatOverrideDraft,
  type ChatSessionThread,
} from "./chat-model";
import type { ChatAgentOption } from "./chat-surface-types";

export interface UseChatRuntimeInput {
  active: boolean;
  agents: AgentProjection[];
  onNotice: (message: string) => Promise<void> | void;
  profiles: AgentProfileProjection[];
  selectedChat?: ChatThread;
  selectedChatId: string;
  selectedThread?: ChatSessionThread;
  workspaceId: string;
}

/** Owns agent selection, model discovery, and per-agent runtime overrides. */
export function useChatRuntime({
  active,
  agents,
  onNotice,
  profiles,
  selectedChat,
  selectedChatId,
  selectedThread,
  workspaceId,
}: UseChatRuntimeInput) {
  const [modelLoadFailed, setModelLoadFailed] = useState<
    Record<string, boolean>
  >({});
  const [modelLoading, setModelLoading] = useState<Record<string, boolean>>({});
  const [modelOptions, setModelOptions] = useState<
    Record<string, AgentModelOption[]>
  >({});
  const [overrides, setOverrides] = useState<Record<string, ChatOverrideDraft>>(
    {},
  );
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const autoSelectedAgentRef = useRef("");
  const previousWorkspaceIdRef = useRef(workspaceId);

  const promotedLegacyIds = useMemo(
    () => promotedLegacyAgentIds(agents, profiles),
    [agents, profiles],
  );

  const agentOptions = useMemo<ChatAgentOption[]>(
    () =>
      // A promoted pair renders once; the representative id is the legacy
      // one while this chat actually runs it, otherwise the server one.
      // The option value follows the real selection, so send identity and
      // check mark never disagree.
      buildPickerAgentOptions(agents, profiles, selectedAgentId),
    [agents, profiles, selectedAgentId],
  );
  // Default auto-selection only runs for a fresh chat and must skip legacy
  // aliases that have a server representative. A historical selection is
  // resolved by id below and is never substituted, so it can still land on
  // the legacy device agent.
  const selectableAgents = useMemo(
    () => agents.filter((agent) => !promotedLegacyIds.has(agent.id)),
    [agents, promotedLegacyIds],
  );
  const selectedAgent = selectedAgentId
    ? agents.find((agent) => agent.id === selectedAgentId)
    : (selectableAgents.find(
        (agent) =>
          agent.provider === "codex" &&
          agent.status === "healthy" &&
          (agent.connectionType === "local_login" ||
            agent.profileId?.includes("local")),
      ) ??
      selectableAgents.find(
        (agent) => agent.provider === "codex" && agent.status === "healthy",
      ) ??
      selectableAgents.find((agent) => agent.status === "healthy") ??
      selectableAgents[0]);
  // Execution keeps the selected agent's own identity, but a promoted legacy
  // agent's dead device config cannot answer the model metadata call (its
  // credential moved to the sealed server profile), so the controls follow
  // its promotedProfileId pointer to the server definition.
  const selectedProfile = modelControlProfile(profiles, selectedAgent);
  const selectedProfileKey = selectedProfile
    ? `${selectedProfile.deviceId}:${selectedProfile.id}`
    : "";
  const selectedOverride = selectedAgent?.id
    ? (overrides[selectedAgent.id] ?? {})
    : {};
  // The profile's own list is authoritative and always available; native
  // discovery only adds to it, so a Claude or compatible endpoint still offers
  // every model the profile was configured with.
  const selectedModelOptions = mergeModelOptionLists(
    selectedProfile?.models ?? [],
    selectedProfileKey ? (modelOptions[selectedProfileKey] ?? []) : [],
  );
  const profileModelValue =
    selectedProfile?.model || selectedModelOptions[0]?.id || "";
  const modelValue = selectedOverride.model ?? profileModelValue;
  const claudeEffort =
    selectedOverride.claudeEffort ?? selectedProfile?.claudeEffort ?? "high";
  const claudePermissionCandidate =
    selectedOverride.claudePermissionMode ??
    selectedProfile?.claudePermissionMode ??
    "acceptEdits";
  const claudePermissionMode =
    claudePermissionCandidate === "default"
      ? "acceptEdits"
      : claudePermissionCandidate;
  const codexReasoningEffort =
    selectedOverride.codexReasoningEffort ??
    selectedProfile?.codexReasoningEffort ??
    "high";
  const codexSandboxMode =
    selectedOverride.codexSandboxMode ??
    selectedProfile?.codexSandboxMode ??
    "workspace-write";
  const codexApprovalPolicy =
    selectedOverride.codexApprovalPolicy ??
    selectedProfile?.codexApprovalPolicy ??
    "never";
  const codexSpeed =
    selectedOverride.codexSpeed ?? selectedProfile?.codexSpeed ?? "standard";

  const updateOverride = useCallback(
    (patch: ChatOverrideDraft): void => {
      if (!selectedAgent?.id) {
        return;
      }
      setOverrides((current) => ({
        ...current,
        [selectedAgent.id]: {
          ...(current[selectedAgent.id] ?? {}),
          ...patch,
        },
      }));
    },
    [selectedAgent?.id],
  );
  const resetOverride = useCallback((): void => {
    if (!selectedAgent?.id) {
      return;
    }
    setOverrides((current) => {
      if (!current[selectedAgent.id]) {
        return current;
      }
      const next = { ...current };
      delete next[selectedAgent.id];
      return next;
    });
  }, [selectedAgent?.id]);

  const loadModels = useCallback(
    async (input: CreateAgentProfileInput, quiet = false) => {
      if (!input.id || !input.deviceId) {
        return [];
      }
      const profileId = `${input.deviceId}:${input.id}`;
      try {
        setModelLoading((current) => ({ ...current, [profileId]: true }));
        setModelLoadFailed((current) => ({
          ...current,
          [profileId]: false,
        }));
        const models = await listAgentModels(input);
        setModelOptions((current) => ({ ...current, [profileId]: models }));
        if (!quiet) {
          await onNotice(`${models.length} models loaded from ${input.label}.`);
        }
        return models;
      } catch {
        setModelLoadFailed((current) => ({
          ...current,
          [profileId]: true,
        }));
        if (!quiet) {
          await onNotice("Could not load models from this provider.");
        }
        return [];
      } finally {
        setModelLoading((current) => ({ ...current, [profileId]: false }));
      }
    },
    [onNotice],
  );

  useEffect(() => {
    if (previousWorkspaceIdRef.current === workspaceId) {
      return;
    }
    previousWorkspaceIdRef.current = workspaceId;
    setOverrides({});
    setSelectedAgentId("");
    autoSelectedAgentRef.current = "";
  }, [workspaceId]);

  useEffect(() => {
    if (selectedAgent?.id && selectedAgent.id !== selectedAgentId) {
      setSelectedAgentId(selectedAgent.id);
    }
  }, [selectedAgent?.id, selectedAgentId]);

  useEffect(() => {
    if (!active || autoSelectedAgentRef.current === selectedChatId) {
      return;
    }
    const latest = selectedThread
      ? latestThreadSession(selectedThread)
      : undefined;
    const targetAgentId = latest
      ? latest.agentId
      : selectedChat
        ? (agents.find((agent) =>
            selectedChat.profileId
              ? agent.profileId === selectedChat.profileId &&
                agent.provider === selectedChat.provider
              : chatMatchesAgentProfile(selectedChat, agent),
          )?.id ?? `unavailable:${selectedChat.id}`)
        : undefined;
    if (targetAgentId && targetAgentId !== selectedAgentId) {
      setSelectedAgentId(targetAgentId);
    }
    if (targetAgentId) {
      autoSelectedAgentRef.current = selectedChatId;
    }
  }, [
    active,
    agents,
    selectedAgentId,
    selectedChat,
    selectedChatId,
    selectedThread,
  ]);

  const selectedProfileModelInput =
    selectedProfile && selectedProfile.id && selectedProfile.deviceId
      ? {
          baseUrl: selectedProfile.baseUrl,
          configScope: selectedProfile.configScope,
          connectionType: selectedProfile.connectionType,
          deviceId: selectedProfile.deviceId,
          id: selectedProfile.id,
          label: selectedProfile.label,
          model: selectedProfile.model,
          promptPrefix: selectedProfile.promptPrefix,
          runtime: selectedProfile.runtime,
        }
      : undefined;

  const retryModels = useCallback((): void => {
    if (!selectedProfileModelInput) {
      return;
    }
    // The configured models never disappear; this only re-runs the native
    // metadata discovery that augments them, so a failed directory refresh is
    // recoverable without reloading the app.
    void loadModels(selectedProfileModelInput, true);
  }, [loadModels, selectedProfileModelInput]);

  useEffect(() => {
    if (
      !active ||
      !selectedProfileModelInput ||
      modelOptions[selectedProfileKey] ||
      modelLoading[selectedProfileKey] ||
      modelLoadFailed[selectedProfileKey] ||
      (!selectedProfileModelInput.baseUrl &&
        selectedProfileModelInput.connectionType !== "local_login")
    ) {
      return;
    }
    void loadModels(selectedProfileModelInput, true);
  }, [
    active,
    loadModels,
    modelLoadFailed,
    modelLoading,
    modelOptions,
    selectedProfileKey,
    selectedProfileModelInput,
  ]);

  return {
    agentOptions,
    claudeEffort,
    claudePermissionMode,
    codexApprovalPolicy,
    codexReasoningEffort,
    codexSandboxMode,
    codexSpeed,
    modelLoadFailed: selectedProfileKey
      ? Boolean(modelLoadFailed[selectedProfileKey])
      : false,
    modelLoading: selectedProfileKey
      ? Boolean(modelLoading[selectedProfileKey])
      : false,
    modelOptions: selectedModelOptions,
    modelValue,
    resetOverride,
    retryModels,
    selectedAgent,
    selectAgent: setSelectedAgentId,
    updateOverride,
  };
}
