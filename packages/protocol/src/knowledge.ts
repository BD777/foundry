/** File authority on the selected device. Server indexes contain metadata only. */
export interface KnowledgeDocument {
  id: string;
  revision: number;
  operationId: string;
  hash: string;
  body: string;
  deleted: boolean;
  sourceRef: string;
  sourceVersion?: string;
  expiresAt?: string;
  updatedAt: string;
}

export interface KnowledgeCommand {
  workspaceId: string;
  rootPath: string;
  vaultId: string;
  epoch: number;
  action:
    | "inspect"
    | "adopt"
    | "status"
    | "import"
    | "initialize"
    | "read"
    | "list"
    | "write"
    | "forget"
    | "freeze"
    | "activate"
    | "retire";
  operationId: string;
  documentId?: string;
  expectedRevision?: number;
  expectedHash?: string;
  expectedRawHash?: string;
  minimumRevision?: number;
  body?: string;
  sourceRef?: string;
  sourceVersion?: string;
  expiresAt?: string;
  /** A staged destination only becomes writable after the Server pointer switches. */
  staged?: boolean;
  expectedControlRevision?: number;
  importDocument?: KnowledgeDocument;
}

export interface KnowledgeSourceReview {
  rawHash: string;
  rawContent: string;
  body: string;
}

export interface KnowledgeReply {
  review?: KnowledgeSourceReview;
  controlRevision: number;
  controlOperationId: string;
  vaultId: string;
  epoch: number;
  state: string;
  operationId: string;
  document?: KnowledgeDocument;
  /** List entries contain metadata and an empty body; use read for source text. */
  documents?: KnowledgeDocument[];
  error?: string;
  code?: string;
}
