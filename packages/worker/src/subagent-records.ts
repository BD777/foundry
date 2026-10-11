import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";

type RecordValue = Record<string, unknown>;

/**
 * What an index keeps of a transcript: select maps one JSON line to the
 * value kept (undefined skips it) and its weight against the budget.
 */
export interface TranscriptProjection<T> {
  name: string;
  select: (line: Buffer) => { value: T; bytes: number } | undefined;
  /** Weight of all files this projection keeps, and their count. */
  budgetBytes: number;
  maxFiles: number;
}

type Index<T> = {
  inode: number;
  size: number;
  mtime: number;
  offset: number;
  tail: Buffer;
  head: Buffer;
  values: T[];
  bytes: number;
};
const indexes = new Map<string, Map<string, Index<unknown>>>();
const pending = new Map<string, Promise<unknown[]>>();

const parentToolUse = Buffer.from('"parent_tool_use_id":"');
const taskStarted = Buffer.from("task_started");
const taskNotification = Buffer.from("task_notification");

/**
 * Whether a line written by JSON.stringify can be a subagent record: one of
 * a subagent's own messages, or a task's start or notification. Most lines
 * of a long session are the main thread's and are not decoded at all.
 */
export function maybeSubagentLine(line: Buffer): boolean {
  return (
    line.includes(parentToolUse) ||
    line.includes(taskStarted) ||
    line.includes(taskNotification)
  );
}

function parseRelevant(line: Buffer): RecordValue | undefined {
  if (!maybeSubagentLine(line)) return;
  try {
    const record = JSON.parse(line.toString("utf8")) as RecordValue;
    if (!record || typeof record !== "object") return;
    if (
      record.parent_tool_use_id ||
      (record.type === "system" &&
        ["task_started", "task_notification"].includes(String(record.subtype)))
    )
      return record;
  } catch {
    /* An unfinished final JSON record will be retried on append. */
  }
}

const subagentRecords: TranscriptProjection<RecordValue> = {
  name: "records",
  select: (line) => {
    const value = parseRelevant(line);
    return value ? { value, bytes: line.length } : undefined;
  },
  budgetBytes: 32 * 1024 * 1024,
  maxFiles: 16,
};

/** Append-only transcript index. Read off the event loop and retain only the
 * records used by subagent views; streaming copies of the main answer are not
 * re-read and JSON-decoded every time a user opens the same thread. */
export function readSubagentRecords(path: string): Promise<RecordValue[]> {
  return readTranscriptProjection(path, subagentRecords);
}

/**
 * What projection keeps of the transcript at path, oldest first. Only what
 * was appended since the last read is read; a file rewritten, truncated or
 * replaced is read again from its start.
 */
export function readTranscriptProjection<T>(
  path: string,
  projection: TranscriptProjection<T>,
): Promise<T[]> {
  const key = `${projection.name}\0${path}`;
  const existing = pending.get(key);
  if (existing) return existing as Promise<T[]>;
  const promise = updateIndex(path, projection);
  pending.set(key, promise);
  void promise
    .finally(() => {
      if (pending.get(key) === promise) pending.delete(key);
    })
    .catch(() => {});
  return promise;
}

async function updateIndex<T>(
  path: string,
  projection: TranscriptProjection<T>,
): Promise<T[]> {
  let cache = indexes.get(projection.name) as Map<string, Index<T>> | undefined;
  if (!cache) {
    cache = new Map();
    indexes.set(projection.name, cache as Map<string, Index<unknown>>);
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("subagent transcript is unavailable");
    let index = cache.get(path);
    let head = index?.head ?? Buffer.alloc(0);
    if (!index || info.size !== index.size || info.mtimeMs !== index.mtime) {
      const file = await open(path, "r");
      try {
        const buffer = Buffer.alloc(Math.min(info.size, 4096));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        head = buffer.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    }
    if (
      !index ||
      index.inode !== info.ino ||
      !head.subarray(0, index.head.length).equals(index.head) ||
      info.size < index.size ||
      (info.size === index.size && info.mtimeMs !== index.mtime)
    ) {
      index = {
        inode: info.ino,
        size: 0,
        mtime: 0,
        offset: 0,
        tail: Buffer.alloc(0),
        head: Buffer.alloc(0),
        values: [],
        bytes: 0,
      };
    }
    // Refresh LRU ordering. Entries are owned by the single in-flight update.
    cache.delete(path);
    cache.set(path, index);
    if (info.size > index.offset) {
      const stream = createReadStream(path, {
        start: index.offset,
        end: info.size - 1,
        highWaterMark: 64 * 1024,
      });
      let lines = 0;
      // A line longer than a chunk is joined once, when it ends.
      let unfinished: Buffer[] = index.tail.length ? [index.tail] : [];
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        index.offset += chunk.length;
        const first = chunk.indexOf(10);
        if (first === -1) {
          unfinished.push(chunk);
          continue;
        }
        const buffer = unfinished.length
          ? Buffer.concat([...unfinished, chunk])
          : chunk;
        let start = 0,
          end = first + (buffer.length - chunk.length);
        do {
          const selected = projection.select(buffer.subarray(start, end));
          if (selected) {
            index.values.push(selected.value);
            index.bytes += selected.bytes;
          }
          start = end + 1;
          if (++lines % 256 === 0) await setImmediate();
        } while ((end = buffer.indexOf(10, start)) !== -1);
        unfinished = start < buffer.length ? [buffer.subarray(start)] : [];
      }
      index.tail = Buffer.from(Buffer.concat(unfinished));
    }
    index.size = info.size;
    index.mtime = info.mtimeMs;
    index.head = head;
    const trailing = projection.select(index.tail)?.value;
    const result =
      trailing === undefined ? [...index.values] : [...index.values, trailing];
    let bytes = [...cache.values()].reduce(
      (total, item) => total + item.bytes + item.tail.length,
      0,
    );
    while (cache.size > projection.maxFiles || bytes > projection.budgetBytes) {
      const key = cache.keys().next().value!;
      const removed = cache.get(key)!;
      bytes -= removed.bytes + removed.tail.length;
      cache.delete(key);
    }
    return result;
  } catch (error) {
    cache.delete(path);
    throw error;
  }
}
