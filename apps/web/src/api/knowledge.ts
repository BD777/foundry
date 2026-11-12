import type {
  KnowledgeVault,
  KnowledgeEntry,
  KnowledgeMutation,
  KnowledgeDocument,
  KnowledgePublication,
} from "@bd777/foundry-protocol";
import { request } from "./http";
import { personalAgentApiBase } from "./personal-agent";

const base = (assistantId?: string) =>
  `${personalAgentApiBase(assistantId)}/knowledge`;
const vault = (assistantId: string | undefined, id: string) =>
  `${base(assistantId)}/vaults/${encodeURIComponent(id)}`;
export function listKnowledgeVaults(
  assistantId?: string,
): Promise<KnowledgeVault[]> {
  return request("GET", `${base(assistantId)}/vaults`);
}
export function createKnowledgeVault(
  assistantId: string | undefined,
  input: {
    kind: "memory" | "domain";
    workspaceId: string;
    deviceId: string;
    rootPath: string;
    createNew?: boolean;
  },
): Promise<KnowledgeVault> {
  return request("POST", `${base(assistantId)}/vaults`, { body: input });
}
export function listKnowledgeEntries(
  assistantId: string | undefined,
  id: string,
): Promise<KnowledgeEntry[]> {
  return request("GET", `${vault(assistantId, id)}/entries`);
}
export function readKnowledgeEntry(
  assistantId: string | undefined,
  id: string,
  entry: string,
): Promise<KnowledgeDocument> {
  return request(
    "GET",
    `${vault(assistantId, id)}/entries/${encodeURIComponent(entry)}`,
  );
}
export function writeKnowledgeEntry(
  assistantId: string | undefined,
  id: string,
  input: {
    requestId: string;
    entryId?: string;
    action: "write" | "adopt" | "forget";
    title?: string;
    body?: string;
    expectedRevision: number;
    expectedHash?: string;
    expectedRawHash?: string;
    sourceRef?: string;
    sourceVersion?: string;
    expiresAt?: string;
  },
): Promise<KnowledgeMutation> {
  return request("POST", `${vault(assistantId, id)}/entries`, { body: input });
}
export function listKnowledgePublications(
  assistantId?: string,
): Promise<KnowledgePublication[]> {
  return request("GET", `${base(assistantId)}/publications`);
}
export function publishKnowledge(
  assistantId: string | undefined,
  input: {
    sourceEpoch: number;
    sourceRevision: number;
    sourceHash: string;
    requestId: string;
    vaultId: string;
    entryId: string;
    targetWorkspaceId: string;
    profileId: string;
    purpose: string;
    expiresAt?: string;
  },
): Promise<KnowledgePublication> {
  return request("POST", `${base(assistantId)}/publications`, { body: input });
}
export function revokeKnowledgePublication(
  assistantId: string | undefined,
  id: string,
  revision: number,
): Promise<KnowledgePublication> {
  return request(
    "POST",
    `${base(assistantId)}/publications/${encodeURIComponent(id)}/revoke`,
    { body: { revision } },
  );
}

export function listKnowledgeMutations(
  assistantId?: string,
): Promise<KnowledgeMutation[]> {
  return request("GET", `${base(assistantId)}/mutations`);
}

export function previewAssistantMemoryAccount(
  assistantId?: string,
): Promise<import("@bd777/foundry-protocol").PersonalAgentRunSnapshot> {
  return request("POST", `${personalAgentApiBase(assistantId)}/run-preview`, {
    body: { role: "coordinator" },
  });
}
export function allowAssistantMemory(
  assistantId: string | undefined,
  id: string,
  requestId: string,
  configHash: string,
): Promise<KnowledgePublication> {
  return request("POST", `${vault(assistantId, id)}/assistant-access`, {
    body: { requestId, configHash },
  });
}

export function listKnowledgeMigrations(
  assistantId?: string,
): Promise<import("@bd777/foundry-protocol").KnowledgeMigration[]> {
  return request("GET", `${base(assistantId)}/migrations`);
}
export function beginKnowledgeMigration(
  assistantId: string | undefined,
  id: string,
  input: {
    requestId: string;
    revision: number;
    deviceId: string;
    workspaceId: string;
    rootPath: string;
  },
): Promise<import("@bd777/foundry-protocol").KnowledgeMigration> {
  return request("POST", `${vault(assistantId, id)}/migrate`, { body: input });
}
export function cancelKnowledgeMigration(
  assistantId: string | undefined,
  id: string,
  revision: number,
): Promise<import("@bd777/foundry-protocol").KnowledgeMigration> {
  return request(
    "POST",
    `${base(assistantId)}/migrations/${encodeURIComponent(id)}/cancel`,
    { body: { revision } },
  );
}
export function listKnowledgeReplicaCleanup(
  assistantId?: string,
): Promise<import("@bd777/foundry-protocol").KnowledgeReplicaForget[]> {
  return request("GET", `${base(assistantId)}/replica-cleanup`);
}

export function inspectKnowledgeSource(
  assistantId: string | undefined,
  id: string,
  entry: string,
): Promise<import("@bd777/foundry-protocol").KnowledgeSourceReview> {
  return request(
    "GET",
    `${vault(assistantId, id)}/entries/${encodeURIComponent(entry)}/source-review`,
  );
}

export async function transferLegacyKnowledge(
  assistantId: string | undefined,
  item: import("@bd777/foundry-protocol").PersonalAgentMemoryItem,
): Promise<KnowledgeMutation> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(item.content),
    ),
  );
  const bodyHash = Array.from(bytes, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/memory/${encodeURIComponent(item.id)}/transfer`,
    { body: { updatedAt: item.updatedAt, bodyHash, confirmed: true } },
  );
}

export function repairKnowledgeIndex(
  assistantId: string | undefined,
  id: string,
  epoch: number,
): Promise<KnowledgeEntry[]> {
  return request("POST", `${vault(assistantId, id)}/repair-index`, {
    body: { epoch, confirmed: true },
  });
}

export function resetPendingKnowledgeLocation(
  assistantId: string | undefined,
  id: string,
  input: {
    revision: number;
    deviceId: string;
    workspaceId: string;
    rootPath: string;
  },
): Promise<KnowledgeVault> {
  return request("POST", `${vault(assistantId, id)}/initial-location`, {
    body: { ...input, confirmed: true },
  });
}
