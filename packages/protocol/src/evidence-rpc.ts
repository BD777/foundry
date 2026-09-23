import type {
  ActorRef,
  CandidateSnapshot,
  Evidence,
  IssueContract,
  Material,
  Verification,
  VerificationInput,
} from "./evidence.js";

export type EvidenceWorkerRequest =
  | {
      action: "clarify";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      draft: IssueContract;
      messages: { role: "user" | "assistant"; text: string }[];
      harness: "claude" | "codex";
      profileId: string;
      requestedModel: string;
      controlServerURL: string;
    }
  | {
      action: "recover";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
    }
  | {
      action: "file_export";
      sourceKind?: "candidate_file" | "candidate_changes";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      contract: IssueContract;
      input: VerificationInput;
      repoId: string;
      relativePath: string;
      claims: import("./evidence.js").EvidenceClaim[];
      carrier: Material["carrier"];
    }
  | {
      action: "assess";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      contract: IssueContract;
      verification: Verification;
      input: VerificationInput;
      evidence: Evidence[];
    }
  | {
      action: "check_accept";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      candidate: CandidateSnapshot;
      materialIds: string[];
      decisionId?: string;
    }
  | {
      action: "accept";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      decision: import("./evidence.js").AcceptanceDecision;
      review: import("./evidence.js").ReviewSnapshot;
      candidate: CandidateSnapshot;
      materialIds: string[];
    }
  | {
      action: "seal";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      contract: IssueContract;
      alignFromSnapshotId?: string;
      httpTargets?: { name: string; entrypointRelativePath: string }[];
    }
  | {
      action: "collect";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      contract: IssueContract;
      verification: Verification;
      input: VerificationInput;
    }
  | {
      action: "upload_chunk";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      offset: number;
      bytesBase64: string;
    }
  | {
      action: "upload_seal";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      name: string;
      byteSize: number;
      carrier: Material["carrier"];
      actor: ActorRef;
    }
  | {
      action: "read";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      materialId: string;
      offset: number;
    }
  | {
      action: "inventory";
      workspaceId: string;
      issueId: string;
      deviceId: string;
      taskId: string;
      offset?: number;
      limit?: number;
    };
export interface EvidenceWorkerResult {
  error?: string;
  taskId: string;
  materials?: Material[];
  candidate?: CandidateSnapshot;
  input?: VerificationInput;
  evidence?: Evidence[];
  verification?: Verification;
  bytesBase64?: string;
  byteSize?: number;
  integrationId?: string;
  status?: string;
  integrationSnapshot?: CandidateSnapshot;
  recovered?: EvidenceWorkerResult;
  total?: number;
  clarification?: {
    message: string;
    proposedContent?: import("./evidence.js").ContractContent;
    sessionId?: string;
    rawOutputMaterialId: string;
  };
}
