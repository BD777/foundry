import type { TranscriptMessage } from "@foundry/protocol";
import {
  record,
  string,
  contentText,
  json,
  type RecordValue,
} from "./values.js";

/** Shared by native chat imports and subagent transcript reads. */
export function claudeTranscriptRecord(
  envelope: RecordValue,
  fallbackId: string,
): TranscriptMessage[] {
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
      if (block.type === "thinking")
        return [
          {
            id: blockId,
            kind: "reasoning",
            text: string(block.thinking),
            title: "思考完成",
            status: "completed",
          },
        ];
      if (block.type === "tool_use")
        return [
          {
            id: blockId,
            kind: "tool",
            text: `${string(block.name)}\n\n\`\`\`json\n${json(block.input)}\n\`\`\``,
            title: "正在使用工具",
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
            title: block.is_error ? "工具执行失败" : "已使用工具",
            callId: string(block.tool_use_id) || undefined,
            status: block.is_error ? "failed" : "completed",
          },
        ];
      return [];
    })
    .filter((item) => item.text.trim());
}
