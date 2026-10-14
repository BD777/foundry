import type {
  AgentSession,
  PersonalAgent,
  PersonalAgentActionRecord,
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
