import type {
  AgentSession,
  PersonalAgent,
  PersonalAgentActionRecord,
  PersonalAgentListItem,
  PersonalAgentListItemInput,
  PersonalAgentInboxEntry,
  PersonalAgentInboxCapture,
  PersonalAgentInboxAction,
  PersonalAgentMemoryInput,
  PersonalAgentMemoryItem,
  PersonalAgentOverview,
  PersonalAgentProposal,
  PersonalAgentSettings,
  PersonalAgentSetupInput,
  PersonalAgentTask,
} from "@bd777/foundry-protocol";
import { ApiError, request } from "./http";

// The Personal Agent ("assistant", docs/personal-agent.md §10–§11). Every
// call here is the signed-in person's own: the server refuses session tokens
// and device credentials on these routes.

const base = "/api/personal-agent";
const id = (value: string) => encodeURIComponent(value);

/** The server offers no assistant (one older than it): its routes are absent. */
export function isPersonalAgentUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

export function getPersonalAgent(): Promise<PersonalAgentOverview> {
  return request("GET", base);
}

export function capturePersonalAgentInbox(
  input: PersonalAgentInboxCapture,
): Promise<PersonalAgentInboxEntry> {
  return request("POST", `${base}/inbox`, { body: input });
}

export function listPersonalAgentInbox(): Promise<PersonalAgentInboxEntry[]> {
  return request("GET", `${base}/inbox`);
}

export function actOnPersonalAgentInbox(
  inboxId: string,
  input: PersonalAgentInboxAction,
): Promise<PersonalAgentInboxEntry> {
  return request("POST", `${base}/inbox/${id(inboxId)}/action`, {
    body: input,
  });
}

/** The one-tap setup: makes the assistant's home on this computer. */
export function setupPersonalAgent(
  input: PersonalAgentSetupInput,
): Promise<PersonalAgent> {
  return request("POST", base, { body: input });
}

/** Moves the assistant's home to another of the person's computers. */
export function movePersonalAgentHome(
  input: PersonalAgentSetupInput,
): Promise<PersonalAgent> {
  return request("POST", `${base}/home`, { body: input });
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
  timezone: string,
): Promise<PersonalAgent> {
  return request("POST", `${base}/timezone`, { body: { timezone } });
}

export function updatePersonalAgentSettings(
  settings: PersonalAgentSettings,
): Promise<PersonalAgent> {
  return request("PUT", `${base}/settings`, { body: settings });
}

/** The stop switch: cancels everything the assistant runs (§8). */
export function stopPersonalAgent(): Promise<PersonalAgentSwitch> {
  return request("POST", `${base}/stop`);
}

export function resumePersonalAgent(): Promise<PersonalAgentSwitch> {
  return request("POST", `${base}/resume`);
}

/** The sessions of the assistant's own project, without their transcripts. */
export function listPersonalAgentSessions(
  workspaceId: string,
): Promise<AgentSession[]> {
  const params = new URLSearchParams({ workspaceId });
  return request("GET", `/api/agent-sessions?${params.toString()}`);
}

export function listPersonalAgentProposals(): Promise<PersonalAgentProposal[]> {
  return request("GET", `${base}/proposals`);
}

export function acceptPersonalAgentProposal(
  proposalId: string,
): Promise<PersonalAgentProposal> {
  return request("POST", `${base}/proposals/${id(proposalId)}/accept`);
}

export function declinePersonalAgentProposal(
  proposalId: string,
): Promise<PersonalAgentProposal> {
  return request("POST", `${base}/proposals/${id(proposalId)}/decline`);
}

export function listPersonalAgentTasks(): Promise<PersonalAgentTask[]> {
  return request("GET", `${base}/tasks`);
}

/** Stops one piece of work the assistant handed off. */
export function stopPersonalAgentTask(taskId: string): Promise<void> {
  return request("POST", `${base}/tasks/${id(taskId)}/stop`);
}

/**
 * The person's list: every open item, and those closed at or after
 * `closedSince` (RFC 3339; none without it). Oldest first.
 */
export function listPersonalAgentList(
  closedSince?: string,
): Promise<PersonalAgentListItem[]> {
  const query = closedSince
    ? `?${new URLSearchParams({ closedSince }).toString()}`
    : "";
  return request("GET", `${base}/list${query}`);
}

/** The person's edit; changing `when` clears its time and reminder. */
export function updatePersonalAgentListItem(
  itemId: string,
  input: PersonalAgentListItemInput,
): Promise<PersonalAgentListItem> {
  return request("PUT", `${base}/list/${id(itemId)}`, { body: input });
}

export function deletePersonalAgentListItem(itemId: string): Promise<void> {
  return request("DELETE", `${base}/list/${id(itemId)}`);
}

export function listPersonalAgentMemory(): Promise<PersonalAgentMemoryItem[]> {
  return request("GET", `${base}/memory`);
}

export function addPersonalAgentMemory(
  content: string,
): Promise<PersonalAgentMemoryItem> {
  const body: PersonalAgentMemoryInput = { content };
  return request("POST", `${base}/memory`, { body });
}

export function updatePersonalAgentMemory(
  itemId: string,
  content: string,
): Promise<PersonalAgentMemoryItem> {
  const body: PersonalAgentMemoryInput = { content };
  return request("PUT", `${base}/memory/${id(itemId)}`, { body });
}

/** Confirms a guessed or suggested item: it becomes the person's own. */
export function confirmPersonalAgentMemory(
  itemId: string,
): Promise<PersonalAgentMemoryItem> {
  return request("POST", `${base}/memory/${id(itemId)}/confirm`);
}

/** Forgets one item for good: its content is erased. */
export function forgetPersonalAgentMemory(itemId: string): Promise<void> {
  return request("DELETE", `${base}/memory/${id(itemId)}`);
}

export function forgetAllPersonalAgentMemory(): Promise<{
  forgotten: number;
}> {
  return request("DELETE", `${base}/memory`);
}

/** The audit trail (§5): newest first, the last 90 days. */
export function listPersonalAgentActions(): Promise<
  PersonalAgentActionRecord[]
> {
  return request("GET", `${base}/actions`);
}

export function listPersonalAgentRunSnapshots(): Promise<
  import("@bd777/foundry-protocol").PersonalAgentRunSnapshot[]
> {
  return request("GET", `${base}/runs`);
}
export function listPersonalAgentRunControls(): Promise<
  import("@bd777/foundry-protocol").PersonalAgentRunControl[]
> {
  return request("GET", `${base}/run-controls`);
}
export function stopPersonalAgentRun(
  control: string,
): Promise<import("@bd777/foundry-protocol").PersonalAgentRunControl> {
  return request("POST", `${base}/run-controls/${id(control)}/stop`, {
    body: {},
  });
}

export function listPersonalAgentOperations(): Promise<
  import("@bd777/foundry-protocol").PersonalAgentOperation[]
> {
  return request("GET", `${base}/operations`);
}

export function cancelPendingPersonalAgentOperation(
  idValue: string,
  revision: number,
): Promise<import("@bd777/foundry-protocol").PersonalAgentOperation> {
  return request("POST", `${base}/operations/${id(idValue)}/cancel-pending`, {
    body: { revision },
  });
}
