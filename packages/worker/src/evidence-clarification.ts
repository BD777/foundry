import { resolve } from "node:path";
import type {
  ContractContent,
  EvidenceWorkerRequest,
  EvidenceWorkerResult,
} from "@foundry/protocol";
import { validateEvidenceModel, evidenceModelSchema } from "@foundry/protocol";
import { EvidenceStore, INLINE_IMAGE_LIMIT } from "./evidence-store.js";
import { identifier } from "./execution-storage.js";
import { startSession } from "./session/index.js";
import {
  stageJSONObject,
  stageTranscript,
  type VerifierPacket,
} from "./evidence-agent.js";

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
 */
export function parseClarificationResponse(text: string) {
  return validateClarificationResponse(
    stageJSONObject(text) ?? { message: text.trim() },
  );
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
      message: `${stated.message.trim()}\n\n（这一版标准草案没有通过结构校验，没有保存；下一轮我会修正后再提交。）`,
    });
  }
}

/**
 * Runs in the person's own workspace, read-only: it reads the project to ground
 * its questions and proposals. It never implements, confirms or accepts.
 */
export async function clarifyIssueContract(
  request: Extract<EvidenceWorkerRequest, { action: "clarify" }>,
  store: EvidenceStore,
  workspacePath: string,
): Promise<EvidenceWorkerResult> {
  if (
    request.draft.issueId !== store.issueId ||
    request.draft.workspaceId !== store.workspaceId ||
    request.draft.status !== "draft" ||
    validateEvidenceModel("IssueContract", request.draft).length
  )
    throw new Error("clarification_requires_current_draft");
  const images: VerifierPacket["images"] = [];
  const media: { materialId: string; text?: string; imageIndex?: number }[] =
    [];
  const ids = new Set(
    [
      ...request.draft.goal.media,
      ...request.draft.criteria.flatMap((c) => c.rubric.media),
    ].map((m) => m.materialId),
  );
  for (const id of ids) {
    const material = store.getMaterial(id),
      bytes = store.readMaterial(id);
    if (["image/png", "image/jpeg", "image/gif"].includes(material.mimeType)) {
      if (bytes.length > INLINE_IMAGE_LIMIT)
        throw new Error("image_exceeds_inline_limit");
      media.push({ materialId: id, imageIndex: images.length });
      images.push({ materialId: id, mimeType: material.mimeType, bytes });
    } else if (
      ["text/plain", "application/json"].includes(material.mimeType) &&
      bytes.length <= 512 * 1024
    ) {
      media.push({ materialId: id, text: bytes.toString() });
    } else throw new Error("unsupported_clarification_reference");
  }
  const prompt = JSON.stringify({
    instruction: `You are talking with the person who owns this project. Your working directory is their workspace (${workspacePath}): read it before you answer, so questions and suggestions cite real files. Never change anything there. Talk like a colleague, not a form: ask at most one or two valuable questions per turn, infer what you can from the project, and only ask about choices you cannot decide for them. If they ask what is worth improving, look and propose concrete options with the files behind them. If they ask about status, answer from the draft and messages. Do not turn vague input such as "hi" into generic criteria. Never confirm, implement, judge or accept; "continue" or "yes" is not confirmation. Keep supplied reference media in proposals. Reply in the person's language as plain text. Only when the goal and how to check it are clear, end your reply with one fenced json block: {"message": <what the person reads>, "proposedContent": <ContractContent>} whose criteria carry stable IDs, proofKind, evaluationMode, rubric and evidenceRequirements, each check explained in plain language.`,
    verificationCapabilities:
      'Foundry verifies a criterion in one of two ways. Program: evaluationMode "deterministic" with checker {id, version:1, description, definitionDigest:"sha256:" followed by 64 zeros (Foundry recomputes it), timeoutMs, configuration:{kind:"project_command", executable, args, cwdRelativePath:".", environment:{}, expectedExitCodes:[0]}} makes Foundry itself run the project\'s own command on the sealed candidate, in a sandbox with a read-only candidate and no network, and keep stdout/stderr as the evidence; the exit code decides pass or fail. Use it for anything a command settles, such as the project test command, and give those criteria one evidence requirement with acceptedCarriers ["text_log"] and bindingPolicy "system_observed". Independent agent: evaluationMode "agent" for judgments no command can settle, such as wording or whether a change matches the intent; that session works inside the candidate worktree and its evidence is exported from candidate files, so use acceptedCarriers ["document"] or ["text_log"]. Write each criterion as the outcome the person cares about; the files to export are a collection detail, not part of the sentence, unless the person named the file. Never require a material a person would have to produce by hand.',
    draft: request.draft,
    messages: request.messages,
    referenceMaterials: media,
    contractSchema: evidenceModelSchema("ContractContent"),
  });
  if (Buffer.byteLength(prompt) > 2 * 1024 * 1024)
    throw new Error("clarification_context_too_large");
  const response = await startSession({
    role: "clarification",
    harness: request.harness,
    profileId: request.profileId,
    model: request.requestedModel,
    title: "Foundry foundry-clarification/v3",
    prompt: { text: prompt, images },
    directory: resolve(
      store.root,
      "verifier-output",
      identifier(request.taskId),
    ),
    controlServerURL: request.controlServerURL,
    workspace: { path: workspacePath, readRoots: [] },
    systemPrompt:
      "You are Foundry's clarification partner for one Issue. You work read-only inside the person's project: read it to ground the conversation. You do not implement, confirm, verify or accept.",
  }).result;
  const raw = store.sealMaterial(
    "Clarification original response",
    "text_log",
    Buffer.from(stageTranscript(response.activity, response.text)),
  );
  const parsed = readClarificationAnswer(response.text);
  for (const ref of [
    ...(parsed.proposedContent?.goal.media ?? []),
    ...(parsed.proposedContent?.criteria.flatMap((c) => c.rubric.media) ?? []),
  ])
    if (!ids.has(ref.materialId))
      throw new Error("clarification_reference_not_supplied");
  return {
    taskId: request.taskId,
    materials: [raw],
    clarification: {
      ...parsed,
      sessionId: response.sessionId,
      rawOutputMaterialId: raw.id,
    },
  };
}
