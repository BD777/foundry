/**
 * Whether this device has the programs a skill needs. The server derives the
 * names (skillarchive.ToolRequirements: metadata.requires, script
 * interpreters, "#!" programs); the Skills page asks the device about them.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { withManagedTools } from "./managed-tools.js";

const toolName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;

/** Whether a program of that name is on this worker's PATH. */
export function hasProgram(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!toolName.test(name)) return false;
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const folder of (env.PATH ?? "").split(delimiter)) {
    if (!folder) continue;
    for (const extension of extensions) {
      const candidate = join(folder, name + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

/** Answers which of the named programs this device has. */
export function checkPrograms(names: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (!Array.isArray(names)) return result;
  // Sessions find Foundry's own tools first; so does this check.
  const env = { ...process.env, PATH: withManagedTools(process.env.PATH) };
  for (const name of names.slice(0, 200)) {
    if (typeof name === "string" && toolName.test(name))
      result[name] = hasProgram(name, env);
  }
  return result;
}
