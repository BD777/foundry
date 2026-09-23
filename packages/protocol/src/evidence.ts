/** Evidence & Verify v1. IDs/provenance/digests are assigned by trusted services. */
export type Digest = string;
export type DateTime = string;
export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type Verdict = "pass" | "fail" | "inconclusive";
export type EvaluationMode = "deterministic" | "agent";
export type CarrierKind =
  | "text_log"
  | "image"
  | "video"
  | "audio"
  | "http_exchange"
  | "test_report"
  | "data"
  | "document"
  | "file"
  | "other";
export type ProofKind =
  | "functional"
  | "visual_interaction"
  | "quality"
  | "data_correctness"
  | "content_completeness"
  | "constraint_compliance"
  | "other";
export type BindingStatus = "verified" | "human_attested" | "unknown";
export interface ActorRef {
  kind: "user" | "local_owner" | "agent" | "daemon" | "system";
  id: string;
  displayName: string;
  sessionId?: string;
}
export interface EvidenceRecord {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  issueId: string;
  createdAt: DateTime;
  createdBy: ActorRef;
}
export type MaterialSelector =
  | { kind: "text_lines"; start: number; end: number }
  | { kind: "page"; page: number }
  | { kind: "time_range"; startMs: number; endMs: number }
  | {
      kind: "image_region";
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | { kind: "json_pointer"; pointer: string };
export interface ReferenceMedia {
  materialId: string;
  role: "target" | "example" | "counterexample" | "context";
  caption: string;
  selector?: MaterialSelector;
}
export interface RichContent {
  text: string;
  media: ReferenceMedia[];
}
export interface EvidenceRequirement {
  id: string;
  description: string;
  acceptedCarriers: CarrierKind[];
  minimumCount: number;
  bindingPolicy: "system_observed" | "system_or_human_attested";
}
export interface SecretBinding {
  name: string;
  credentialRef: string;
}
export type CheckConfiguration =
  | {
      kind: "command";
      executable: string;
      args: string[];
      cwdRelativePath: string;
      checkerBundleMaterialId: string;
      entrypoint: string;
      fixtureMaterialIds: string[];
      environment: Record<string, string>;
      secretBindings: SecretBinding[];
      expectedExitCodes: number[];
      resultFormat: "foundry-check/v1";
      minimumAssertions: number;
    }
  | {
      /**
       * A command the project already owns, run by Foundry on the sealed
       * candidate. The exit code decides the verdict and the captured output
       * becomes the evidence, so no checker bundle or assertion format exists.
       */
      kind: "project_command";
      executable: string;
      args: string[];
      cwdRelativePath: string;
      environment: Record<string, string>;
      expectedExitCodes: number[];
    }
  | {
      kind: "http";
      targetName: string;
      method: string;
      path: string;
      headers: Record<string, string>;
      secretBindings: SecretBinding[];
      bodyMaterialId?: string;
      expectedStatus: number;
      expectedHeaders: Record<string, string>;
      expectedJsonValues: Record<string, JSONValue>;
    };
export interface CheckDefinition {
  id: string;
  version: number;
  description: string;
  definitionDigest: Digest;
  timeoutMs: number;
  configuration: CheckConfiguration;
}
export interface AcceptanceCriterion {
  id: string;
  title: string;
  statement: string;
  required: boolean;
  proofKind: ProofKind;
  proofKindLabel?: string;
  evaluationMode: EvaluationMode;
  rubric: RichContent;
  evidenceRequirements: EvidenceRequirement[];
  checker?: CheckDefinition;
  maxEvidenceAgeSeconds?: number;
}
export interface ContractContent {
  goal: RichContent;
  inScope: string[];
  outOfScope: string[];
  constraints: string[];
  criteria: AcceptanceCriterion[];
}
export interface ContractConfirmation {
  actor: ActorRef;
  at: DateTime;
  contentDigest: Digest;
}
export interface IssueContract extends EvidenceRecord, ContractContent {
  revision: number;
  basedOnRevision?: number;
  origin: "user" | "agent_proposal" | "legacy_import";
  changeReason?: string;
  contentDigest: Digest;
  status: "draft" | "confirmed" | "superseded" | "discarded";
  confirmation?: ContractConfirmation;
}
export interface Material extends EvidenceRecord {
  name: string;
  carrier: CarrierKind;
  mimeType: string;
  byteSize: number;
  digest: Digest;
  storageDeviceId: string;
  capturedAt: DateTime;
  derivedFromMaterialId?: string;
  transformation?: {
    kind: "preview" | "render" | "redact" | "normalize";
    tool: string;
    version: string;
  };
  redaction: {
    status: "none" | "applied";
    policyVersion?: string;
    note?: string;
  };
  previewMaterialIds: string[];
  availability: "available" | "offline" | "missing" | "corrupt" | "deleted";
  availabilityCheckedAt: DateTime;
}
export interface SnapshotRepository {
  repoId: string;
  relativePath: string;
  kind: "root" | "independent" | "submodule";
  parentRepoId?: string;
  baselineRef: string;
  baselineCommit: string;
  candidateCommit: string;
  treeOid: string;
}
export interface SnapshotFile {
  repoId: string;
  path: string;
  kind: "file" | "symlink" | "gitlink";
  mode: string;
  digest: string;
}
export interface CandidateSnapshot extends EvidenceRecord {
  environmentId: string;
  environmentRevision: number;
  purpose: "candidate" | "integration";
  parentSnapshotId?: string;
  repositories: SnapshotRepository[];
  fileManifestMaterialId: string;
  contentDigest: Digest;
  capturedAt: DateTime;
}
export interface EnvironmentSnapshot {
  deviceId: string;
  executionEnvironmentId: string;
  os: string;
  architecture: string;
  tools: { name: string; version: string }[];
  configurationDigest: string;
  resource?: {
    kind: "browser" | "computer" | "simulator" | "service" | "other";
    instanceId: string;
    provider: string;
    providerVersion: string;
  };
}
export interface InputDependency {
  name: string;
  kind:
    | "configuration"
    | "dataset"
    | "dependency_lock"
    | "credential_version"
    | "other";
  sourceLabel: string;
  versionToken: string;
  materialId?: string;
  revalidation: "immutable" | "check_before_accept";
}
export interface TargetSnapshot {
  name: string;
  kind: "source" | "build" | "service" | "device_app";
  locatorLabel: string;
  instanceId?: string;
  build?: {
    digest: string;
    sourceCandidateSnapshotId: string;
    materialId?: string;
    producerDeviceId: string;
  };
  observedIdentity: string;
  identityMethod:
    | "local_snapshot"
    | "build_manifest"
    | "endpoint_probe"
    | "human_attestation";
  bindingStatus: BindingStatus;
  observedAt: DateTime;
}
export interface VerificationInput extends EvidenceRecord {
  contractRevision: number;
  contractDigest: Digest;
  candidateSnapshotId: string;
  candidateDigest: Digest;
  environment: EnvironmentSnapshot;
  dependencies: InputDependency[];
  targets: TargetSnapshot[];
  inputDigest: Digest;
  bindingStatus: BindingStatus;
  bindingNotes: string[];
}
export interface EvidenceClaim {
  criterionId: string;
  requirementId: string;
  purpose: string;
}
export interface EvidenceMaterialRef {
  materialId: string;
  role:
    | "primary"
    | "supporting"
    | "stdout"
    | "stderr"
    | "report"
    | "request"
    | "response"
    | "trace";
}
export interface EvidenceSource {
  kind: "tool_capture" | "candidate_export" | "human_upload" | "agent_authored";
  producer: ActorRef;
  deviceId?: string;
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
}
export interface CollectionRecord {
  operation: "command" | "http" | "file_export" | "upload" | "agent_generation";
  collectorName: string;
  collectorVersion: string;
  inputMaterialId: string;
  startedAt: DateTime;
  finishedAt: DateTime;
  outcome: "completed" | "failed" | "timed_out" | "canceled";
  exitCode?: number;
  httpStatus?: number;
  error?: { code: string; message: string };
  completeness: "complete" | "truncated" | "partial";
}
export interface Evidence extends EvidenceRecord {
  title: string;
  description: string;
  verificationInputId: string;
  claims: EvidenceClaim[];
  materials: EvidenceMaterialRef[];
  source: EvidenceSource;
  collection: CollectionRecord;
  candidateBinding: "system_observed" | "human_attested";
  bindingAttestation?: { actor: ActorRef; at: DateTime; statement: string };
  supersedesEvidenceId?: string;
}
export type VerifierIdentity =
  | { kind: "program"; name: string; version: string; checkerDigest: string }
  | {
      kind: "agent";
      harness: "claude" | "codex";
      profileId: string;
      requestedModel: string;
      reportedModel?: string;
      sessionId: string;
      promptTemplateVersion: string;
      promptDigest: string;
      isolated: true;
    };
export interface EvidenceCitation {
  evidenceId: string;
  materialId: string;
  selector?: MaterialSelector;
}
export interface ReferenceCitation {
  materialId: string;
  selector?: MaterialSelector;
}
export interface VerificationFinding {
  id: string;
  statement: string;
  expected: string;
  observed: string;
  verdict: Verdict;
  evidenceCitations: EvidenceCitation[];
  referenceCitations: ReferenceCitation[];
}
export interface VerificationResult {
  verdict: Verdict;
  summary: string;
  reasoning: string;
  findings: VerificationFinding[];
  limitations: string[];
  unmetRequirementIds: string[];
  rawOutputMaterialId: string;
  reportMaterialId: string;
  completedAt: DateTime;
}
export interface Verification extends EvidenceRecord {
  sequence: number;
  criterionId: string;
  contractRevision: number;
  verificationInputId: string;
  evidenceIds: string[];
  mode: EvaluationMode;
  executor: VerifierIdentity;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  startedAt?: DateTime;
  finishedAt?: DateTime;
  result?: VerificationResult;
  error?: { code: string; message: string; retryable: boolean };
  supersedesVerificationId?: string;
}
export interface HumanAssessment extends EvidenceRecord {
  criterionId: string;
  contractRevision: number;
  verificationInputId: string;
  verificationId: string;
  verdict: Verdict;
  rationale: RichContent;
  evidenceCitations: EvidenceCitation[];
  supersedesAssessmentId?: string;
}
export interface CriterionReviewEntry {
  criterionId: string;
  verificationId?: string;
  humanAssessmentId?: string;
  evidenceIds: string[];
  effectiveVerdict: "pass" | "fail" | "inconclusive" | "not_evaluated";
  authority: "program" | "agent_preliminary" | "human" | "none";
  freshness: "fresh" | "stale" | "unknown";
  evidenceAvailability: "available" | "unavailable";
  reasons: string[];
}
export interface ReviewBlocker {
  code:
    | "contract_unconfirmed"
    | "contract_amendment_pending"
    | "checker_missing"
    | "verification_pending"
    | "verification_error"
    | "required_failed"
    | "required_inconclusive"
    | "evidence_missing"
    | "input_unbound"
    | "stale"
    | "material_unavailable"
    | "candidate_changed"
    | "baseline_changed";
  criterionId?: string;
  message: string;
}
export interface ReviewSnapshot extends EvidenceRecord {
  contractRevision: number;
  candidateSnapshotId: string;
  criterionResults: CriterionReviewEntry[];
  blockingReasons: ReviewBlocker[];
  eligible: boolean;
  digest: Digest;
}
export interface AcceptanceDecision extends EvidenceRecord {
  reviewSnapshotId: string;
  reviewDigest: Digest;
  contractRevision: number;
  candidateSnapshotId: string;
  rationale?: RichContent;
  status: "approved" | "invalidated" | "integrated";
  invalidatedAt?: DateTime;
  invalidationReason?: string;
  integrationId?: string;
}
export interface AuditEvent extends EvidenceRecord {
  sequence: number;
  action:
    | "contract_proposed"
    | "contract_confirmed"
    | "contract_discarded"
    | "evidence_registered"
    | "verification_requested"
    | "verification_completed"
    | "verification_failed"
    | "human_assessed"
    | "acceptance_approved"
    | "acceptance_invalidated"
    | "integration_started"
    | "integration_completed"
    | "integration_failed"
    | "material_availability_changed"
    | "candidate_sealed";
  subject: { type: string; id: string };
  beforeDigest?: Digest;
  afterDigest?: Digest;
  reason?: string;
  requestId: string;
}
export interface VerificationSummary {
  requiredTotal: number;
  passed: number;
  failed: number;
  inconclusive: number;
  pending: number;
  stale: number;
  eligible: boolean;
}
export interface ContractDraftInput {
  baseRevision?: number;
  content: ContractContent;
  changeReason?: string;
}
export interface CheckAssertion {
  id: string;
  expected: JSONValue;
  observed: JSONValue;
  verdict: Verdict;
}
export interface CheckReport {
  assertions: CheckAssertion[];
}
