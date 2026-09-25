/**
 * Session host: runs one workspace session inside a sandbox, started by
 * runWorkspaceSession. Reads the run from its first stdin line, then steer
 * commands; writes events, the native session id and the result as JSON
 * lines on stdout.
 */
import { createInterface } from "node:readline";
import type { AgentSession } from "@foundry/protocol";
import type { AgentProfileLocalConfig } from "../profiles.js";
import {
  closeAllActiveRuntimes,
  runClaudeWorkspaceSession,
  runCodexWorkspaceSession,
} from "../runner.js";
import {
  registerSessionAmbientEnv,
  type SessionAmbientEnv,
} from "../session-ambient.js";
import { steerActiveSession } from "../session-helpers.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";

const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const lines = createInterface({ input: process.stdin });
const parentPid = process.ppid;
const parentWatch = setInterval(() => {
  if (process.ppid === parentPid) return;
  closeAllActiveRuntimes();
  // This host owns its process group; stop tools as well as the SDK host.
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {
    process.exit(1);
  }
}, 1000);
parentWatch.unref();
lines.once("line", async (line) => {
  try {
    const input = JSON.parse(line) as {
      cwd: string;
      session: AgentSession;
      profile: AgentProfileLocalConfig;
      managedSkills?: ManagedSkillRuntime;
      ambient?: SessionAmbientEnv;
    };
    if (input.ambient)
      registerSessionAmbientEnv(input.session.id, input.ambient);
    lines.on("line", (line) => {
      void (async () => {
        let id: string | undefined;
        try {
          const command = JSON.parse(line);
          id = command.id;
          if (command.type !== "steer")
            throw new Error("Unsupported session host command");
          await steerActiveSession(input.session.id, command.message);
          output({ type: "steer_result", id });
        } catch (error) {
          output({ type: "steer_result", id, error: String(error) });
        }
      })();
    });
    const run =
      input.session.provider === "codex"
        ? runCodexWorkspaceSession
        : runClaudeWorkspaceSession;
    const result = await run(
      input.cwd,
      input.session,
      input.profile,
      async (label, detail, level = "info", metadata, message) => {
        output({ type: "event", label, detail, level, metadata, message });
      },
      async () => output({ type: "setup" }),
      (nativeSessionId) => output({ type: "native", nativeSessionId }),
      input.managedSkills,
    );
    output({ type: "result", ...result });
  } catch (error) {
    output({ type: "error", error: String(error) });
    process.exitCode = 1;
  } finally {
    lines.close();
    closeAllActiveRuntimes();
    process.stdin.destroy();
    // This process owns one execution, not a reusable chat runtime. SDK
    // telemetry/background handles must not keep a completed result running.
    // Flush the protocol before exit; the supervisor reaps remaining tools.
    process.stdout.write("", () => process.exit(process.exitCode ?? 0));
  }
});
