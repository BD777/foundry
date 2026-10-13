import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type WebSocket from "ws";
import {
  daemonMessageTypes,
  type WorkspaceFoldersPayload,
} from "@bd777/foundry-protocol";
import type { SessionExecutionRegistry } from "../session-state.js";
import { sendWebSocket, trySendWebSocket } from "../transport.js";
import { errorMessage, safeID } from "../utils.js";
import {
  holdsRegisteredWorkspace,
  registryWorkspaceFolders,
} from "../workspace-folders.js";
import {
  requireWorkspaceFolder,
  workspaceFolderPresent,
} from "../workspace-registration.js";
import { readForgottenWorkspaces, readRegistry } from "../workspaces.js";
import {
  daemonDeviceRegistration,
  daemonRegistration,
} from "../workspace-ops.js";
import { logTime } from "./context.js";

export type WorkspaceRegistration = ReturnType<
  typeof workspaceRegistrationWithActiveSessions
>;

/** Workspace folders found gone: each is logged once, until it is back. */
const loggedMissingFolders = new Set<string>();

export function noteMissingFolder(workspacePath: string): void {
  if (loggedMissingFolders.has(workspacePath)) return;
  loggedMissingFolders.add(workspacePath);
  console.error(
    `${logTime()} The workspace folder ${workspacePath} no longer exists; its workspace is reported missing until it is back or located.`,
  );
}

function sameFolderLists(
  left: WorkspaceFoldersPayload,
  right: WorkspaceFoldersPayload,
): boolean {
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return (
    same(left.servedWorkspaceIds, right.servedWorkspaceIds) &&
    same(left.missingWorkspaceIds, right.missingWorkspaceIds)
  );
}

function workspaceRegistrationWithActiveSessions(
  workspacePath: string,
  sessionExecutions: SessionExecutionRegistry,
): ReturnType<typeof daemonRegistration> & { activeSessionIds: string[] } {
  return {
    ...daemonRegistration(workspacePath),
    // This is an execution claim, not device presence. It survives a socket
    // reconnect because the registry is process-scoped, but it is empty after
    // a daemon restart so a replacement process cannot keep orphaned work
    // alive merely by registering the same device ID.
    activeSessionIds: sessionExecutions.activeSessionIds(),
  };
}

/**
 * The workspaces one control connection serves, those the device keeps whose
 * folder is gone, and the registrations that describe them to the server.
 */
export class WorkspaceRoster {
  private readonly workspacePaths = new Map<string, string>();
  // Workspaces whose registration the server got on this connection.
  private readonly announcedWorkspaceIds = new Set<string>();
  // The served and missing lists the server last heard (hello included).
  private reportedFolders: WorkspaceFoldersPayload | undefined;
  /** Whether the server takes workspace_folders news at all. */
  serverTakesFolders = false;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    /** The folder the daemon was started with; "" without one. */
    private readonly daemonWorkspacePath: string,
    private readonly sessionExecutions: SessionExecutionRegistry,
  ) {}

  /** Folder checks stop with the connection. */
  close(): void {
    this.closed = true;
  }

  registration(workspacePath: string): WorkspaceRegistration {
    return workspaceRegistrationWithActiveSessions(
      workspacePath,
      this.sessionExecutions,
    );
  }

  deviceRegistration() {
    return {
      ...daemonDeviceRegistration(),
      activeSessionIds: this.sessionExecutions.activeSessionIds(),
    };
  }

  /**
   * The registration a reply carries: the daemon's first workspace, or the
   * device alone while it has none. A folder the person removed is never
   * it, not even the one the daemon was started with.
   */
  currentRegistration() {
    // A registered folder can vanish (e.g. a test's temp folder); describe
    // the device with one that still exists rather than fail.
    const workspacePath = this.knownPaths().find((path) => existsSync(path));
    return workspacePath
      ? this.registration(workspacePath)
      : this.deviceRegistration();
  }

  register(registration: ReturnType<typeof daemonRegistration>): void {
    this.workspacePaths.set(
      registration.workspace.id,
      registration.workspace.localPath,
    );
    this.announcedWorkspaceIds.add(registration.workspace.id);
    loggedMissingFolders.delete(registration.workspace.localPath);
  }

  /**
   * A workspace the device keeps whose folder is gone: it is known here
   * (an operation on it gets a clear refusal) but not served.
   */
  trackMissing(workspaceId: string, path: string): void {
    if (!this.workspacePaths.has(workspaceId))
      this.workspacePaths.set(workspaceId, path);
  }

  unregister(workspaceId: string, workspacePath: string): void {
    const normalizedPath = workspacePath ? resolve(workspacePath) : "";
    if (workspaceId) {
      this.workspacePaths.delete(workspaceId);
    }
    if (normalizedPath) {
      for (const [id, path] of [...this.workspacePaths.entries()]) {
        if (resolve(path) === normalizedPath) {
          this.workspacePaths.delete(id);
          this.announcedWorkspaceIds.delete(id);
        }
      }
    }
    if (workspaceId) this.announcedWorkspaceIds.delete(workspaceId);
  }

  /** The folder the workspace was last known at, present or not. */
  knownPath(workspaceId: string): string | undefined {
    return this.workspacePaths.get(workspaceId);
  }

  /** Folders of the workspaces known here, each once. */
  folders(): string[] {
    return [...new Set(this.workspacePaths.values())];
  }

  pathFor(workspaceId: string): string {
    const workspacePath = this.workspacePaths.get(workspaceId);
    if (!workspacePath) {
      throw new Error(
        `workspace ${workspaceId} is not registered in this local daemon`,
      );
    }
    return workspacePath;
  }

  /**
   * The workspace's folder for an operation that works in it, or the clear
   * refusal when the folder is gone; the server then hears at once that
   * the workspace is missing.
   */
  folderFor(workspaceId: string): string {
    const workspacePath = this.pathFor(workspaceId);
    try {
      return requireWorkspaceFolder(workspacePath);
    } catch (error) {
      this.checkFolders();
      throw error;
    }
  }

  /**
   * The hello's lists: the served registrations, and the workspaces the
   * device keeps whose folder is gone, refused clearly until located.
   */
  helloFolders(
    registrations: ReadonlyArray<{ workspace: { id: string } }>,
  ): WorkspaceFoldersPayload {
    const servedIds = new Set(registrations.map((item) => item.workspace.id));
    const missingIds = new Set<string>();
    for (const entry of registryWorkspaceFolders()) {
      if (entry.present || servedIds.has(entry.id)) continue;
      this.trackMissing(entry.id, entry.path);
      missingIds.add(entry.id);
    }
    this.reportedFolders = {
      servedWorkspaceIds: [...servedIds].sort(),
      missingWorkspaceIds: [...missingIds].sort(),
    };
    return this.reportedFolders;
  }

  /** What the device serves and what it keeps without a folder. */
  private folderLists(): WorkspaceFoldersPayload {
    const served = new Set<string>();
    const missing = new Set<string>();
    for (const [id, path] of this.workspacePaths) {
      if (!workspaceFolderPresent(path)) missing.add(id);
      else if (this.announcedWorkspaceIds.has(id)) served.add(id);
    }
    for (const entry of registryWorkspaceFolders())
      if (!entry.present && !served.has(entry.id)) missing.add(entry.id);
    return {
      servedWorkspaceIds: [...served].sort(),
      missingWorkspaceIds: [...missing].sort(),
    };
  }

  /**
   * Run every round of the native chat timer (cheap: a stat per
   * workspace). A registry workspace whose folder came back is registered
   * again, as at hello; a server that takes it hears whenever the served
   * or missing lists change.
   */
  checkFolders(): void {
    if (this.closed || !this.reportedFolders) return;
    for (const entry of registryWorkspaceFolders()) {
      if (!entry.present) {
        noteMissingFolder(entry.path);
        this.trackMissing(entry.id, entry.path);
        continue;
      }
      if (this.announcedWorkspaceIds.has(entry.id)) continue;
      if (!holdsRegisteredWorkspace(entry)) continue;
      try {
        const registration = this.registration(entry.path);
        this.register(registration);
        console.log(
          `${logTime()} The workspace folder ${entry.path} is back; serving ${registration.workspace.name} again.`,
        );
        sendWebSocket(
          this.socket,
          daemonMessageTypes.workspaceReady,
          { registration },
          `workspace_ready_${safeID(registration.workspace.id)}_${Date.now()}`,
        );
      } catch (error) {
        console.error(
          `Serving the workspace at ${entry.path} again failed: ${errorMessage(error)}`,
        );
      }
    }
    for (const [, path] of this.workspacePaths)
      if (!workspaceFolderPresent(path)) noteMissingFolder(path);
      else loggedMissingFolders.delete(path);
    if (!this.serverTakesFolders) return;
    const lists = this.folderLists();
    if (sameFolderLists(lists, this.reportedFolders)) return;
    if (
      trySendWebSocket(this.socket, daemonMessageTypes.workspaceFolders, lists)
    )
      this.reportedFolders = lists;
  }

  knownPaths(): string[] {
    const forgotten = readForgottenWorkspaces();
    const paths = [
      ...(this.daemonWorkspacePath ? [resolve(this.daemonWorkspacePath)] : []),
      ...readRegistry().map((entry) => resolve(entry.path)),
    ];
    return [...new Set(paths)].filter(
      (workspacePath) =>
        !forgotten.some(
          (entry) =>
            resolve(entry.path) === workspacePath ||
            (entry.id && this.workspacePaths.get(entry.id) === workspacePath),
        ),
    );
  }
}
