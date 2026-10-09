/**
 * The programs a skill needs, by the rule the server applies to library
 * skills (skillarchive.ToolRequirements): the names its SKILL.md lists under
 * metadata.requires, the interpreters of its scripts, and the programs named
 * by script "#!" lines. Checked against the worker's PATH so a session is
 * told what is missing on this device instead of finding out mid-task.
 */
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { delimiter, extname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { withManagedTools } from "./managed-tools.js";

const toolName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const interpreters: Record<string, string> = {
  ".py": "python3",
  ".sh": "bash",
  ".bash": "bash",
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".rb": "ruby",
  ".pl": "perl",
};
const documents = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".html",
  ".csv",
]);
const maxFiles = 2000;

function normalize(name: string): string {
  const trimmed = name.trim();
  return trimmed === "python" ? "python3" : trimmed === "sh" ? "bash" : trimmed;
}

function shebangTool(head: string): string | undefined {
  if (!head.startsWith("#!")) return undefined;
  const fields = head.slice(2).split("\n", 1)[0]!.trim().split(/\s+/);
  const program = fields[0]?.split("/").pop();
  if (program !== "env") return program || undefined;
  return fields
    .slice(1)
    .find((field) => !field.startsWith("-") && !field.includes("="))
    ?.split("/")
    .pop();
}

function declared(manifest: string): string[] {
  const header = manifest
    .replace(/\r\n/g, "\n")
    .match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!header) return [];
  try {
    const requires = parseYaml(header[1]!)?.metadata?.requires;
    if (typeof requires === "string") return requires.split(/[,\s]+/);
    if (Array.isArray(requires))
      return requires.filter(
        (item): item is string => typeof item === "string",
      );
  } catch {
    return [];
  }
  return [];
}

function* files(dir: string): Generator<string> {
  const pending = [dir];
  let count = 0;
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        if (++count > maxFiles) return;
        yield full;
      }
    }
  }
}

/** The first bytes of a file, without reading the rest of it. */
function fileHead(file: string, bytes: number): string {
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    return buffer.toString("latin1", 0, read);
  } finally {
    closeSync(descriptor);
  }
}

/** The programs the skill folder `dir` needs, sorted. */
export function skillToolRequirements(dir: string): string[] {
  const found = new Set<string>();
  const add = (name: string | undefined) => {
    const tool = name && normalize(name);
    if (tool && toolName.test(tool)) found.add(tool);
  };
  for (const file of files(dir)) {
    const rel = relative(dir, file);
    if (rel === "SKILL.md") {
      declared(readFileSync(file, "utf8")).forEach(add);
      continue;
    }
    const ext = extname(file).toLowerCase();
    add(interpreters[ext]);
    if (documents.has(ext)) continue;
    try {
      add(shebangTool(fileHead(file, 200)));
    } catch {
      continue;
    }
  }
  return [...found].sort();
}

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
