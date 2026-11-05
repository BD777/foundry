import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  ConnectorDescriptor,
  ConnectorExtensionMethods,
  ExtensionCli,
  ExtensionCliCall,
  ExtensionCliCondition,
  ExtensionCliModelAccess,
  ExtensionCliStatus,
  ExtensionCliValue,
  ExtensionModelProfile,
} from "@bd777/foundry-protocol";
import {
  extensionBaseEnvironment,
  findExtensionCommand,
} from "./process-environment.js";

/**
 * Declarative connector extensions (docs/connector-extensions.md,
 * "声明式扩展"): an extension without a program, whose connectors say how
 * to drive the tool's own command line. The worker answers the extension
 * protocol's methods itself by running the tool and reading its JSON, so
 * everything above (the device-held runtime, model access) is the same as
 * for a program extension. Only the tool runs; nothing goes through a shell.
 */

type Methods = ConnectorExtensionMethods;
type Method = keyof Methods;

export class DeclarativeError extends Error {}

const maxArgs = 32;
const maxText = 4096;
const defaultTimeoutSeconds = 30;
const maxTimeoutSeconds = 300;
const maxOutputBytes = 4 * 1024 * 1024;
const pointerPattern = /^(\/[^\s]*)?$/;
const templatePattern = /\{([^{}]*)\}/g;

function fail(message: string): never {
  throw new DeclarativeError(message);
}

// ---------------------------------------------------------------------------
// Reading the spec from a manifest

function strings(value: unknown, what: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxArgs ||
    value.some((item) => typeof item !== "string" || item.length > maxText)
  )
    fail(`${what} is at most ${maxArgs} strings`);
  return value as string[];
}

function pointer(value: unknown, what: string): string {
  if (
    typeof value !== "string" ||
    value.length > 300 ||
    !pointerPattern.test(value)
  )
    fail(`${what} is a JSON pointer such as /data/items`);
  return value;
}

/** Templates may name the home folder, the given names and item pointers. */
function checkTemplates(
  values: string[],
  what: string,
  names: Set<string>,
  pointers: boolean,
): void {
  for (const value of values)
    for (const [, name] of value.matchAll(templatePattern)) {
      if (name === "home" || names.has(name!)) continue;
      if (pointers && name!.startsWith("/") && pointerPattern.test(name!))
        continue;
      fail(`${what}: {${name}} is not something it can name here`);
    }
}

function call(
  raw: unknown,
  what: string,
  names: Set<string>,
  pointers: boolean,
): ExtensionCliCall {
  if (!raw || typeof raw !== "object") fail(`${what} is not an object`);
  const value = raw as Partial<ExtensionCliCall>;
  const args = strings(value.args, `${what}.args`);
  const each =
    value.forEach === undefined
      ? undefined
      : pointer(value.forEach, `${what}.forEach`);
  checkTemplates(args, what, names, pointers || Boolean(each));
  if (value.stdin !== undefined) {
    if (typeof value.stdin !== "string" || value.stdin.length > maxText)
      fail(`${what}.stdin is text`);
    checkTemplates([value.stdin], what, names, pointers || Boolean(each));
  }
  const timeout = value.timeoutSeconds;
  if (
    timeout !== undefined &&
    (!Number.isInteger(timeout) || timeout < 1 || timeout > maxTimeoutSeconds)
  )
    fail(`${what}.timeoutSeconds is 1 to ${maxTimeoutSeconds}`);
  return {
    args,
    ...(value.stdin !== undefined ? { stdin: value.stdin } : {}),
    ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
    ...(each !== undefined ? { forEach: each } : {}),
    ...(value.ok !== undefined ? { ok: pointer(value.ok, `${what}.ok`) } : {}),
    ...(value.error !== undefined
      ? { error: pointer(value.error, `${what}.error`) }
      : {}),
    ...(value.hint !== undefined
      ? { hint: pointer(value.hint, `${what}.hint`) }
      : {}),
  };
}

function conditions(raw: unknown, what: string): ExtensionCliCondition[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8)
    fail(`${what} is 1 to 8 conditions`);
  return raw.map((item, index) => {
    const value = item as Partial<ExtensionCliCondition>;
    const kinds = ["equals", "nonEmpty", "includes"].filter(
      (key) => (value as Record<string, unknown>)[key] !== undefined,
    );
    if (kinds.length !== 1)
      fail(`${what}[${index}] has one of equals, nonEmpty or includes`);
    if (
      value.equals !== undefined &&
      !["string", "number", "boolean"].includes(typeof value.equals)
    )
      fail(`${what}[${index}].equals is a string, number or boolean`);
    if (value.nonEmpty !== undefined && value.nonEmpty !== true)
      fail(`${what}[${index}].nonEmpty is true`);
    if (value.includes !== undefined && typeof value.includes !== "string")
      fail(`${what}[${index}].includes is a string`);
    return {
      ...value,
      pointer: pointer(value.pointer, `${what}[${index}].pointer`),
    } as ExtensionCliCondition;
  });
}

function valueAt(raw: unknown, what: string): ExtensionCliValue {
  const value = (raw ?? {}) as Partial<ExtensionCliValue>;
  return {
    pointer: pointer(value.pointer, `${what}.pointer`),
    ...(value.items !== undefined
      ? { items: pointer(value.items, `${what}.items`) }
      : {}),
  };
}

/**
 * A connector's `cli`, checked against its descriptor: a guided sign-in
 * method's call may name that method's fields; a terminal method has none.
 */
export function parseExtensionCli(
  raw: unknown,
  connector: ConnectorDescriptor,
): ExtensionCli {
  const kind = connector.kind;
  if (!raw || typeof raw !== "object") fail(`${kind}: cli is not an object`);
  const value = raw as Partial<ExtensionCli> & {
    status?: Partial<ExtensionCliStatus>;
  };
  const none = new Set<string>();
  const statusCall = call(value.status, `${kind}: cli.status`, none, false);
  const status: ExtensionCliStatus = {
    ...statusCall,
    signedIn: conditions(
      value.status?.signedIn,
      `${kind}: cli.status.signedIn`,
    ),
    ...(value.status?.identity !== undefined
      ? {
          identity: valueAt(
            value.status.identity,
            `${kind}: cli.status.identity`,
          ),
        }
      : {}),
    ...(value.status?.expiresAt !== undefined
      ? {
          expiresAt: valueAt(
            value.status.expiresAt,
            `${kind}: cli.status.expiresAt`,
          ),
        }
      : {}),
    ...(value.status?.problems !== undefined
      ? {
          problems: (Array.isArray(value.status.problems)
            ? value.status.problems
            : fail(`${kind}: cli.status.problems is a list`)
          )
            .slice(0, 8)
            .map((problem, index) => {
              if (
                typeof problem?.message !== "string" ||
                !problem.message ||
                problem.message.length > 300
              )
                fail(
                  `${kind}: cli.status.problems[${index}].message is a sentence`,
                );
              return {
                when: conditions(
                  problem.when,
                  `${kind}: cli.status.problems[${index}].when`,
                ),
                message: problem.message,
              };
            }),
        }
      : {}),
  };
  const parsed: ExtensionCli = { status };
  if (value.version !== undefined) {
    const version = value.version as { args?: unknown; pattern?: unknown };
    const args = strings(version.args, `${kind}: cli.version.args`);
    if (typeof version.pattern !== "string" || version.pattern.length > 200)
      fail(`${kind}: cli.version.pattern is a regular expression`);
    try {
      new RegExp(version.pattern);
    } catch {
      fail(`${kind}: cli.version.pattern is not a regular expression`);
    }
    parsed.version = { args, pattern: version.pattern };
  }
  if (value.signIn !== undefined) {
    if (typeof value.signIn !== "object" || !value.signIn)
      fail(`${kind}: cli.signIn is an object`);
    parsed.signIn = {};
    for (const [id, spec] of Object.entries(value.signIn)) {
      const method = connector.signIn?.methods.find((item) => item.id === id);
      if (!method || method.kind !== "guided")
        fail(`${kind}: cli.signIn.${id} names no guided sign-in method`);
      const fields = new Set((method.fields ?? []).map((field) => field.id));
      parsed.signIn[id] = call(
        spec,
        `${kind}: cli.signIn.${id}`,
        fields,
        false,
      );
    }
  }
  if (value.signOut !== undefined)
    parsed.signOut = call(value.signOut, `${kind}: cli.signOut`, none, false);
  if (value.modelAccess !== undefined) {
    if (!connector.provides?.modelAccess)
      fail(`${kind}: cli.modelAccess needs provides.modelAccess`);
    parsed.modelAccess = modelAccess(value.modelAccess, kind);
  }
  return parsed;
}

function modelAccess(raw: unknown, kind: string): ExtensionCliModelAccess {
  const value = (raw ?? {}) as Partial<ExtensionCliModelAccess>;
  const what = `${kind}: cli.modelAccess`;
  const none = new Set<string>();
  for (const key of ["id", "label"] as const)
    if (
      typeof value[key] !== "string" ||
      !value[key] ||
      value[key]!.length > 120
    )
      fail(`${what}.${key} is a template`);
  checkTemplates([value.id!, value.label!], what, none, true);
  const session = value.session as
    { command?: unknown; args?: unknown } | undefined;
  if (!session || typeof session.command !== "string" || !session.command)
    fail(`${what}.session.command names the session helper's program`);
  const sessionArgs = strings(session.args ?? [], `${what}.session.args`);
  checkTemplates(sessionArgs, `${what}.session`, none, true);
  const identity = value.identity as
    Partial<ExtensionCliModelAccess["identity"]> | undefined;
  if (!identity)
    fail(`${what}.identity says how to read the verified identity`);
  const identityArgs = strings(identity.args, `${what}.identity.args`);
  checkTemplates(identityArgs, `${what}.identity`, none, true);
  const models =
    value.models === undefined
      ? undefined
      : strings(value.models, `${what}.models`);
  if (value.model !== undefined && typeof value.model !== "string")
    fail(`${what}.model is a model name`);
  return {
    items: pointer(value.items, `${what}.items`),
    ...(value.where !== undefined
      ? { where: conditions(value.where, `${what}.where`) }
      : {}),
    id: value.id!,
    label: value.label!,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(models ? { models } : {}),
    session: { command: session.command, args: sessionArgs },
    identity: {
      args: identityArgs,
      pointer: pointer(identity.pointer, `${what}.identity.pointer`),
      ...(identity.timeoutSeconds !== undefined
        ? { timeoutSeconds: identity.timeoutSeconds }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Running it

/** RFC 6901: the value at pointer in document, or undefined. */
export function at(document: unknown, path: string): unknown {
  if (path === "") return document;
  let current: unknown = document;
  for (const raw of path.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) current = current[Number(key)];
    else if (current && typeof current === "object")
      current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
}

export function holds(
  document: unknown,
  condition: ExtensionCliCondition,
): boolean {
  const value = at(document, condition.pointer);
  if (condition.equals !== undefined) return value === condition.equals;
  if (condition.includes !== undefined)
    return Array.isArray(value) && value.includes(condition.includes);
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return typeof value === "string" ? value.length > 0 : Boolean(value);
}

/** Fills a template: {home}, a named value, or a pointer into item. */
export function render(
  template: string,
  values: Record<string, string>,
  item?: unknown,
): string {
  const filled = template.replace(templatePattern, (_, name: string) => {
    if (name === "home") return homedir();
    if (name.startsWith("/")) {
      const value = at(item, name);
      return typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";
    }
    return values[name] ?? "";
  });
  return filled === "~" || filled.startsWith("~/")
    ? join(homedir(), filled.slice(1))
    : filled;
}

interface Ran {
  code: number;
  stdout: string;
  answer: unknown;
}

/**
 * Variables added to the tool's environment for the calls made inside
 * `declarativeCall`'s `environment`: how a check reads the login as a
 * session that may not use it would.
 */
const overlay = new AsyncLocalStorage<NodeJS.ProcessEnv>();

function run(
  command: string,
  args: string[],
  stdin: string | undefined,
  timeoutSeconds: number,
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...extensionBaseEnvironment(), ...overlay.getStore() },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      detached: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      reject(
        new DeclarativeError(
          `${command.split("/").at(-1)} did not answer in ${timeoutSeconds}s`,
        ),
      );
    }, timeoutSeconds * 1000);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxOutputBytes) chunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString("utf8");
      resolve({ code: code ?? -1, stdout, answer: lastJson(stdout) });
    });
    // A tool that exits without reading its input must not crash the worker
    // with an EPIPE nobody listens for (the extension host does the same).
    child.stdin?.on("error", () => undefined);
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}

/** The tool's JSON answer: the whole output, else its last JSON line. */
function lastJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    for (const line of text.split("\n").reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // not this line
      }
    }
    return undefined;
  }
}

/** The tool's own words for a failure, never its raw output. */
function failure(spec: ExtensionCliCall, ran: Ran, fallback: string): string {
  const message = spec.error ? at(ran.answer, spec.error) : undefined;
  const hint = spec.hint ? at(ran.answer, spec.hint) : undefined;
  const words = [message, hint]
    .filter((part) => typeof part === "string" && part)
    .join(" ");
  return (words || fallback).slice(0, 300);
}

function succeeded(spec: ExtensionCliCall, ran: Ran): boolean {
  return ran.code === 0 && (!spec.ok || at(ran.answer, spec.ok) === true);
}

function joined(
  document: unknown,
  value: ExtensionCliValue,
): string | undefined {
  const pick = (item: unknown) => {
    const found = at(item, value.pointer);
    return typeof found === "string" || typeof found === "number"
      ? String(found)
      : undefined;
  };
  if (!value.items) return pick(document);
  const items = at(document, value.items);
  if (!Array.isArray(items)) return undefined;
  const parts = items.map(pick).filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : undefined;
}

/** What the worker needs of one declarative connector to answer for it. */
export interface DeclarativeConnector {
  descriptor: ConnectorDescriptor;
  cli: ExtensionCli;
}

function tool(connector: DeclarativeConnector): string | undefined {
  return findExtensionCommand(connector.descriptor.tool.command);
}

async function status(
  connector: DeclarativeConnector,
  command: string,
): Promise<Ran> {
  const spec = connector.cli.status;
  const ran = await run(
    command,
    spec.args.map((arg) => render(arg, {})),
    spec.stdin === undefined ? undefined : render(spec.stdin, {}),
    spec.timeoutSeconds ?? defaultTimeoutSeconds,
  );
  if (!succeeded(spec, ran))
    throw new DeclarativeError(
      failure(
        spec,
        ran,
        `${connector.descriptor.label} could not read its status`,
      ),
    );
  return ran;
}

async function readStatus(
  connector: DeclarativeConnector,
): Promise<Methods["connector.status"]["result"]> {
  const command = tool(connector);
  if (!command) return { installed: false, signedIn: false };
  let version: string | undefined;
  if (connector.cli.version) {
    const ran = await run(
      command,
      connector.cli.version.args,
      undefined,
      15,
    ).catch(() => undefined);
    version = ran
      ? new RegExp(connector.cli.version.pattern)
          .exec(ran.stdout)?.[1]
          ?.slice(0, 64)
      : undefined;
  }
  const answer = (await status(connector, command)).answer;
  const spec = connector.cli.status;
  if (!spec.signedIn.every((condition) => holds(answer, condition)))
    return {
      installed: true,
      ...(version ? { version } : {}),
      signedIn: false,
    };
  for (const problem of spec.problems ?? [])
    if (problem.when.every((condition) => holds(answer, condition)))
      throw new DeclarativeError(problem.message);
  const identity = spec.identity ? joined(answer, spec.identity) : undefined;
  const expiresAt = spec.expiresAt ? joined(answer, spec.expiresAt) : undefined;
  return {
    installed: true,
    ...(version ? { version } : {}),
    signedIn: true,
    ...(identity ? { identity: identity.slice(0, 200) } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

async function signIn(
  connector: DeclarativeConnector,
  options: Record<string, string>,
): Promise<Methods["connector.signIn.begin"]["result"]> {
  const methodId = options.method ?? "";
  const spec = connector.cli.signIn?.[methodId];
  const method = connector.descriptor.signIn?.methods.find(
    (item) => item.id === methodId,
  );
  if (!spec || !method)
    return {
      status: "failed",
      error: "Sign in from a terminal on the device, then check again.",
    };
  const values: Record<string, string> = {};
  for (const field of method.fields ?? []) {
    const value = (options[field.id] ?? "").trim() || field.default || "";
    if (field.required && !value)
      return { status: "failed", error: `${field.label} is required.` };
    if (value && field.pattern && !new RegExp(field.pattern).test(value))
      return {
        status: "failed",
        error: `${field.label} does not have the expected form.`,
      };
    values[field.id] = value;
  }
  const command = tool(connector);
  if (!command)
    return {
      status: "failed",
      error: `${connector.descriptor.tool.command} is not on this device.`,
    };
  const ran = await run(
    command,
    spec.args.map((arg) => render(arg, values)),
    spec.stdin === undefined ? undefined : render(spec.stdin, values),
    spec.timeoutSeconds ?? 120,
  );
  return succeeded(spec, ran)
    ? { status: "complete" }
    : {
        status: "failed",
        error: failure(
          spec,
          ran,
          `${connector.descriptor.label} could not sign in`,
        ),
      };
}

async function signOut(connector: DeclarativeConnector): Promise<void> {
  const spec = connector.cli.signOut;
  if (!spec)
    throw new DeclarativeError(
      `Sign ${connector.descriptor.label} out in a terminal on the device.`,
    );
  const command = tool(connector);
  if (!command)
    throw new DeclarativeError(
      `${connector.descriptor.tool.command} is not on this device.`,
    );
  const items = spec.forEach
    ? at((await status(connector, command)).answer, spec.forEach)
    : [undefined];
  for (const item of Array.isArray(items) ? items : []) {
    const ran = await run(
      command,
      spec.args.map((arg) => render(arg, {}, item)),
      spec.stdin === undefined ? undefined : render(spec.stdin, {}, item),
      spec.timeoutSeconds ?? defaultTimeoutSeconds,
    );
    if (!succeeded(spec, ran))
      throw new DeclarativeError(
        failure(spec, ran, `${connector.descriptor.label} could not sign out`),
      );
  }
}

async function listModels(
  connector: DeclarativeConnector,
): Promise<ExtensionModelProfile[]> {
  const spec = connector.cli.modelAccess;
  const command = tool(connector);
  if (!spec || !command) return [];
  const answer = (await status(connector, command)).answer;
  if (
    !connector.cli.status.signedIn.every((condition) =>
      holds(answer, condition),
    )
  )
    return [];
  // The status answer says which profiles exist; a profile that cannot be
  // used right now is still listed, with the reason, never left out.
  const connectorProblem = (connector.cli.status.problems ?? []).find(
    (problem) => problem.when.every((condition) => holds(answer, condition)),
  )?.message;
  const helper = isAbsolute(spec.session.command)
    ? spec.session.command
    : findExtensionCommand(spec.session.command);
  const helperProblem =
    !helper || !existsSync(helper)
      ? `${spec.session.command} is not on this device.`
      : undefined;
  const items = at(answer, spec.items);
  const profiles: ExtensionModelProfile[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (spec.where && !spec.where.every((condition) => holds(item, condition)))
      continue;
    const label = render(spec.label, {}, item);
    let problem = connectorProblem ?? helperProblem;
    let identity = "";
    if (!problem) {
      const described = await describe(helper!, spec, item, label);
      if ("identity" in described) identity = described.identity;
      else problem = described.problem;
    }
    profiles.push({
      id: render(spec.id, {}, item),
      label,
      runtime: "claude",
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.models ? { models: spec.models } : {}),
      identity,
      session: {
        command: helper ?? spec.session.command,
        args: spec.session.args.map((arg) => render(arg, {}, item)),
      },
      ...(problem ? { problem } : {}),
    } as ExtensionModelProfile);
  }
  return profiles;
}

/** Runs the session helper's identity command for one listed profile. */
async function describe(
  helper: string,
  spec: ExtensionCliModelAccess,
  item: unknown,
  label: string,
): Promise<{ identity: string } | { problem: string }> {
  try {
    const described = await run(
      helper,
      spec.identity.args.map((arg) => render(arg, {}, item)),
      undefined,
      spec.identity.timeoutSeconds ?? defaultTimeoutSeconds,
    );
    const identity = at(described.answer, spec.identity.pointer);
    if (typeof identity === "string" && identity) return { identity };
    return {
      problem: `${label} could not confirm its identity (the helper exited with code ${described.code}).`,
    };
  } catch (error) {
    return {
      problem: `${label} could not confirm its identity: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 300),
    };
  }
}

/**
 * Answers one extension-protocol request for a declarative extension,
 * as its program would.
 */
export function declarativeCall<M extends Method>(
  connectors: DeclarativeConnector[],
  method: M,
  params: Methods[M]["params"],
  environment?: Record<string, string>,
): Promise<Methods[M]["result"]> {
  return environment
    ? overlay.run(environment, () => answerCall(connectors, method, params))
    : answerCall(connectors, method, params);
}

async function answerCall<M extends Method>(
  connectors: DeclarativeConnector[],
  method: M,
  params: Methods[M]["params"],
): Promise<Methods[M]["result"]> {
  const kind = (params as { kind?: string } | undefined)?.kind;
  const connector = connectors.find((item) => item.descriptor.kind === kind);
  if (!connector)
    throw new DeclarativeError(
      `no connector ${String(kind)} in this extension`,
    );
  switch (method) {
    case "connector.status":
      return (await readStatus(connector)) as Methods[M]["result"];
    case "connector.signIn.begin":
      return (await signIn(
        connector,
        ((params as { options?: Record<string, string> }).options ??
          {}) as Record<string, string>,
      )) as Methods[M]["result"];
    case "connector.signIn.poll":
      return { status: "expired" } as Methods[M]["result"];
    case "connector.signIn.input":
    case "connector.signIn.cancel":
      return {} as Methods[M]["result"];
    case "connector.signOut":
      await signOut(connector);
      return {} as Methods[M]["result"];
    case "modelAccess.list":
      return { profiles: await listModels(connector) } as Methods[M]["result"];
    default:
      throw new DeclarativeError(
        `${connector.descriptor.label} does not do ${method}`,
      );
  }
}
