import type { TranscriptMessage } from "@foundry/protocol";
import { sdkProcessEvent } from "../sdk-messages.js";
import {
  record,
  string,
  contentText,
  json,
  type RecordValue,
} from "./values.js";

export function codexTranscriptRecord(
  envelope: RecordValue,
  fallbackId: string,
): TranscriptMessage[] {
  const payload = record(envelope.payload);
  const item =
    envelope.type === "response_item"
      ? payload
      : envelope.type === "event_msg" && payload.type === "item_completed"
        ? record(payload.item)
        : typeof envelope.type === "string" && envelope.type.startsWith("item.")
          ? record(envelope.item)
          : {};
  const id = string(item.id) || fallbackId;
  if (item.type === "reasoning" || item.type === "Reasoning") {
    return [
      {
        id,
        kind: "reasoning",
        text:
          contentText(item.summary ?? item.summary_text) || string(item.text),
        title: "思考完成",
        status: "completed",
      },
    ];
  }
  if (
    ["message", "UserMessage", "AgentMessage", "agent_message"].includes(
      string(item.type),
    )
  ) {
    const role =
      item.role ?? (item.type === "UserMessage" ? "user" : "assistant");
    if (
      (role !== "user" && role !== "assistant") ||
      item.channel === "analysis"
    )
      return [];
    return [
      {
        id,
        kind:
          role === "assistant" &&
          (item.phase === "commentary" || item.channel === "commentary")
            ? "commentary"
            : role,
        text: contentText(item.content) || string(item.text),
      },
    ];
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    return [
      {
        id,
        kind: "tool",
        text: `${string(item.name)}\n\n\`\`\`json\n${json(item.arguments ?? item.input)}\n\`\`\``,
        title: "正在使用工具",
        callId: string(item.call_id) || id,
        status: "running",
      },
    ];
  }
  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    return [
      {
        id: `output:${string(item.call_id) || id}`,
        kind: "tool",
        text: contentText(item.output) || json(item.output),
        title: "已使用工具",
        callId: string(item.call_id) || undefined,
        status: "completed",
      },
    ];
  }
  const process = sdkProcessEvent(envelope);
  if (process)
    return [
      {
        id,
        kind: "tool",
        text: process.detail,
        title: process.label,
        callId: id,
        status:
          item.status === "failed"
            ? "failed"
            : envelope.type === "item.completed"
              ? "completed"
              : "running",
      },
    ];
  if (envelope.type === "compacted")
    return [
      { id: fallbackId, kind: "boundary", text: "原生会话已压缩上下文。" },
    ];
  if (envelope.type === "event_msg") {
    if (payload.type === "user_message")
      return [{ id: fallbackId, kind: "user", text: string(payload.message) }];
    if (payload.type === "agent_message")
      return [
        {
          id: fallbackId,
          kind: payload.phase === "commentary" ? "commentary" : "assistant",
          text: string(payload.message),
        },
      ];
    if (payload.type === "agent_reasoning")
      return [
        {
          id: fallbackId,
          kind: "reasoning",
          text: string(payload.text),
          title: "思考完成",
          status: "completed",
        },
      ];
  }
  return [];
}
