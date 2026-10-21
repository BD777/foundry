/** Location and control metadata; knowledge bodies remain in their owner files. */
export interface KnowledgeVault {
  id: string;
  kind: string;
  workspaceId: string;
  deviceId: string;
  rootPath: string;
  epoch: number;
  revision: number;
  state: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntry {
  id: string;
  vaultId: string;
  epoch: number;
  revision: number;
  hash: string;
  title: string;
  sourceRef: string;
  sourceVersion?: string;
  expiresAt?: string;
  state: string;
  updatedAt: string;
}

export interface KnowledgeMutation {
  resultHash?: string;
  resultRevision?: number;
  id: string;
  vaultId: string;
  entryId: string;
  epoch: number;
  action: string;
  expectedRevision: number;
  expectedHash: string;
  expectedRawHash?: string;
  title: string;
  sourceRef: string;
  sourceVersion?: string;
  expiresAt?: string;
  status: string;
  reason?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgePublication {
  /** Derived current policy check; source and actor are rechecked on every read. */
  needsReview?: boolean;
  scope: string;
  id: string;
  vaultId: string;
  entryId: string;
  sourceEpoch: number;
  sourceRevision: number;
  sourceHash: string;
  targetWorkspaceId: string;
  profileId: string;
  profileFingerprint: string;
  providerConfigHash?: string;
  audienceHash: string;
  purpose: string;
  expiresAt?: string;
  state: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeMigration {
  id: string;
  vaultId: string;
  source: KnowledgeVault;
  target: KnowledgeVault;
  revision: number;
  state: string;
  reason?: string;
  cancelRequested: boolean;
  cursor: number;
  manifest?: import("./knowledge.js").KnowledgeDocument[];
  sourceControlRevision: number;
  targetControlRevision: number;
  createdAt: string;
  updatedAt: string;
}
export interface KnowledgeReplica {
  id: string;
  vaultId: string;
  location: KnowledgeVault;
  createdAt: string;
}
export interface KnowledgeReplicaForget {
  id: string;
  replicaId: string;
  vaultId: string;
  entryId: string;
  state: string;
  reason?: string;
  revision: number;
}
