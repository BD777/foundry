/**
 * What the Claude message log (claude-sdk.messages.jsonl) keeps of a stream.
 *
 * Every SDK message is logged as it came, except the deltas of a content
 * block: the finished block arrives again whole in its assistant message, so
 * a delta per line only repeated it (a large Write sent thousands, DEV-124).
 * A block's deltas are folded into `foundry_stream_summary` lines instead:
 * one as the block stops, one every few seconds while it streams, so a block
 * whose process died mid-stream still shows how far it got, and one for each
 * block still open when the process ends.
 */

const progressEveryMs = 5000;

interface OpenBlock {
  index: number;
  parentToolUseId: string | null;
  block: string;
  name?: string;
  deltas: number;
  bytes: number;
  startedAt: number;
  reportedAt: number;
}

export interface StreamSummary {
  type: "foundry_stream_summary";
  end: "stop" | "progress" | "interrupted";
  index: number;
  parent_tool_use_id: string | null;
  block: string;
  name?: string;
  deltas: number;
  bytes: number;
  ms: number;
}

type StreamEvent = {
  type?: string;
  index?: number;
  content_block?: { type?: string; name?: string };
  delta?: Record<string, unknown>;
};

function deltaBytes(delta: Record<string, unknown> | undefined): number {
  let bytes = 0;
  for (const key of ["text", "partial_json", "thinking", "signature"]) {
    const value = delta?.[key];
    if (typeof value === "string") bytes += Buffer.byteLength(value);
  }
  return bytes;
}

export class ClaudeStreamLog {
  private readonly open = new Map<string, OpenBlock>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The lines to log for one SDK message, in order. */
  lines(message: unknown): unknown[] {
    const record = message as {
      type?: string;
      event?: StreamEvent;
      parent_tool_use_id?: string | null;
    } | null;
    const event = record?.type === "stream_event" ? record.event : undefined;
    if (!event || typeof event.index !== "number") return [message];
    const parentToolUseId = record?.parent_tool_use_id ?? null;
    const key = `${parentToolUseId ?? ""}#${event.index}`;
    const now = this.now();
    if (event.type === "content_block_start") {
      const interrupted = this.open.get(key);
      this.open.set(key, {
        index: event.index,
        parentToolUseId,
        block: event.content_block?.type ?? "unknown",
        ...(event.content_block?.name
          ? { name: event.content_block.name }
          : {}),
        deltas: 0,
        bytes: 0,
        startedAt: now,
        reportedAt: now,
      });
      return interrupted
        ? [this.summary(interrupted, "interrupted", now), message]
        : [message];
    }
    const block = this.open.get(key);
    if (event.type === "content_block_delta") {
      if (!block) return [message];
      block.deltas++;
      block.bytes += deltaBytes(event.delta);
      if (now - block.reportedAt < progressEveryMs) return [];
      block.reportedAt = now;
      return [this.summary(block, "progress", now)];
    }
    if (event.type === "content_block_stop" && block) {
      this.open.delete(key);
      return [this.summary(block, "stop", now), message];
    }
    return [message];
  }

  /** Summaries of the blocks still streaming, for a process that ended. */
  interrupted(): StreamSummary[] {
    const now = this.now();
    const lines = [...this.open.values()].map((block) =>
      this.summary(block, "interrupted", now),
    );
    this.open.clear();
    return lines;
  }

  private summary(
    block: OpenBlock,
    end: StreamSummary["end"],
    now: number,
  ): StreamSummary {
    return {
      type: "foundry_stream_summary",
      end,
      index: block.index,
      parent_tool_use_id: block.parentToolUseId,
      block: block.block,
      ...(block.name ? { name: block.name } : {}),
      deltas: block.deltas,
      bytes: block.bytes,
      ms: now - block.startedAt,
    };
  }
}
