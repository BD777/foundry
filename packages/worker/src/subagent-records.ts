import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";

type RecordValue = Record<string, unknown>;
type Index = {
  inode: number;
  size: number;
  mtime: number;
  offset: number;
  tail: Buffer;
  head: Buffer;
  records: RecordValue[];
  bytes: number;
};
const indexes = new Map<string, Index>();
const pending = new Map<string, Promise<RecordValue[]>>();
const cacheBudget = 32 * 1024 * 1024;

function parseRelevant(line: Buffer): RecordValue | undefined {
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

/** Append-only transcript index. Read off the event loop and retain only the
 * records used by subagent views; streaming copies of the main answer are not
 * re-read and JSON-decoded every time a user opens the same thread. */
export function readSubagentRecords(path: string): Promise<RecordValue[]> {
  const existing = pending.get(path);
  if (existing) return existing;
  const promise = updateIndex(path);
  pending.set(path, promise);
  void promise
    .finally(() => {
      if (pending.get(path) === promise) pending.delete(path);
    })
    .catch(() => {});
  return promise;
}

async function updateIndex(path: string): Promise<RecordValue[]> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("subagent transcript is unavailable");
    let index = indexes.get(path);
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
        records: [],
        bytes: 0,
      };
    }
    // Refresh LRU ordering. Entries are owned by the single in-flight update.
    indexes.delete(path);
    indexes.set(path, index);
    if (info.size > index.offset) {
      const stream = createReadStream(path, {
        start: index.offset,
        end: info.size - 1,
        highWaterMark: 64 * 1024,
      });
      let lines = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.concat([index.tail, chunk]);
        let start = 0,
          end;
        while ((end = buffer.indexOf(10, start)) !== -1) {
          const line = buffer.subarray(start, end);
          const record = parseRelevant(line);
          if (record) {
            index.records.push(record);
            index.bytes += line.length;
          }
          start = end + 1;
          if (++lines % 256 === 0) await setImmediate();
        }
        index.tail = Buffer.from(buffer.subarray(start));
        index.offset += chunk.length;
      }
    }
    index.size = info.size;
    index.mtime = info.mtimeMs;
    index.head = head;
    const trailing = parseRelevant(index.tail);
    const result = trailing ? [...index.records, trailing] : [...index.records];
    let bytes = [...indexes.values()].reduce(
      (total, item) => total + item.bytes + item.tail.length,
      0,
    );
    while (indexes.size > 16 || bytes > cacheBudget) {
      const key = indexes.keys().next().value!;
      const removed = indexes.get(key)!;
      bytes -= removed.bytes + removed.tail.length;
      indexes.delete(key);
    }
    return result;
  } catch (error) {
    indexes.delete(path);
    throw error;
  }
}
