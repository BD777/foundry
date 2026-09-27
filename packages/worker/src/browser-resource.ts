// The browser a session can use: a pinned Playwright MCP server the session
// runtime attaches like the Foundry tools. The browser starts on the first
// tool call, keeps its profile in memory (isolated per session) and closes
// when idle; the MCP server ends with the agent process that owns it.
// Screenshots land in the workspace attachments, where the web shows them
// through the device (docs/architecture-modules.md §5.6).
//
// The browser binary belongs to the resource too: it lives in the device's
// Foundry state, independent of any session's HOME, and is installed once by
// the worker before sessions are offered the tool.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { AgentSession } from "@foundry/protocol";
import { foundryStatePath } from "./state-root.js";

/** Playwright MCP takes milliseconds; the next tool call relaunches it. */
const idleTimeoutMs = 5 * 60 * 1000;

export interface BrowserMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Where screenshots and page snapshots of this session are written. */
  outputDir: string;
}

interface PlaywrightMcpPackage {
  cli: string;
  version: string;
}

function playwrightMcp(): PlaywrightMcpPackage {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@playwright/mcp/package.json");
  const manifest = require(manifestPath) as {
    bin: Record<string, string>;
    version: string;
  };
  return {
    cli: resolve(
      dirname(manifestPath),
      manifest.bin["playwright-mcp"] ?? "cli.js",
    ),
    version: manifest.version,
  };
}

function browsersPath(): string {
  return foundryStatePath("browsers");
}

/** Written after an install completes, per Playwright MCP version. */
function installedMarker(): string {
  return resolve(browsersPath(), `.installed-${playwrightMcp().version}`);
}

export function browserInstalled(): boolean {
  return existsSync(installedMarker());
}

let installing: Promise<void> | undefined;

/**
 * Installs the browser this Playwright MCP version drives, once per device
 * and version. Concurrent callers share one install.
 */
export function ensureBrowserInstalled(): Promise<void> {
  if (browserInstalled()) return Promise.resolve();
  installing ??= new Promise<void>((done, fail) => {
    mkdirSync(browsersPath(), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        playwrightMcp().cli,
        "install-browser",
        "chromium",
        "--no-shell",
        "--no-progress",
      ],
      {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath() },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", fail);
    child.on("close", (code) => {
      if (code === 0) {
        writeFileSync(installedMarker(), new Date().toISOString());
        done();
      } else {
        fail(
          new Error(
            `browser install exited ${code}: ${stderr.trim().slice(-500)}`,
          ),
        );
      }
    });
  }).finally(() => {
    installing = undefined;
  });
  return installing;
}

/** The browser server for one session of a workspace. */
export function browserMcpServer(
  session: Pick<AgentSession, "id">,
  workspacePath: string,
): BrowserMcpServer {
  const outputDir = resolve(
    workspacePath,
    ".foundry",
    "attachments",
    "browser",
    session.id,
  );
  return {
    command: process.execPath,
    outputDir,
    env: { PLAYWRIGHT_BROWSERS_PATH: browsersPath() },
    args: [
      playwrightMcp().cli,
      "--browser",
      "chromium",
      "--headless",
      "--isolated",
      "--idle-timeout",
      String(idleTimeoutMs),
      "--output-dir",
      outputDir,
      // Chromium's own sandbox needs unprivileged user namespaces, which many
      // Linux hosts disable; Chat sessions are not in Foundry's sandbox either.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ],
  };
}
