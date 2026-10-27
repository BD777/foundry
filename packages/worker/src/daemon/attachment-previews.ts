/** Earlier transfer of derivatives only. Interactive file reads cancel a push. */
import { isAbsolute, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ProtocolEnvelope } from "@bd777/foundry-protocol";
import { daemonRequestHeaders } from "../server-http.js";
import { serverFetch } from "../server-proxy.js";
import { AttachmentError } from "../workspace-attachments.js";
import { readAttachmentPreviewChunk } from "../image-previews.js";

type Job = {
  serverURL: string;
  path: string;
  workspaceId: string;
  retries: number;
};
const enabled = new Set<string>();
type RegisteredWorkspace = string | { id: string; path: string };
const workspaceAt = new Map<
  string,
  (root: string) => RegisteredWorkspace | undefined
>();
const jobs = new Map<string, Job>();
const pushed = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let active: { job: Job; controller: AbortController } | undefined;
let lastInteractive = 0;

export function configureAttachmentPreviewPush(
  serverURL: string,
  allow: boolean,
  lookup?: (root: string) => RegisteredWorkspace | undefined,
) {
  if (lookup) workspaceAt.set(serverURL, lookup);
  if (allow) enabled.add(serverURL);
  else {
    enabled.delete(serverURL);
    for (const [key, job] of jobs)
      if (job.serverURL === serverURL) jobs.delete(key);
    if (active?.job.serverURL === serverURL) active.controller.abort();
  }
  schedule();
}
export function noteInteractiveImageRead() {
  lastInteractive = Date.now();
  active?.controller.abort();
}
export function enqueueAttachmentPreview(
  serverURL: string,
  path: string,
  workspaceId?: string,
) {
  if (
    !enabled.has(serverURL) ||
    !isAbsolute(path) ||
    !path.includes("/.foundry/attachments/")
  )
    return;
  const root = path.slice(0, path.lastIndexOf("/.foundry/attachments/"));
  const known = workspaceAt.get(serverURL)?.(root);
  if (!known) return;
  const knownId = typeof known === "string" ? known : known.id;
  if (workspaceId && workspaceId !== knownId) return;
  if (typeof known !== "string")
    path = join(known.path, path.slice(root.length));
  const key = serverURL + "\0" + path;
  if (jobs.has(key) || active?.job.path === path || jobs.size >= 32) return;
  jobs.set(key, { serverURL, path, workspaceId: knownId, retries: 0 });
  schedule();
}
function schedule() {
  if (timer || active || jobs.size === 0) return;
  timer = setTimeout(() => {
    timer = undefined;
    void pump();
  }, 1500);
  timer.unref();
}
async function pump() {
  if (active || jobs.size === 0) return;
  if (Date.now() - lastInteractive < 10000) {
    schedule();
    return;
  }
  const [key, job] = jobs.entries().next().value!;
  jobs.delete(key);
  if (!enabled.has(job.serverURL)) {
    schedule();
    return;
  }
  const controller = new AbortController();
  active = { job, controller };
  const timeout = setTimeout(() => controller.abort(), 20000);
  timeout.unref();
  try {
    const marker = job.path.lastIndexOf("/.foundry/attachments/");
    const workspacePath = job.path.slice(0, marker);
    const workspaceId = job.workspaceId;
    for (const variant of ["placeholder", "preview"] as const) {
      controller.signal.throwIfAborted();
      let image;
      try {
        image = await readAttachmentPreviewChunk(
          {
            workspacePath,
            path: job.path,
            offset: 0,
            maxBytes: 20 * 1024 * 1024,
          },
          variant,
        );
      } catch (error) {
        if (variant === "placeholder") continue;
        throw error;
      }
      const budget = variant === "placeholder" ? 2048 : 40 * 1024;
      if (image.size > budget || image.data.length !== image.size) continue;
      const stamp = `${key}\0${image.revision}\0${variant}`;
      if ((pushed.get(stamp) || 0) > Date.now() - 4 * 60 * 1000) continue;
      const payload = {
        workspaceId,
        path: job.path,
        realPath: image.realPath,
        revision: image.revision,
        variant,
        mimeType: image.mimeType,
        dataBase64: image.data.toString("base64"),
      };
      const response = await serverFetch(
        `${job.serverURL}/api/daemon/attachment-previews`,
        {
          method: "POST",
          headers: {
            ...daemonRequestHeaders(true),
            "Content-Encoding": "gzip",
          },
          body: new Uint8Array(gzipSync(Buffer.from(JSON.stringify(payload)))),
          signal: controller.signal,
        },
      );
      await response.arrayBuffer();
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429)
          throw new Error("preview upload temporarily unavailable");
        return;
      }
      pushed.set(stamp, Date.now());
      while (pushed.size > 256) pushed.delete(pushed.keys().next().value!);
    }
  } catch (error) {
    if (
      !(error instanceof AttachmentError) &&
      enabled.has(job.serverURL) &&
      job.retries < 2
    ) {
      job.retries++;
      jobs.set(key, job);
    }
  } finally {
    clearTimeout(timeout);
    active = undefined;
    schedule();
  }
}

/** Outbox events from even an older busy execution host cross this daemon. */
export function queueEventImagePreviews(
  serverURL: string,
  envelope: ProtocolEnvelope,
) {
  if (!enabled.has(serverURL) || envelope.type !== "session_event") return;
  const event = (
    envelope.payload as { event?: Record<string, unknown> } | undefined
  )?.event;
  if (!event) return;
  const pending: unknown[] = [
    event.detail,
    event.text,
    event.content,
    event.metadata,
  ];
  let examined = 0;
  const paths = new Set<string>();
  while (pending.length && examined++ < 40) {
    const value = pending.shift();
    if (typeof value === "string") {
      if (!value.includes(".foundry/attachments/")) continue;
      for (const match of value.matchAll(
        /<image\b[^>]{0,4096}\bpath=["']([^"']+)["']/g,
      )) {
        paths.add(match[1]!);
        if (paths.size >= 8) break;
      }
      if (isAbsolute(value) && !value.includes("\n")) paths.add(value);
      for (const match of value.matchAll(
        /(\/[^\s<>"']+\/\.foundry\/attachments\/[^\s<>"']+\.(?:png|jpe?g|webp|gif))/gi,
      )) {
        paths.add(match[1]!);
        if (paths.size >= 8) break;
      }
    } else if (value && typeof value === "object")
      pending.push(...Object.values(value).slice(0, 12));
    if (paths.size >= 8) break;
  }
  for (const path of paths) enqueueAttachmentPreview(serverURL, path);
}
