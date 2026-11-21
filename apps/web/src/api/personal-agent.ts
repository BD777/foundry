import type {
  AddMemoryEntryInput,
  AssistantFile,
  AssistantFileMove,
  AssistantFileRevert,
  AssistantFileWrite,
  AssistantHomeUnread,
  AssistantInstructionsDefault,
  AssistantWorkspaceList,
  AgentSession,
  AssistantList,
  AssistantMemoryLayers,
  ConnectorAccountPermission,
  ConnectorAccessLevel,
  CreateAssistantInput,
  KnowledgeMutation,
  MemoryEntryMove,
  MemoryLayerScope,
  MemorySortActionInput,
  MemorySortList,
  MemorySortRecord,
  MessageChannelDeliveryList,
  MessageChannelInput,
  MessageChannelList,
  MessageChannelPeers,
  MessageChannelPrerequisites,
  MessageChannelTestInput,
  MessageChannelTestResult,
  MessageChannelView,
  MoveMemoryEntryInput,
  PermissionPackage,
  PersonalAgent,
  PersonalAgentActionRecord,
  PersonalAgentConnector,
  PersonalAgentConnectorsView,
  PersonalAgentNotifyChatResult,
  PersonalAgentNotifyInstancesResult,
  PersonalAgentNotifyTestResult,
  PersonalAgentItem,
  PersonalAgentItemDetail,
  PersonalAgentItemEditInput,
  PersonalAgentItemList,
  PersonalAgentItemOwner,
  PersonalAgentItemReport,
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
import { request, type RequestOptions } from "./http";

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

/** Whether the home conversation holds an answer the person has not seen. */
export function getAssistantHomeUnread(
  assistantId?: string,
): Promise<AssistantHomeUnread> {
  return request("GET", `${personalAgentApiBase(assistantId)}/home-unread`);
}

/** The person is looking at the home conversation: mark its answers seen. */
export function markAssistantHomeSeen(
  assistantId?: string,
): Promise<AssistantHomeUnread> {
  return request("POST", `${personalAgentApiBase(assistantId)}/home-seen`);
}

export function getPersonalAgentConnectors(
  assistantId?: string,
): Promise<PersonalAgentConnectorsView> {
  return request("GET", `${personalAgentApiBase(assistantId)}/connectors`);
}

/** Finds the person's self chat on a connector and fills it in, or checks the chat id typed. */
export function findPersonalAgentNotifyChat(
  assistantId: string | undefined,
  input: { connectorInstanceId: string; chatId?: string },
): Promise<PersonalAgentNotifyChatResult> {
  return request("POST", `${personalAgentApiBase(assistantId)}/notify/chat`, {
    body: input,
  });
}

/** Sends one test notice to the chosen connector and reports the result. */
export function getPersonalAgentNotifyInstances(
  assistantId: string | undefined,
): Promise<PersonalAgentNotifyInstancesResult> {
  return request(
    "GET",
    `${personalAgentApiBase(assistantId)}/notify/instances`,
  );
}

export function sendPersonalAgentTestNotice(
  assistantId: string | undefined,
  connectorInstanceId: string,
): Promise<PersonalAgentNotifyTestResult> {
  return request("POST", `${personalAgentApiBase(assistantId)}/notify/test`, {
    body: { connectorInstanceId },
  });
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

/** What the 「事项」 list asks for: one view, newest updated first, one page at a time. */
export interface PersonalAgentItemsQuery {
  /** open (the default), finished (done or dropped, not archived) or archived. */
  view?: "open" | "finished" | "archived";
  owner?: PersonalAgentItemOwner;
  /** RFC 3339 instants: the range is [from, to) on the time an item last changed. */
  from?: string;
  to?: string;
  /** A workspace id: the items whose home is it or that touch it. */
  workspace?: string;
  /** Case-insensitive search in the item's words and summary. */
  q?: string;
  /** Default 50, at most 200. */
  limit?: number;
  offset?: number;
}

function itemsQuery(query: PersonalAgentItemsQuery): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query))
    if (value !== undefined && value !== "") params.set(name, String(value));
  const search = params.toString();
  return search ? `?${search}` : "";
}

/** One page of the person's items, with helpers and derived state. */
export function listPersonalAgentItems(
  assistantId: string | undefined,
  query: PersonalAgentItemsQuery = {},
): Promise<PersonalAgentItemList> {
  return request(
    "GET",
    `${personalAgentApiBase(assistantId)}/items${itemsQuery(query)}`,
  );
}

/** One item with its append-only timeline. */
export function getPersonalAgentItem(
  assistantId: string | undefined,
  itemId: string,
): Promise<PersonalAgentItemDetail> {
  return request(
    "GET",
    `${personalAgentApiBase(assistantId)}/items/${id(itemId)}`,
  );
}

/**
 * The person's edit; absent fields stay. `archived` moves a closed item to
 * the archive and back (refused while it is open or a helper runs).
 */
export function updatePersonalAgentItem(
  assistantId: string | undefined,
  itemId: string,
  input: PersonalAgentItemEditInput,
): Promise<PersonalAgentItem> {
  return request(
    "PUT",
    `${personalAgentApiBase(assistantId)}/items/${id(itemId)}`,
    { body: input },
  );
}

/** The deterministic review of a range, built from items and their times. */
export function getPersonalAgentItemReport(
  assistantId: string | undefined,
  from: string,
  to: string,
): Promise<PersonalAgentItemReport> {
  const query = new URLSearchParams({ from, to }).toString();
  return request(
    "GET",
    `${personalAgentApiBase(assistantId)}/items/report?${query}`,
  );
}

/** Deletes an item for good, with its timeline; the person's own delete. */
export function deletePersonalAgentItem(
  assistantId: string | undefined,
  itemId: string,
): Promise<void> {
  return request(
    "DELETE",
    `${personalAgentApiBase(assistantId)}/items/${id(itemId)}`,
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

/** Memory upkeep's sorting between layers: recent automatic moves and standing suggestions to share. */
export function listAssistantMemorySorting(
  assistantId?: string,
): Promise<MemorySortList> {
  return request("GET", `${personalAgentApiBase(assistantId)}/memory/sorting`);
}

/** Undoes an automatic move, or confirms or dismisses a suggestion to share. */
export function actOnAssistantMemorySort(
  assistantId: string | undefined,
  recordId: string,
  input: MemorySortActionInput,
): Promise<MemorySortRecord> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/memory/sorting/${id(recordId)}/action`,
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

export type {
  MessageChannelDeliveryList,
  MessageChannelInput,
  MessageChannelList,
  MessageChannelPeers,
  MessageChannelPrerequisites,
  MessageChannelTestInput,
  MessageChannelTestResult,
  MessageChannelView,
};

const channelPath = (assistantId: string | undefined, channelId?: string) =>
  `${personalAgentApiBase(assistantId)}/channels${channelId ? `/${id(channelId)}` : ""}`;

/** The assistant's message channels and the sources one can read (DEV-203). */
export function listMessageChannels(
  assistantId?: string,
): Promise<MessageChannelList> {
  return request("GET", channelPath(assistantId));
}

export function createMessageChannel(
  assistantId: string | undefined,
  input: MessageChannelInput,
): Promise<MessageChannelView> {
  return request("POST", channelPath(assistantId), { body: input });
}

export function updateMessageChannel(
  assistantId: string | undefined,
  channelId: string,
  input: MessageChannelInput,
): Promise<MessageChannelView> {
  return request("PUT", channelPath(assistantId, channelId), { body: input });
}

export function deleteMessageChannel(
  assistantId: string | undefined,
  channelId: string,
): Promise<void> {
  return request("DELETE", channelPath(assistantId, channelId));
}

/**
 * Tries unsaved rules: on made-up samples and, with `recent` and a source,
 * on up to 30 recent messages the person's channels on it saw.
 */
export function testMessageChannelRules(
  assistantId: string | undefined,
  input: MessageChannelTestInput,
): Promise<MessageChannelTestResult> {
  return request("POST", `${channelPath(assistantId)}/test`, { body: input });
}

/** Conversations and senders the person's channels saw recently on a source. */
export function listMessageChannelPeers(
  assistantId: string | undefined,
  accountId: string,
): Promise<MessageChannelPeers> {
  return request(
    "GET",
    `${channelPath(assistantId)}/peers?accountId=${encodeURIComponent(accountId)}`,
  );
}

/** The channel's latest 50 messages, newest first; `dropped` adds filtered-out ones. */
export function listMessageChannelDeliveries(
  assistantId: string | undefined,
  channelId: string,
  dropped = false,
): Promise<MessageChannelDeliveryList> {
  return request(
    "GET",
    `${channelPath(assistantId, channelId)}/deliveries${dropped ? "?dropped=1" : ""}`,
  );
}

/** Delivers the messages a limit held back. */
export function releaseMessageChannel(
  assistantId: string | undefined,
  channelId: string,
): Promise<{ released: number }> {
  return request("POST", `${channelPath(assistantId, channelId)}/release`);
}

/**
 * The person's explicit grant: allows the source connector in the
 * assistant's permission package and binds it to the assistant's home.
 */
export function grantMessageChannelSource(
  assistantId: string | undefined,
  accountId: string,
): Promise<MessageChannelPrerequisites> {
  return request("POST", `${channelPath(assistantId)}/grant-source`, {
    body: { accountId },
  });
}

// The files of the assistant's workspaces (DEV-223). The tree and binary
// previews use the workspace file routes (listWorkspaceTree, downloads).

const filesPath = (assistantId: string | undefined) =>
  `${personalAgentApiBase(assistantId)}/files`;

/** The assistant's home, then each message channel's workspace. */
export function listAssistantWorkspaces(
  assistantId: string | undefined,
): Promise<AssistantWorkspaceList> {
  return request("GET", `${filesPath(assistantId)}/workspaces`);
}

/**
 * One file for the editor, with its saved versions; for the home AGENTS.md
 * the content is the person's instructions, beside Foundry's block.
 */
export function readAssistantFile(
  assistantId: string | undefined,
  workspaceId: string,
  path: string,
  options: RequestOptions = {},
): Promise<AssistantFile> {
  const params = new URLSearchParams({ path, workspaceId });
  return request("GET", `${filesPath(assistantId)}?${params}`, options);
}

/**
 * Saves a text file over the version `baseSha256` names ("" creates one);
 * 409 when it changed on the device since.
 */
export function saveAssistantFile(
  assistantId: string | undefined,
  input: AssistantFileWrite,
): Promise<AssistantFile> {
  return request("PUT", filesPath(assistantId), { body: input });
}

/** Puts a saved version back, as a new version. */
export function revertAssistantFile(
  assistantId: string | undefined,
  input: AssistantFileRevert,
): Promise<AssistantFile> {
  return request("POST", `${filesPath(assistantId)}/revert`, { body: input });
}

/** Renames a file (`toPath`) or deletes it (no `toPath`). */
export function moveAssistantFile(
  assistantId: string | undefined,
  input: AssistantFileMove,
): Promise<{ op: string; path: string; toPath: string }> {
  return request("POST", `${filesPath(assistantId)}/move`, { body: input });
}

/** Takes Foundry's newer default instructions, or keeps the person's. */
export function answerAssistantInstructionsDefault(
  assistantId: string | undefined,
  input: AssistantInstructionsDefault,
): Promise<AssistantFile> {
  return request("POST", `${filesPath(assistantId)}/instructions-default`, {
    body: input,
  });
}

/** The conversation's next message starts a new session. */
export function startMessageChannelNewSession(
  assistantId: string | undefined,
  channelId: string,
  sessionKey: string,
): Promise<{ sessionKey: string; next: string }> {
  return request("POST", `${channelPath(assistantId, channelId)}/new-session`, {
    body: { sessionKey },
  });
}
