import { processLabels } from "@bd777/foundry-protocol";
import type { TranscriptMessage } from "@bd777/foundry-protocol";
import { claudeNarrationMessage } from "../claude-narration.js";
import {
  record,
  string,
  contentText,
  json,
  type JSONRecord,
} from "../json-values.js";
import { compactSummaryText } from "../claude-compact-summary.js";

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/**
 * A compaction in the transcript (DEV-083): its boundary, with what the
 * context held before and after, and the summary Claude continued from,
 * which Claude keeps as a user message of its own (shown with the
 * boundary, never as the person's message).
 */
function claudeCompactionRecord(
  envelope: JSONRecord,
  fallbackId: string,
): TranscriptMessage[] | undefined {
  const id = string(envelope.uuid) || fallbackId;
  if (envelope.type === "system" && envelope.subtype === "compact_boundary") {
    const metadata = record(
      envelope.compactMetadata ?? envelope.compact_metadata,
    );
    const pre = tokenCount(metadata.preTokens ?? metadata.pre_tokens);
    const post = tokenCount(metadata.postTokens ?? metadata.post_tokens);
    return [
      {
        id,
        kind: "boundary",
        text: processLabels.contextCompacted,
        compaction: {
          trigger: metadata.trigger === "manual" ? "manual" : "auto",
          ...(pre !== undefined ? { preTokens: pre } : {}),
          ...(post !== undefined ? { postTokens: post } : {}),
        },
      },
    ];
  }
  if (envelope.isCompactSummary === true) {
    // Named as a compaction's summary, which a view joins to the boundary
    // before it; labelled like the boundary for one that does not.
    const summary = compactSummaryText(envelope);
    return summary
      ? [
          {
            id: `compaction-summary:${id}`,
            kind: "boundary",
            text: processLabels.contextCompacted,
            compaction: { trigger: "auto", summary },
          },
        ]
      : [];
  }
  return undefined;
}

/** Shared by native chat imports and subagent transcript reads. */
export function claudeTranscriptRecord(
  envelope: JSONRecord,
  fallbackId: string,
): TranscriptMessage[] {
  const compaction = claudeCompactionRecord(envelope, fallbackId);
  if (compaction) return compaction;
  const message = record(envelope.message);
  const role = message.role;
  if (role !== "user" && role !== "assistant") return [];
  const id = string(envelope.uuid) || string(message.id) || fallbackId;
  const blocks = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: message.content }];
  return blocks
    .flatMap((value, index): TranscriptMessage[] => {
      const block = record(value);
      const blockId = `${id}:${index}`;
      if (block.type === "text")
        return [{ id: blockId, kind: role, text: string(block.text) }];
      const narration =
        role === "assistant"
          ? claudeNarrationMessage(envelope, block, index, fallbackId)
          : undefined;
      if (narration) return [narration];
      if (block.type === "thinking")
        return [
          {
            id: blockId,
            kind: "reasoning",
            text: string(block.thinking),
            title: processLabels.thought,
            status: "completed",
          },
        ];
      if (block.type === "tool_use")
        return [
          {
            id: blockId,
            kind: "tool",
            text: `${string(block.name)}\n\n\`\`\`json\n${json(block.input)}\n\`\`\``,
            title: processLabels.usingTool,
            callId: string(block.id) || blockId,
            status: "running",
          },
        ];
      if (block.type === "tool_result")
        return [
          {
            id: blockId,
            kind: "tool",
            text: contentText(block.content) || json(block.content),
            title: block.is_error
              ? processLabels.toolFailed
              : processLabels.usedTool,
            callId: string(block.tool_use_id) || undefined,
            status: block.is_error ? "failed" : "completed",
          },
        ];
      return [];
    })
    .filter((item) => item.text.trim());
}
