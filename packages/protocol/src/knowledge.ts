/** File authority on the selected device. Server indexes contain metadata only. */
import type { KnowledgeDocument } from "./contract.gen.js";
export type {
  KnowledgeDocument,
  KnowledgeReply,
  KnowledgeSourceReview,
} from "./contract.gen.js";

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
