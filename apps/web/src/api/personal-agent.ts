import type {
  AddMemoryEntryInput,
  AgentSession,
  AssistantList,
  AssistantMemoryLayers,
  ConnectorAccountPermission,
  ConnectorAccessLevel,
  CreateAssistantInput,
  KnowledgeMutation,
  MemoryEntryMove,
  MemoryLayerScope,
  MoveMemoryEntryInput,
  PermissionPackage,
  PersonalAgent,
  PersonalAgentActionRecord,
  PersonalAgentConnector,
  PersonalAgentConnectorsView,
  PersonalAgentListItem,
  PersonalAgentListItemInput,
  PersonalAgentInboxEntry,
  PersonalAgentInboxCapture,
  PersonalAgentInboxAction,
  PersonalAgentOverview,
  PersonalAgentProposal,
  PersonalAgentSettings,
  PersonalAgentSetupInput,
  PersonalAgentTask,
  UpdateAssistantInput,
} from "@bd777/foundry-protocol";
import { request } from "./http";

// The Personal Agent ("assistant", docs/personal-agent.md §10–§11). Every
// call here is the signed-in person's own: the server refuses session tokens
// and device credentials on these routes.

const defaultBase = "/api/personal-agent";
const id = (value: string) => encodeURIComponent(value);

/**
 * One assistant's routes. The default alias remains only as the bootstrap
 * fallback when no assistant id is known yet.
 */
export function personalAgentApiBase(assistantId?: string): string {
  return assistantId ? `/api/assistants/${id(assistantId)}` : defaultBase;
}

export type {
  ConnectorAccountPermission,
  ConnectorAccessLevel,
  PersonalAgentConnector,
  PersonalAgentConnectorsView,
};

/** The person's assistants, including which Feishu app each one reserves. */
export function listAssistants(): Promise<AssistantList> {
  return request("GET", "/api/assistants");
}

export function createAssistant(
  input: CreateAssistantInput,
): Promise<PersonalAgent> {
  return request("POST", "/api/assistants", { body: input });
}

export function renameAssistant(
  assistantId: string,
  input: UpdateAssistantInput,
): Promise<PersonalAgent> {
  return request("PATCH", personalAgentApiBase(assistantId), { body: input });
}

export function deleteAssistant(assistantId: string): Promise<void> {
  return request("DELETE", personalAgentApiBase(assistantId));
}

export function getAssistantPermissionPackage(
  assistantId?: string,
): Promise<PermissionPackage> {
  return request(
    "GET",
    `${personalAgentApiBase(assistantId)}/permission-package`,
  );
}

export function setAssistantPermissionPackage(
  assistantId: string | undefined,
  permissionPackage: PermissionPackage,
): Promise<PermissionPackage> {
  return request(
    "PUT",
    `${personalAgentApiBase(assistantId)}/permission-package`,
    { body: permissionPackage },
  );
}

export function getPersonalAgent(
  assistantId?: string,
): Promise<PersonalAgentOverview> {
  return request("GET", personalAgentApiBase(assistantId));
}

export function getPersonalAgentConnectors(
  assistantId?: string,
): Promise<PersonalAgentConnectorsView> {
  return request("GET", `${personalAgentApiBase(assistantId)}/connectors`);
}

/** Replaces every connector-account override; omitted accounts become write. */
export function setPersonalAgentConnectors(
  assistantId: string | undefined,
  levels: ConnectorAccountPermission[],
): Promise<PersonalAgentConnectorsView> {
  return request("PUT", `${personalAgentApiBase(assistantId)}/connectors`, {
    body: { levels },
  });
}

export function capturePersonalAgentInbox(
  assistantId: string | undefined,
  input: PersonalAgentInboxCapture,
): Promise<PersonalAgentInboxEntry> {
  return request("POST", `${personalAgentApiBase(assistantId)}/inbox`, {
    body: input,
  });
}

export function listPersonalAgentInbox(
  assistantId?: string,
): Promise<PersonalAgentInboxEntry[]> {
  return request("GET", `${personalAgentApiBase(assistantId)}/inbox`);
}

export function actOnPersonalAgentInbox(
  assistantId: string | undefined,
  inboxId: string,
  input: PersonalAgentInboxAction,
): Promise<PersonalAgentInboxEntry> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/inbox/${id(inboxId)}/action`,
    { body: input },
  );
}

/** The one-tap setup: makes the assistant's home on this computer. */
export function setupPersonalAgent(
  input: PersonalAgentSetupInput,
): Promise<PersonalAgent> {
  return request("POST", defaultBase, { body: input });
}

/** Moves the assistant's home to another of the person's computers. */
export function movePersonalAgentHome(
  assistantId: string | undefined,
  input: PersonalAgentSetupInput,
): Promise<PersonalAgent> {
  return request("POST", `${personalAgentApiBase(assistantId)}/home`, {
    body: input,
  });
}

/**
 * The stop switch's and resuming's answer: the assistant now, and the fixed
 * reply every channel sends (the things stopped, or those to offer again).
 */
export interface PersonalAgentSwitch {
  agent: PersonalAgent;
  stopped?: number;
  tasks?: PersonalAgentTask[];
  reply: string;
}

/**
 * Gives an assistant without a time zone the browser's; one already set
 * stays. Answers the assistant as stored.
 */
export function fillPersonalAgentTimezone(
  assistantId: string | undefined,
  timezone: string,
): Promise<PersonalAgent> {
  return request("POST", `${personalAgentApiBase(assistantId)}/timezone`, {
    body: { timezone },
  });
}

export function updatePersonalAgentSettings(
  assistantId: string | undefined,
  settings: PersonalAgentSettings,
): Promise<PersonalAgent> {
  return request("PUT", `${personalAgentApiBase(assistantId)}/settings`, {
    body: settings,
  });
}

/** The stop switch: cancels everything the assistant runs (§8). */
export function stopPersonalAgent(
  assistantId?: string,
): Promise<PersonalAgentSwitch> {
  return request("POST", `${personalAgentApiBase(assistantId)}/stop`);
}

export function resumePersonalAgent(
  assistantId?: string,
): Promise<PersonalAgentSwitch> {
  return request("POST", `${personalAgentApiBase(assistantId)}/resume`);
}

/** The sessions of the assistant's own project, without their transcripts. */
export function listPersonalAgentSessions(
  workspaceId: string,
): Promise<AgentSession[]> {
  const params = new URLSearchParams({ workspaceId });
  return request("GET", `/api/agent-sessions?${params.toString()}`);
}

export function listPersonalAgentProposals(
  assistantId?: string,
): Promise<PersonalAgentProposal[]> {
  return request("GET", `${personalAgentApiBase(assistantId)}/proposals`);
}

export function acceptPersonalAgentProposal(
  assistantId: string | undefined,
  proposalId: string,
): Promise<PersonalAgentProposal> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/proposals/${id(proposalId)}/accept`,
  );
}

export function declinePersonalAgentProposal(
  assistantId: string | undefined,
  proposalId: string,
): Promise<PersonalAgentProposal> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/proposals/${id(proposalId)}/decline`,
  );
}

export function listPersonalAgentTasks(
  assistantId?: string,
): Promise<PersonalAgentTask[]> {
  return request("GET", `${personalAgentApiBase(assistantId)}/tasks`);
}

/** Stops one piece of work the assistant handed off. */
export function stopPersonalAgentTask(
  assistantId: string | undefined,
  taskId: string,
): Promise<void> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/tasks/${id(taskId)}/stop`,
  );
}

/**
 * The person's list: every open item, and those closed at or after
 * `closedSince` (RFC 3339; none without it). Oldest first.
 */
export function listPersonalAgentList(
  assistantId?: string,
  closedSince?: string,
): Promise<PersonalAgentListItem[]> {
  const query = closedSince
    ? `?${new URLSearchParams({ closedSince }).toString()}`
    : "";
  return request("GET", `${personalAgentApiBase(assistantId)}/list${query}`);
}

/** The person's edit; changing `when` clears its time and reminder. */
export function updatePersonalAgentListItem(
  assistantId: string | undefined,
  itemId: string,
  input: PersonalAgentListItemInput,
): Promise<PersonalAgentListItem> {
  return request(
    "PUT",
    `${personalAgentApiBase(assistantId)}/list/${id(itemId)}`,
    { body: input },
  );
}

export function deletePersonalAgentListItem(
  assistantId: string | undefined,
  itemId: string,
): Promise<void> {
  return request(
    "DELETE",
    `${personalAgentApiBase(assistantId)}/list/${id(itemId)}`,
  );
}

/** The person's shared layer and this assistant's own layer. */
export function listAssistantMemoryLayers(
  assistantId?: string,
): Promise<AssistantMemoryLayers> {
  return request("GET", `${personalAgentApiBase(assistantId)}/memory/layers`);
}

/** Adds a fact to one layer; capture first, then the layer's device writes it. */
export function addAssistantMemoryLayerEntry(
  assistantId: string | undefined,
  scope: MemoryLayerScope,
  input: AddMemoryEntryInput,
): Promise<KnowledgeMutation> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/memory/layers/${id(scope)}/entries`,
    { body: input },
  );
}

/** Moves a fact to the other layer at the revision and hash shown. */
export function moveAssistantMemoryEntry(
  assistantId: string | undefined,
  entryId: string,
  input: MoveMemoryEntryInput,
): Promise<MemoryEntryMove> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/memory/entries/${id(entryId)}/move`,
    { body: input },
  );
}

/** The audit trail (§5): newest first, the last 90 days. */
export function listPersonalAgentActions(
  assistantId?: string,
): Promise<PersonalAgentActionRecord[]> {
  return request("GET", `${personalAgentApiBase(assistantId)}/actions`);
}

export function listPersonalAgentRunSnapshots(
  assistantId?: string,
): Promise<import("@bd777/foundry-protocol").PersonalAgentRunSnapshot[]> {
  return request("GET", `${personalAgentApiBase(assistantId)}/runs`);
}
export function listPersonalAgentRunControls(
  assistantId?: string,
): Promise<import("@bd777/foundry-protocol").PersonalAgentRunControl[]> {
  return request("GET", `${personalAgentApiBase(assistantId)}/run-controls`);
}
export function stopPersonalAgentRun(
  assistantId: string | undefined,
  control: string,
): Promise<import("@bd777/foundry-protocol").PersonalAgentRunControl> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/run-controls/${id(control)}/stop`,
    { body: {} },
  );
}

export function listPersonalAgentOperations(
  assistantId?: string,
): Promise<import("@bd777/foundry-protocol").PersonalAgentOperation[]> {
  return request("GET", `${personalAgentApiBase(assistantId)}/operations`);
}

export function cancelPendingPersonalAgentOperation(
  assistantId: string | undefined,
  idValue: string,
  revision: number,
): Promise<import("@bd777/foundry-protocol").PersonalAgentOperation> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/operations/${id(idValue)}/cancel-pending`,
    { body: { revision } },
  );
}
