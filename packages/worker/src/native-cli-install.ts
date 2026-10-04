import { spawn } from "node:child_process";
import type { NativeCliInstallResult } from "@bd777/foundry-protocol";
import { clearNativeLoginHealth } from "./native-login.js";
import { nativeCli, nativeCliInstallCommands } from "./native-cli.js";

const logLimit = 200_000;
const timeoutMs = 10 * 60_000;

/**
 * Run the official installer for a runtime's program on this device, at the
 * person's request. FOUNDRY_NATIVE_CLI_INSTALL_COMMAND replaces the command
 * for tests.
 */
export async function installNativeCli(
  runtime: "claude" | "codex",
): Promise<NativeCliInstallResult> {
  const command =
    process.env.FOUNDRY_NATIVE_CLI_INSTALL_COMMAND?.trim() ||
    nativeCliInstallCommands[runtime];
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return {
      runtime,
      ok: false,
      command,
      log: `Installing from Foundry is supported on macOS and Linux. Run the official installer on this device yourself: ${command}`,
    };
  }
  const { ok, log } = await new Promise<{ ok: boolean; log: string }>(
    (done) => {
      let output = "";
      const append = (chunk: Buffer) => {
        if (output.length < logLimit) output += chunk.toString("utf8");
      };
      const child = spawn("/bin/sh", ["-c", command], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        output += `\nStopped after ${timeoutMs / 60_000} minutes.`;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => {
        clearTimeout(timer);
        done({ ok: false, log: `${output}\n${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ ok: code === 0, log: output.slice(-logLimit) });
      });
    },
  );
  // The program is there now (or still missing): read it again.
  clearNativeLoginHealth();
  const cli = nativeCli(runtime);
  return { runtime, ok: ok && cli.installed, command, log, cli };
}
