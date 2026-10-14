import { createHash } from "node:crypto";
import {
  daemonMessageTypes,
  type FetchSkillRepositoryPayload,
  type ReadRepositoryRefsPayload,
  type ReadSkillContentPayload,
  type ScanSkillsPayload,
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
  const response = await fetch(`${serverURL}${uploadPath}`, {
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
  dispatch
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
