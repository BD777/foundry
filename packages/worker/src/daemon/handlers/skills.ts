import { serverFetch } from "../../server-proxy.js";
import { dirname } from "node:path";
import { SkillPrewarmer } from "../../skill-prewarm.js";
import type WebSocket from "ws";
import { readVerifiedSkillSnapshot } from "../../skill-snapshots.js";
import { packZip } from "../../skill-zip.js";
import type { WorkspaceDraftSkill } from "@bd777/foundry-protocol";
import { join } from "node:path";
import { ExecutionStore } from "../../execution-storage.js";
import { scanWorkspaceDraftsFromRefs } from "../../workspace-draft-scan-thread.js";
import { createHash } from "node:crypto";
import {
  daemonMessageTypes,
  type FetchSkillRepositoryPayload,
  type ReadRepositoryRefsPayload,
  type ReadSkillContentPayload,
  type ScanSkillsPayload,
  type PrepareSkillsPayload,
} from "@bd777/foundry-protocol";
import { recordActivity } from "../../diagnostics.js";
import {
  installTool,
  managedToolVersions,
  runToolSetup,
  type ToolSpec,
} from "../../managed-tools.js";
import {
  fetchSkillRepository,
  readRepositoryRefs,
} from "../../skill-repository-fetch.js";
import { checkPrograms } from "../../skill-requirements.js";
import { scanDeviceSkills } from "../../skill-scan-thread.js";
import {
  packageSkillDirectory,
  readSkillTextFile,
} from "../../skill-scanner.js";
import { beginActivity, duringActivity } from "../../stall-monitor.js";
import { daemonRequestHeaders } from "../../server-http.js";
import { sendWebSocket, trySendWebSocket } from "../../transport.js";
import { reply, type DaemonDispatch } from "../dispatch.js";
import { errorMessage } from "../../utils.js";

/**
 * Posts a repository's files for a fetch the server asked for; the server
 * takes them only from this device, for that fetch.
 */
async function uploadRepositoryFiles(
  serverURL: string,
  uploadPath: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  if (
    !/^\/api\/daemon\/skill-repository-fetches\/[A-Za-z0-9-]+$/.test(uploadPath)
  )
    throw new Error("the server named an unexpected upload address");
  const response = await serverFetch(`${serverURL}${uploadPath}`, {
    method: "POST",
    headers: { ...daemonRequestHeaders(false), "Content-Type": contentType },
    body: new Uint8Array(body),
  });
  if (!response.ok)
    throw new Error(
      `uploading the files returned ${response.status}: ${await response.text()}`,
    );
}

/**
 * A scan answer with its digest, or only the digest when the server says it
 * keeps an answer with that digest (knownDigest): the skills that did not
 * change are not sent again over a slow uplink on every reconnect.
 */
export function scanAnswer(
  answer: Record<string, unknown>,
  knownDigest: unknown,
): Record<string, unknown> {
  const digest = createHash("sha256")
    .update(JSON.stringify(answer))
    .digest("base64url")
    .slice(0, 32);
  return digest === knownDigest
    ? { unchanged: true, digest }
    : { ...answer, digest };
}

/** Skills on the device and in repositories, and the tools they need. */
export function registerSkillHandlers(dispatch: DaemonDispatch): void {
  const warmers = new WeakMap<WebSocket, SkillPrewarmer>();
  dispatch
    .on(daemonMessageTypes.prepareSkills, (envelope, ctx) => {
      const payload = envelope.payload as PrepareSkillsPayload;
      if (!Array.isArray(payload?.refs)) return;
      let warmer = warmers.get(ctx.socket);
      if (!warmer) {
        warmer = new SkillPrewarmer();
        warmers.set(ctx.socket, warmer);
        const current = warmer;
        ctx.socket.once("close", () => current.stop());
      }
      warmer.update(payload.refs, ctx.serverURL);
    })
    .on(daemonMessageTypes.exportDraftSkill, (envelope, ctx) =>
      reply(ctx, envelope, daemonMessageTypes.draftSkillExported, () => {
        const draft = envelope.payload as WorkspaceDraftSkill;
        ctx.roster.folderFor(draft.workspaceId);
        if (!draft.snapshotPath || !draft.snapshotDigest)
          throw new Error("Draft snapshot is unavailable.");
        const archive = packZip(
          readVerifiedSkillSnapshot(
            draft.snapshotRoot ?? dirname(draft.snapshotPath),
            draft.snapshotDigest,
          ),
        );
        if (archive.length > 64 * 1024 * 1024)
          throw new Error("Draft transfer exceeds 64 MiB.");
        return {
          id: draft.id,
          digest: draft.digest,
          archiveBase64: archive.toString("base64"),
          checksum: createHash("sha256").update(archive).digest("hex"),
        };
      }),
    )
    .on(daemonMessageTypes.refreshWorkspaceSkills, (envelope, ctx) => {
      const request = envelope.payload as {
        workspaceId: string;
        issueId?: string;
        libraryRefs?: import("@bd777/foundry-protocol").SessionSkillRef[];
      };
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceSkillsRefreshed,
        async () => {
          let path = ctx.roster.folderFor(request.workspaceId);
          let storageRoot: string | undefined;
          if (request.issueId) {
            const environment = new ExecutionStore().environment(
              request.workspaceId,
              request.issueId,
            );
            if (!environment)
              throw new Error(
                "Issue candidate is unavailable; draft refresh cannot use the source workspace.",
              );
            path = environment.cwd;
            storageRoot = join(environment.directory, "references", "drafts");
          }
          return {
            enabled: true,
            supported: true,
            scannedAt: new Date().toISOString(),
            skills: await scanWorkspaceDraftsFromRefs(
              [
                request.workspaceId,
                request.issueId
                  ? `issue:${request.issueId}`
                  : request.workspaceId,
                path,
                storageRoot,
              ],
              request.libraryRefs ?? [],
              ctx.serverURL,
            ),
          };
        },
      );
    })
    .on(daemonMessageTypes.readRepositoryRefs, (envelope, ctx) =>
      reply(ctx, envelope, daemonMessageTypes.repositoryRefsRead, () =>
        readRepositoryRefs(envelope.payload as ReadRepositoryRefsPayload),
      ),
    )
    .on(daemonMessageTypes.fetchSkillRepository, (envelope, ctx) => {
      const request = envelope.payload as FetchSkillRepositoryPayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.skillRepositoryFetched,
        () =>
          fetchSkillRepository(request, (body, contentType) =>
            uploadRepositoryFiles(
              ctx.serverURL,
              request.uploadPath,
              body,
              contentType,
            ),
          ),
      );
    })
    .on(daemonMessageTypes.installTool, (envelope, ctx) => {
      const payload = envelope.payload as
        { tool?: ToolSpec; step?: string } | undefined;
      const tool = payload?.tool;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.toolInstalled,
        async () => {
          if (!tool) throw new Error("no tool to install");
          const done =
            payload?.step === "setup"
              ? await runToolSetup(tool)
              : await installTool(tool);
          return {
            name: done.name,
            version: done.version,
            ...("output" in done ? { output: done.output } : {}),
          };
        },
      );
    })
    .on(daemonMessageTypes.scanSkills, (envelope, ctx) => {
      const payload = envelope.payload as ScanSkillsPayload | undefined;
      const roots = Array.isArray(payload?.roots)
        ? payload.roots.filter(
            (root): root is string => typeof root === "string",
          )
        : [];
      const scanStarted = Date.now();
      void duringActivity("skill scan", () => scanDeviceSkills(roots))
        .then((skills) => {
          recordActivity("skillScan", scanStarted, { count: skills.length });
          const end = beginActivity("skill scan reply");
          try {
            trySendWebSocket(
              ctx.socket,
              daemonMessageTypes.skillsScanned,
              scanAnswer(
                {
                  skills,
                  tools: checkPrograms(payload?.tools),
                  toolVersions: managedToolVersions(),
                },
                payload?.knownDigest,
              ),
              envelope.id,
            );
          } finally {
            end();
          }
        })
        .catch((error: unknown) => {
          recordActivity("skillScan", scanStarted, { error });
          trySendWebSocket(
            ctx.socket,
            daemonMessageTypes.skillsScanned,
            { error: errorMessage(error) },
            envelope.id,
          );
        });
    })
    .on(daemonMessageTypes.readSkillFile, (envelope, ctx) => {
      const payload = envelope.payload as {
        root: string;
        dirName: string;
        path: string;
      };
      return reply(ctx, envelope, daemonMessageTypes.skillFileRead, () =>
        readSkillTextFile(payload.root, payload.dirName, payload.path),
      );
    })
    .on(daemonMessageTypes.readSkillContent, (envelope, ctx) => {
      const payload = envelope.payload as ReadSkillContentPayload | undefined;
      const root = payload?.root;
      const dirName = payload?.dirName;
      if (!root || !dirName) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.skillContentRead,
          { error: "read_skill_content requires root and dirName" },
          envelope.id,
        );
        return;
      }
      return reply(ctx, envelope, daemonMessageTypes.skillContentRead, () =>
        packageSkillDirectory(root, dirName),
      );
    });
}
