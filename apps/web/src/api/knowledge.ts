import type {
  KnowledgeVault,
  KnowledgeEntry,
  KnowledgeMutation,
  KnowledgeDocument,
  KnowledgePublication,
} from "@bd777/foundry-protocol";
import { request } from "./http";
const base = "/api/personal-agent/knowledge";
const vault = (id: string) => `${base}/vaults/${encodeURIComponent(id)}`;
export function listKnowledgeVaults(): Promise<KnowledgeVault[]> {
  return request("GET", `${base}/vaults`);
}
export function createKnowledgeVault(input: {
  kind: "memory" | "domain";
  workspaceId: string;
  deviceId: string;
  rootPath: string;
  createNew?: boolean;
}): Promise<KnowledgeVault> {
  return request("POST", `${base}/vaults`, { body: input });
}
export function listKnowledgeEntries(id: string): Promise<KnowledgeEntry[]> {
  return request("GET", `${vault(id)}/entries`);
}
export function readKnowledgeEntry(
  id: string,
  entry: string,
): Promise<KnowledgeDocument> {
  return request("GET", `${vault(id)}/entries/${encodeURIComponent(entry)}`);
}
export function writeKnowledgeEntry(
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
  return request("POST", `${vault(id)}/entries`, { body: input });
}
export function listKnowledgePublications(): Promise<KnowledgePublication[]> {
  return request("GET", `${base}/publications`);
}
export function publishKnowledge(input: {
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
}): Promise<KnowledgePublication> {
  return request("POST", `${base}/publications`, { body: input });
}
export function revokeKnowledgePublication(
  id: string,
  revision: number,
): Promise<KnowledgePublication> {
  return request(
    "POST",
    `${base}/publications/${encodeURIComponent(id)}/revoke`,
    { body: { revision } },
  );
}

export function listKnowledgeMutations(): Promise<KnowledgeMutation[]> {
  return request("GET", `${base}/mutations`);
}

export function previewAssistantMemoryAccount(): Promise<
  import("@bd777/foundry-protocol").PersonalAgentRunSnapshot
> {
  return request("POST", "/api/personal-agent/run-preview", {
    body: { role: "coordinator" },
  });
}
export function allowAssistantMemory(
  id: string,
  requestId: string,
  configHash: string,
): Promise<KnowledgePublication> {
  return request("POST", `${vault(id)}/assistant-access`, {
    body: { requestId, configHash },
  });
}

export function listKnowledgeMigrations(): Promise<
  import("@bd777/foundry-protocol").KnowledgeMigration[]
> {
  return request("GET", `${base}/migrations`);
}
export function beginKnowledgeMigration(
  id: string,
  input: {
    requestId: string;
    revision: number;
    deviceId: string;
    workspaceId: string;
    rootPath: string;
  },
): Promise<import("@bd777/foundry-protocol").KnowledgeMigration> {
  return request("POST", `${vault(id)}/migrate`, { body: input });
}
export function cancelKnowledgeMigration(
  id: string,
  revision: number,
): Promise<import("@bd777/foundry-protocol").KnowledgeMigration> {
  return request(
    "POST",
    `${base}/migrations/${encodeURIComponent(id)}/cancel`,
    { body: { revision } },
  );
}
export function listKnowledgeReplicaCleanup(): Promise<
  import("@bd777/foundry-protocol").KnowledgeReplicaForget[]
> {
  return request("GET", `${base}/replica-cleanup`);
}

export function inspectKnowledgeSource(
  id: string,
  entry: string,
): Promise<import("@bd777/foundry-protocol").KnowledgeSourceReview> {
  return request(
    "GET",
    `${vault(id)}/entries/${encodeURIComponent(entry)}/source-review`,
  );
}

export async function transferLegacyKnowledge(
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
    `/api/personal-agent/memory/${encodeURIComponent(item.id)}/transfer`,
    { body: { updatedAt: item.updatedAt, bodyHash, confirmed: true } },
  );
}

export function repairKnowledgeIndex(
  id: string,
  epoch: number,
): Promise<KnowledgeEntry[]> {
  return request("POST", `${vault(id)}/repair-index`, {
    body: { epoch, confirmed: true },
  });
}

export function resetPendingKnowledgeLocation(
  id: string,
  input: {
    revision: number;
    deviceId: string;
    workspaceId: string;
    rootPath: string;
  },
): Promise<KnowledgeVault> {
  return request("POST", `${vault(id)}/initial-location`, {
    body: { ...input, confirmed: true },
  });
}
