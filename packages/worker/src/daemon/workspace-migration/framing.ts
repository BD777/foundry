/**
 * The byte framing two workers speak over a migration stream (DEV-146):
 * `u32 payload length (big endian) + u8 kind + payload`, a payload at most
 * 1 MiB. JSON kinds carry UTF-8 JSON; DATA carries raw file bytes.
 */

import type { Readable, Writable } from "node:stream";

export const frameKinds = {
  hello: 1,
  manifest: 2,
  manifestEnd: 3,
  need: 4,
  needEnd: 5,
  fileBegin: 6,
  data: 7,
  fileEnd: 8,
  /** The source could not read a file it was asked for. */
  fileFail: 9,
  done: 10,
  ack: 11,
  /** Either side gives up; the payload names why. */
  error: 12,
} as const;

export type FrameKind = (typeof frameKinds)[keyof typeof frameKinds];

export const maxFramePayload = 1024 * 1024;
const headerBytes = 5;

export interface Frame {
  kind: number;
  payload: Buffer;
}

export class MigrationPeerError extends Error {}

export function encodeFrame(kind: number, payload: Buffer): Buffer {
  if (payload.length > maxFramePayload)
    throw new Error(`Frame payload of ${payload.length} bytes is too large`);
  const header = Buffer.allocUnsafe(headerBytes);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt8(kind, 4);
  return Buffer.concat([header, payload]);
}

function waitForDrain(stream: Writable): Promise<void> {
  return new Promise((resolveDrain, rejectDrain) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolveDrain();
    };
    const onError = (error: Error) => {
      cleanup();
      rejectDrain(error);
    };
    const onClose = () => {
      cleanup();
      rejectDrain(new Error("The migration stream closed"));
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

/** Writes one frame, waiting while the stream is full (backpressure). */
export async function writeFrame(
  stream: Writable,
  kind: number,
  payload: Buffer | object = Buffer.alloc(0),
): Promise<void> {
  if (stream.destroyed || stream.writableEnded)
    throw new Error("The migration stream closed");
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(JSON.stringify(payload));
  if (!stream.write(encodeFrame(kind, body))) await waitForDrain(stream);
}

/** Reads frames off a byte stream, whatever its chunking. */
export class FrameReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  /** Takes count bytes off the front, copying only what it takes. */
  private take(count: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= count) {
      const taken = first.subarray(0, count);
      if (first.length === count) this.chunks.shift();
      else this.chunks[0] = first.subarray(count);
      this.buffered -= count;
      return taken;
    }
    const taken = Buffer.allocUnsafe(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.chunks[0]!;
      const part = Math.min(chunk.length, count - filled);
      chunk.copy(taken, filled, 0, part);
      filled += part;
      if (part === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(part);
    }
    this.buffered -= count;
    return taken;
  }

  private peekHeader(): { size: number; kind: number } {
    if (this.chunks[0]!.length < headerBytes) {
      const header = this.take(headerBytes);
      this.chunks.unshift(header);
      this.buffered += headerBytes;
    }
    const first = this.chunks[0]!;
    return { size: first.readUInt32BE(0), kind: first.readUInt8(4) };
  }

  /** The next frame; undefined when the stream ended between frames. */
  async next(): Promise<Frame | undefined> {
    for (;;) {
      if (this.buffered >= headerBytes) {
        const { size, kind } = this.peekHeader();
        if (size > maxFramePayload)
          throw new Error(`Frame payload of ${size} bytes is too large`);
        if (this.buffered >= headerBytes + size) {
          const frame = this.take(headerBytes + size);
          return { kind, payload: Buffer.from(frame.subarray(headerBytes)) };
        }
      }
      const { value, done } = await this.iterator.next();
      if (done) {
        if (this.buffered > 0)
          throw new Error("The migration stream ended inside a frame");
        return undefined;
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.length === 0) continue;
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
  }

  /** The next frame, which must be there; an ERROR frame is thrown. */
  async expect(): Promise<Frame> {
    const frame = await this.next();
    if (!frame) throw new Error("The migration stream ended early");
    if (frame.kind === frameKinds.error)
      throw new MigrationPeerError(
        `The other device gave up: ${String(
          (jsonPayload(frame) as { message?: unknown }).message ?? "unknown",
        )}`,
      );
    return frame;
  }
}

export function jsonPayload(frame: Frame): unknown {
  try {
    return JSON.parse(frame.payload.toString("utf8")) as unknown;
  } catch {
    throw new Error(`Frame of kind ${frame.kind} is not JSON`);
  }
}
