import type { QueuedDraft } from "./conversation-types";

/**
 * Browser persistence for what a person has typed but the server does not
 * have yet: the composer draft and the queued messages of each conversation.
 * One localStorage entry per conversation, `${prefix}:${threadKey}`.
 */
export const conversationStoragePrefixes = {
  chat: "foundry.chat-composer",
  // Issue drafts kept this key before queues were stored; plain-text values
  // written then still read as a draft.
  issue: "foundry.issue-draft",
} as const;
export type ConversationStoragePrefix =
  (typeof conversationStoragePrefixes)[keyof typeof conversationStoragePrefixes];

export interface StoredConversation {
  draft: string;
  queue: QueuedDraft[];
  updatedAt: number;
}

const entryVersion = 1;
export const conversationStorageLimits = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 100,
  /** UTF-16 characters of one serialized entry (~1 MB). */
  maxEntryChars: 500_000,
};

let generation = 0;

/** Increments whenever stored conversations are wiped; older writes are dropped. */
export function conversationStorageGeneration(): number {
  return generation;
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function conversationStorageKey(
  prefix: ConversationStoragePrefix | undefined,
  threadKey: string,
): string | undefined {
  return prefix ? `${prefix}:${threadKey}` : undefined;
}

/**
 * A composer's runtime choice (agent, model, effort) per conversation, kept
 * beside its draft so queued messages restored after a reload go out as they
 * were chosen. Pruned and cleared with the drafts.
 */
const runtimeChoicePrefix = "foundry.composer-runtime";

function isConversationKey(key: string): boolean {
  return [
    ...Object.values(conversationStoragePrefixes),
    runtimeChoicePrefix,
  ].some((prefix) => key.startsWith(`${prefix}:`));
}

function parseEntry(raw: string): StoredConversation {
  try {
    const value = JSON.parse(raw) as Partial<StoredConversation> & {
      v?: number;
    };
    if (value && typeof value === "object" && value.v === entryVersion) {
      return {
        draft: typeof value.draft === "string" ? value.draft : "",
        queue: Array.isArray(value.queue)
          ? value.queue.filter(
              (item): item is QueuedDraft =>
                Boolean(item) &&
                typeof item.id === "string" &&
                typeof item.text === "string",
            )
          : [],
        updatedAt:
          typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
      };
    }
  } catch {
    /* A plain-text draft from before entries were JSON. */
  }
  return { draft: raw, queue: [], updatedAt: Date.now() };
}

/** The stored entry, an empty one when absent, or undefined when storage is unusable. */
export function readConversation(key: string): StoredConversation | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    const raw = store.getItem(key);
    return raw === null
      ? { draft: "", queue: [], updatedAt: 0 }
      : parseEntry(raw);
  } catch {
    return undefined;
  }
}

function storedEntries(store: Storage) {
  const entries: { key: string; updatedAt: number }[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (!key || !isConversationKey(key)) continue;
    const raw = store.getItem(key);
    entries.push({ key, updatedAt: raw ? parseEntry(raw).updatedAt : 0 });
  }
  return entries.sort((left, right) => left.updatedAt - right.updatedAt);
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

/**
 * Writes the entry, deleting it once it holds nothing. A full storage evicts
 * the oldest other conversations once before giving up. Returns whether the
 * entry is stored; the caller keeps it in memory either way.
 */
export function writeConversation(
  key: string,
  value: Pick<StoredConversation, "draft" | "queue">,
): boolean {
  const store = storage();
  if (!store) return false;
  try {
    if (!value.draft && !value.queue.length) {
      store.removeItem(key);
      return true;
    }
    const raw = JSON.stringify({
      v: entryVersion,
      updatedAt: Date.now(),
      draft: value.draft,
      queue: value.queue,
    });
    if (raw.length > conversationStorageLimits.maxEntryChars) return false;
    try {
      store.setItem(key, raw);
    } catch (error) {
      if (!isQuotaError(error)) return false;
      const others = storedEntries(store).filter((entry) => entry.key !== key);
      others
        .slice(0, Math.max(1, Math.ceil(others.length / 2)))
        .forEach((entry) => store.removeItem(entry.key));
      store.setItem(key, raw);
    }
    return true;
  } catch {
    return false;
  }
}

/** Read-modify-write of one entry; the storage value wins over stale memory. */
export function updateConversation(
  key: string,
  change: (current: StoredConversation) => Partial<StoredConversation>,
): boolean {
  const current = readConversation(key);
  if (!current) return false;
  return writeConversation(key, { ...current, ...change(current) });
}

export function forgetConversation(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* Storage may be unavailable. */
  }
}

/** Drops entries older than the age limit, then the oldest beyond the count limit. */
export function pruneConversationStorage(now = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    const entries = storedEntries(store);
    const expired = entries.filter(
      (entry) => now - entry.updatedAt > conversationStorageLimits.maxAgeMs,
    );
    const kept = entries.filter((entry) => !expired.includes(entry));
    const excess = kept.slice(
      0,
      Math.max(0, kept.length - conversationStorageLimits.maxEntries),
    );
    [...expired, ...excess].forEach((entry) => store.removeItem(entry.key));
  } catch {
    /* Storage may be unavailable. */
  }
}

export interface StoredRuntimeChoice {
  value: unknown;
  updatedAt: number;
}

/** The stored runtime choice of a conversation; its shape is the caller's to check. */
export function readRuntimeChoice(
  threadKey: string,
): StoredRuntimeChoice | undefined {
  try {
    const raw = storage()?.getItem(`${runtimeChoicePrefix}:${threadKey}`);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as Partial<StoredRuntimeChoice> & {
      v?: number;
    };
    return entry?.v === entryVersion && typeof entry.updatedAt === "number"
      ? { value: entry.value, updatedAt: entry.updatedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeRuntimeChoice(threadKey: string, value: unknown): void {
  try {
    storage()?.setItem(
      `${runtimeChoicePrefix}:${threadKey}`,
      JSON.stringify({ v: entryVersion, updatedAt: Date.now(), value }),
    );
  } catch {
    /* Storage may be unavailable or full; the choice stays in memory. */
  }
}

/** A new conversation's choice follows it to the id its first message gave it. */
export function moveRuntimeChoice(from: string, to: string): void {
  const store = storage();
  if (!store || from === to) return;
  try {
    const raw = store.getItem(`${runtimeChoicePrefix}:${from}`);
    if (raw === null) return;
    store.setItem(`${runtimeChoicePrefix}:${to}`, raw);
    store.removeItem(`${runtimeChoicePrefix}:${from}`);
  } catch {
    /* Storage may be unavailable. */
  }
}

/** Signing out removes every stored draft and queued message on this browser. */
export function clearConversationStorage(): void {
  generation += 1;
  const store = storage();
  if (!store) return;
  try {
    storedEntries(store).forEach((entry) => store.removeItem(entry.key));
  } catch {
    /* Storage may be unavailable. */
  }
}

/*
 * Cross-tab coordination. Web Locks elect one tab per conversation to drain
 * its queue, and a lock held for the length of each request tells the other
 * tabs whether a claimed message is still being sent. Without Web Locks every
 * tab dispatches, and the claim written to storage before each request keeps
 * a second tab from sending the same message.
 */
const claimTimeoutMs = 2 * 60 * 1000;

function lockManager(): LockManager | undefined {
  try {
    return globalThis.navigator?.locks ?? undefined;
  } catch {
    return undefined;
  }
}

function sendLockName(id: string): string {
  return `foundry.conversation-send:${id}`;
}

/**
 * Holds this conversation's dispatch lock until the returned release runs.
 * `onAcquired` runs at once without Web Locks: every tab may then dispatch.
 */
export function holdDispatchLock(
  key: string,
  onAcquired: () => void,
): () => void {
  const locks = lockManager();
  if (!locks) {
    onAcquired();
    return () => undefined;
  }
  const controller = new AbortController();
  let release: (() => void) | undefined;
  let released = false;
  locks
    .request(
      `foundry.conversation-dispatch:${key}`,
      { signal: controller.signal },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          if (released) resolve();
          else onAcquired();
        }),
    )
    .catch(() => {
      /* Aborted while waiting: another tab kept the conversation. */
    });
  return () => {
    released = true;
    controller.abort();
    release?.();
  };
}

/** Runs one queued message's request while other tabs can see it is in flight. */
export async function whileSending<T>(
  id: string,
  run: () => Promise<T>,
): Promise<T> {
  const locks = lockManager();
  if (!locks) return run();
  return await locks.request(sendLockName(id), run);
}

/** Whether a claimed message is still being sent by a live tab. */
export async function claimIsLive(item: QueuedDraft): Promise<boolean> {
  if (!item.sending) return false;
  const locks = lockManager();
  if (!locks) return Date.now() - item.sending.at < claimTimeoutMs;
  try {
    const { held = [] } = await locks.query();
    return held.some((lock) => lock.name === sendLockName(item.id));
  } catch {
    return Date.now() - item.sending.at < claimTimeoutMs;
  }
}

export type QueueClaim =
  | { result: "claimed" | "unstored" }
  | { result: "gone" }
  | { result: "elsewhere"; item: QueuedDraft };

/**
 * Marks a queued message as being sent by `tab`, unless it was already sent
 * (gone) or another tab claimed it first. "unstored" means storage is
 * unusable here, so only this tab knows the message.
 */
export function claimQueuedDraft(
  key: string,
  id: string,
  tab: string,
  force = false,
): QueueClaim {
  const current = readConversation(key);
  if (!current) return { result: "unstored" };
  const item = current.queue.find((entry) => entry.id === id);
  if (!item) return { result: "gone" };
  if (item.sending && item.sending.tab !== tab && !force)
    return { result: "elsewhere", item };
  const claimed = writeConversation(key, {
    ...current,
    queue: current.queue.map((entry) =>
      entry.id === id ? { ...entry, sending: { tab, at: Date.now() } } : entry,
    ),
  });
  return { result: claimed ? "claimed" : "unstored" };
}
