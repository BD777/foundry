import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentSession,
  ChatAttachment,
  ClarificationResponse,
  ClarificationTurn,
  ContractContent,
  SessionInput,
} from "@bd777/foundry-protocol";
import {
  validateEvidenceModel,
  evidenceModelSchema,
} from "@bd777/foundry-protocol";
import { EvidenceStore } from "./evidence-store.js";
import { readableReferenceType, referenceFile } from "./reference-files.js";
import { ExecutionStore, identifier } from "./execution-storage.js";
import {
  isolatedAgentEnvironment,
  skillSetsReadRoot,
} from "./execution-sandbox.js";
import type { SessionAmbientEnv } from "./session-ambient.js";
import type { WorkspaceSandbox } from "./session/index.js";
import { writePrivateJSONAtomic } from "./storage.js";
import { readAgentSessionCompletionMarker } from "./session-helpers.js";
import { stageJSONObject } from "./evidence-agent.js";

// An Issue's clarification is a session with the issue_clarification role
// (session-roles.ts): every message the person sends about the draft is an
// input of it, so the Agent keeps its context between turns. It runs in the
// person's own workspace, read-only, to ground its questions and proposals
// in real files. It never implements, confirms or accepts.

export function validateClarificationResponse(value: unknown): {
  message: string;
  proposedContent?: ContractContent;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_clarification_response");
  const result = value as {
    message: string;
    proposedContent?: ContractContent;
  };
  if (
    Object.keys(result).some(
      (key) => !["message", "proposedContent"].includes(key),
    ) ||
    typeof result.message !== "string" ||
    !result.message.trim() ||
    result.message.length > 16000
  )
    throw new Error("invalid_clarification_response");
  if (result.proposedContent) {
    const errors = validateEvidenceModel(
      "ContractContent",
      result.proposedContent,
    );
    if (errors.length)
      throw new Error(`invalid_contract_proposal: ${errors.join("; ")}`);
    if (!result.proposedContent.criteria.some((c) => c.required))
      throw new Error("proposal_requires_observable_criterion");
    // A deterministic criterion without its checker can never be verified and
    // would deadlock acceptance. Independent agent verification is the default.
    if (
      result.proposedContent.criteria.some(
        (c) => c.evaluationMode === "deterministic" && !c.checker,
      )
    )
      throw new Error("deterministic_criterion_requires_checker");
  }
  return result;
}

/**
 * Ordinary prose is just a chat message. A contract proposal has to arrive as a
 * JSON object, whole or in a fenced block, so it can never be prose in disguise.
 * What the Agent wrote around that block is part of its reply and comes first.
 */
export function parseClarificationResponse(text: string) {
  const stated = stageJSONObject(text);
  if (!stated) return validateClarificationResponse({ message: text.trim() });
  const result = stated as { message?: unknown };
  return validateClarificationResponse(
    typeof result.message === "string"
      ? { ...result, message: withProse(text, result.message) }
      : stated,
  );
}

/** The reply: prose outside the JSON block, then the block's message. */
function withProse(text: string, message: string): string {
  const said = message.trim();
  // A reply that is the bare object has nothing around it.
  if (text.trim().startsWith("{")) return said;
  const prose = text.replace(/```(?:json)?\s*\n[\s\S]*?\n```/gi, "").trim();
  if (!prose || said.includes(prose)) return said;
  if (prose.includes(said)) return prose;
  return `${prose}\n\n${said}`;
}

/**
 * A malformed proposal must not cost the person their answer: the message still
 * arrives, and only the unusable draft is left out.
 */
export function readClarificationAnswer(text: string): {
  message: string;
  proposedContent?: ContractContent;
} {
  try {
    return parseClarificationResponse(text);
  } catch (error) {
    const stated = stageJSONObject(text) as { message?: unknown } | undefined;
    if (!stated || typeof stated.message !== "string" || !stated.message.trim())
      throw error;
    return validateClarificationResponse({
      message: `${withProse(text, stated.message)}\n\n(This draft of the criteria did not pass validation and was not saved; I will fix it and submit it in the next round.)`,
    });
  }
}

const instruction = `You are Foundry's clarification partner for one Issue, talking with the person who owns this project. You do not implement, confirm, verify or accept. Your working directory is their workspace (WORKSPACE): read it before you answer, so questions and suggestions cite real files. Never change anything there. Talk like a colleague, not a form: ask at most one or two valuable questions per turn, infer what you can from the project, and only ask about choices you cannot decide for them. If they ask what is worth improving, look and propose concrete options with the files behind them. If they ask about status, answer from the draft and messages. When they refer to an earlier conversation in this workspace, look it up with the Foundry tools list_sessions and read_context. Reference files are listed with their paths; read them. Do not turn vague input such as "hi" into generic criteria. Never confirm, implement, judge or accept; "continue" or "yes" is not confirmation. Keep supplied reference media in proposals. Reply in the person's language as plain text. Only when the goal and how to check it are clear, end your reply with one fenced json block: {"message": <what the person reads after your text>, "proposedContent": <ContractContent>} whose criteria carry stable IDs, proofKind, evaluationMode, rubric and evidenceRequirements, each check explained in plain language. The person sees your text before the block and then its message, so do not repeat yourself.`;

const verificationCapabilities =
  'Foundry verifies a criterion in one of two ways. Program: evaluationMode "deterministic" with checker {id, version:1, description, definitionDigest:"sha256:" followed by 64 zeros (Foundry recomputes it), timeoutMs, configuration:{kind:"project_command", executable, args, cwdRelativePath:".", environment:{}, expectedExitCodes:[0]}} makes Foundry itself run the project\'s own command on the sealed candidate, in a sandbox with a read-only candidate and no network, and keep stdout/stderr as the evidence; the exit code decides pass or fail. Use it for anything a command settles, such as the project test command, and give those criteria one evidence requirement with acceptedCarriers ["text_log"] and bindingPolicy "system_observed". Independent agent: evaluationMode "agent" for judgments no command can settle, such as wording or whether a change matches the intent; that session works inside the candidate worktree and its evidence is exported from candidate files, so use acceptedCarriers ["document"] or ["text_log"]. Write each criterion as the outcome the person cares about; the files to export are a collection detail, not part of the sentence, unless the person named the file. Never require a material a person would have to produce by hand.';

/** Where an Issue's clarification keeps its private state and references. */
export function clarificationDirectory(
  workspaceId: string,
  issueId: string,
  store = new ExecutionStore(),
): string {
  return resolve(
    store.executionRoot,
    identifier(workspaceId),
    "clarifications",
    identifier(issueId),
  );
}

/**
 * How a clarification runs: in the workspace itself, which it can read but
 * not change, with a private home for the agent and read-only references.
 */
export function clarificationExecution(
  session: AgentSession,
  workspacePath: string,
  ambient: SessionAmbientEnv,
): { cwd: string; stateRoot: string; sandbox: WorkspaceSandbox } {
  const directory = clarificationDirectory(
    session.workspaceId,
    session.issueId ?? "",
  );
  const scratch = resolve(directory, "scratch");
  const references = resolve(directory, "references");
  for (const path of [scratch, references])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  return {
    cwd: workspacePath,
    stateRoot: directory,
    sandbox: {
      profile: {
        kind: "writable_tree",
        policyFile: resolve(directory, "clarification.sb"),
        workdir: workspacePath,
        readRoots: [workspacePath],
        writeRoots: [scratch],
        protectedReadRoots: [references, skillSetsReadRoot()],
        readOnlyDirectories: [],
        readOnlyPaths: [],
        connectSockets: [],
        executables: [],
        userFiles: "hidden",
      },
      env: isolatedAgentEnvironment(scratch),
      stderrFile: resolve(directory, "session.stderr.log"),
      ambient,
    },
  };
}

/**
 * The input a clarification turn sends: the person's message with the draft
 * it is about, and the references the draft carries as files to read. A
 * session without native context also gets
 * its instructions and the conversation so far.
 */
export async function clarificationInput(
  session: AgentSession,
  turn: ClarificationTurn,
  workspacePath: string,
  store: EvidenceStore,
): Promise<SessionInput> {
  const references = resolve(
    clarificationDirectory(session.workspaceId, session.issueId ?? ""),
    "references",
  );
  mkdirSync(references, { recursive: true, mode: 0o700 });
  const attachments: ChatAttachment[] = [];
  const referenceMaterials: {
    materialId: string;
    name: string;
    path: string;
  }[] = [];
  for (const id of referenceIds(turn.draft)) {
    const material = store.getMaterial(id);
    if (!readableReferenceType(material.mimeType))
      throw new Error("unsupported_clarification_reference");
    const original = referenceFile(
      references,
      material,
      material.name,
      store.readMaterial(id),
    );
    attachments.push(original);
    referenceMaterials.push({
      materialId: id,
      name: material.name,
      path: original.path,
    });
  }
  const fresh = !session.nativeSessionId?.trim();
  const prompt = JSON.stringify({
    ...(fresh
      ? {
          instruction: instruction.replace("WORKSPACE", workspacePath),
          verificationCapabilities,
          contractSchema: evidenceModelSchema("ContractContent"),
          earlierMessages: turn.messages,
        }
      : {
          reminder:
            "Same rules as before: read-only, plain-text reply in the person's language, and a fenced json block only for a full proposal. The person sees your text and then the block's message, so the message must not repeat your text.",
        }),
    draft: turn.draft,
    referenceMaterials,
    message: turn.message,
  });
  if (Buffer.byteLength(prompt) > 2 * 1024 * 1024)
    throw new Error("clarification_context_too_large");
  return {
    ...(session.input ?? { id: session.id, prompt: "" }),
    prompt,
    attachments,
  };
}

function referenceIds(draft: ClarificationTurn["draft"]): Set<string> {
  return new Set(
    [...draft.goal.media, ...draft.criteria.flatMap((c) => c.rubric.media)].map(
      (m) => m.materialId,
    ),
  );
}

/**
 * The reply the person reads. A proposal citing references the draft did not
 * supply is not saved; the message still arrives.
 */
export function clarificationReply(
  text: string,
  turn: ClarificationTurn,
): ClarificationResponse {
  const answer = readClarificationAnswer(text);
  const supplied = referenceIds(turn.draft);
  const cited = [
    ...(answer.proposedContent?.goal.media ?? []),
    ...(answer.proposedContent?.criteria.flatMap((c) => c.rubric.media) ?? []),
  ];
  if (cited.some((ref) => !supplied.has(ref.materialId)))
    return {
      message: `${answer.message}\n\n(This draft of the criteria cited references that were not provided and was not saved; I will fix it and submit it in the next round.)`,
    };
  return answer;
}

/** The reply recorded for an input, so a lost report is sent again. */
export function recordedClarificationReply(
  workspaceId: string,
  issueId: string,
  inputId: string,
): ClarificationResponse | undefined {
  const path = replyPath(workspaceId, issueId, inputId);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as ClarificationResponse)
    : undefined;
}

export function recordClarificationReply(
  workspaceId: string,
  issueId: string,
  inputId: string,
  reply: ClarificationResponse,
): void {
  writePrivateJSONAtomic(replyPath(workspaceId, issueId, inputId), reply);
}

function replyPath(workspaceId: string, issueId: string, inputId: string) {
  return resolve(
    clarificationDirectory(workspaceId, issueId),
    "replies",
    `${identifier(inputId)}.json`,
  );
}

/**
 * Everything a dispatched clarification input needs: where it runs, the
 * input it sends, and how its answer becomes the reply on the Issue.
 */
export async function prepareClarification(
  session: AgentSession,
  turn: ClarificationTurn | undefined,
  workspacePath: string,
  ambient: SessionAmbientEnv,
): Promise<{
  execution: ReturnType<typeof clarificationExecution>;
  session: AgentSession;
  settle: (result: { response: string }) => Record<string, unknown>;
}> {
  const issueId = session.issueId ?? "";
  const inputId = session.input?.id ?? "";
  if (!turn || !issueId || !inputId)
    throw new Error("The clarification was not sent with its draft.");
  const store = new EvidenceStore(
    session.workspaceId,
    issueId,
    session.deviceId,
    { kind: "daemon", id: session.deviceId, displayName: "Foundry Worker" },
  );
  return {
    execution: clarificationExecution(session, workspacePath, ambient),
    session: {
      ...session,
      input: await clarificationInput(session, turn, workspacePath, store),
    },
    settle: (result) => {
      const reply = clarificationReply(result.response, turn);
      recordClarificationReply(session.workspaceId, issueId, inputId, reply);
      return { clarificationResult: reply };
    },
  };
}

/**
 * The session_completed report for a clarification input this process does
 * not run: the reply it recorded, or that the reply was lost.
 */
export function recoveredClarificationCompletion(
  workspaceId: string,
  issueId: string,
  sessionId: string,
  inputId: string,
): Record<string, unknown> {
  const reply = recordedClarificationReply(workspaceId, issueId, inputId);
  if (!reply)
    return {
      sessionId,
      inputId: inputId || undefined,
      error:
        "The worker stopped while the Agent was replying, so the reply was lost.",
    };
  const marker = readAgentSessionCompletionMarker(
    clarificationDirectory(workspaceId, issueId),
    sessionId,
    inputId,
  );
  return {
    sessionId,
    inputId: inputId || undefined,
    nativeSessionId: marker?.nativeSessionId,
    response: marker?.response ?? reply.message,
    clarificationResult: reply,
  };
}
