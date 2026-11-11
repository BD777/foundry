import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  ConnectorDescriptor,
  ConnectorExtensionMethods,
  ExtensionCli,
  ExtensionCliAuthorization,
  ExtensionCliAuthorizationAuthorize,
  ExtensionCliAuthorizationRead,
  ExtensionCliAuthorizationState,
  ExtensionCliCall,
  ExtensionCliCondition,
  ExtensionCliEnvelope,
  ExtensionCliErrorRule,
  ExtensionCliGuidedSignIn,
  ExtensionCliModelAccess,
  ExtensionCliStatus,
  ExtensionCliStep,
  ExtensionCliStepMapping,
  ExtensionCliText,
  ExtensionCliValue,
  ExtensionModelProfile,
} from "@bd777/foundry-protocol";
import { managedToolsBin } from "../../skills/managed-tools.js";
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
    const kinds = ["equals", "nonEmpty", "includes", "anyItem"].filter(
      (key) => (value as Record<string, unknown>)[key] !== undefined,
    );
    if (kinds.length !== 1)
      fail(
        `${what}[${index}] has one of equals, nonEmpty, includes or anyItem`,
      );
    if (
      value.equals !== undefined &&
      !["string", "number", "boolean"].includes(typeof value.equals)
    )
      fail(`${what}[${index}].equals is a string, number or boolean`);
    if (value.nonEmpty !== undefined && typeof value.nonEmpty !== "boolean")
      fail(`${what}[${index}].nonEmpty is a boolean`);
    if (value.includes !== undefined && typeof value.includes !== "string")
      fail(`${what}[${index}].includes is a string`);
    if (
      value.anyItem !== undefined &&
      (!value.anyItem || typeof value.anyItem !== "object")
    )
      fail(`${what}[${index}].anyItem is a condition`);
    if (value.allowMissing !== undefined && value.allowMissing !== true)
      fail(`${what}[${index}].allowMissing is true`);
    return {
      ...value,
      pointer: pointer(value.pointer, `${what}[${index}].pointer`),
      ...(value.anyItem
        ? {
            anyItem: conditions(
              [value.anyItem],
              `${what}[${index}].anyItem`,
            )[0]!,
          }
        : {}),
    } as ExtensionCliCondition;
  });
}

function valueAt(raw: unknown, what: string): ExtensionCliValue {
  const value = (raw ?? {}) as Partial<ExtensionCliValue>;
  const kinds = ["pointer", "firstOf"].filter(
    (key) => (value as Record<string, unknown>)[key] !== undefined,
  );
  if (kinds.length !== 1) fail(`${what} has one of pointer or firstOf`);
  if (value.items !== undefined && value.pointer === undefined)
    fail(`${what}.items needs a pointer within each item`);
  if (value.pointer !== undefined) pointer(value.pointer, `${what}.pointer`);
  if (value.firstOf !== undefined) {
    if (
      !Array.isArray(value.firstOf) ||
      value.firstOf.length === 0 ||
      value.firstOf.length > 8
    )
      fail(`${what}.firstOf is 1 to 8 pointers`);
    value.firstOf.forEach((item, index) =>
      pointer(item, `${what}.firstOf[${index}]`),
    );
  }
  if (
    value.stripAfter !== undefined &&
    (typeof value.stripAfter !== "string" ||
      !value.stripAfter ||
      value.stripAfter.length > 8)
  )
    fail(`${what}.stripAfter is a short delimiter`);
  if (value.asTimestamp !== undefined && value.asTimestamp !== true)
    fail(`${what}.asTimestamp is true`);
  return {
    ...(value.pointer !== undefined
      ? { pointer: pointer(value.pointer, `${what}.pointer`) }
      : {}),
    ...(value.firstOf !== undefined
      ? { firstOf: value.firstOf as string[] }
      : {}),
    ...(value.items !== undefined
      ? { items: pointer(value.items, `${what}.items`) }
      : {}),
    ...(value.stripAfter !== undefined ? { stripAfter: value.stripAfter } : {}),
    ...(value.asTimestamp ? { asTimestamp: true } : {}),
  };
}

function localizedText(raw: unknown, what: string): ExtensionCliText {
  if (typeof raw === "string") {
    if (!raw || raw.length > 300) fail(`${what} is a sentence`);
    return raw;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    fail(`${what} is text or a language map`);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 8)
    fail(`${what} has 1 to 8 languages`);
  for (const [language, text] of entries) {
    if (
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})?$/.test(language) ||
      typeof text !== "string" ||
      !text ||
      text.length > 300
    )
      fail(`${what}.${language} is a sentence`);
  }
  return raw as Record<string, string>;
}

const semverPattern = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

function versionNumber(value: unknown, what: string): string {
  if (typeof value !== "string" || !semverPattern.test(value))
    fail(`${what} is a version such as 1.2.3`);
  return value;
}

function step(raw: unknown, what: string): ExtensionCliStep {
  if (!raw || typeof raw !== "object") fail(`${what} is an object`);
  const value = raw as Partial<ExtensionCliStep>;
  if (
    !["pending", "complete", "expired", "denied", "failed"].includes(
      value.status ?? "",
    )
  )
    fail(`${what}.status is a known step status`);
  return {
    status: value.status!,
    ...(value.error !== undefined
      ? { error: localizedText(value.error, `${what}.error`) }
      : {}),
  };
}

function stepMapping(raw: unknown, what: string): ExtensionCliStepMapping {
  if (!raw || typeof raw !== "object") fail(`${what} is an object`);
  const value = raw as Partial<ExtensionCliStepMapping>;
  const map = value.map;
  if (!map || typeof map !== "object" || Array.isArray(map))
    fail(`${what}.map is an object`);
  const entries = Object.entries(map);
  if (entries.length === 0 || entries.length > 32)
    fail(`${what}.map has 1 to 32 status values`);
  const parsedMap: Record<string, ExtensionCliStep> = {};
  for (const [key, item] of entries) {
    if (!key || key.length > 64) fail(`${what}.map keys are status names`);
    parsedMap[key] = step(item, `${what}.map.${key}`);
  }
  const rules = value.rules;
  if (rules !== undefined && (!Array.isArray(rules) || rules.length > 16))
    fail(`${what}.rules is at most 16 rules`);
  return {
    pointer: pointer(value.pointer, `${what}.pointer`),
    map: parsedMap,
    ...(rules
      ? {
          rules: rules.map((rule, index) => ({
            when: conditions(rule.when, `${what}.rules[${index}].when`),
            step: step(rule.step, `${what}.rules[${index}].step`),
          })),
        }
      : {}),
    ...(value.otherwise !== undefined
      ? { otherwise: step(value.otherwise, `${what}.otherwise`) }
      : {}),
    ...(value.verificationUrl !== undefined
      ? {
          verificationUrl: pointer(
            value.verificationUrl,
            `${what}.verificationUrl`,
          ),
        }
      : {}),
    ...(value.qrImage !== undefined
      ? { qrImage: pointer(value.qrImage, `${what}.qrImage`) }
      : {}),
    ...(value.continuation !== undefined
      ? { continuation: pointer(value.continuation, `${what}.continuation`) }
      : {}),
    ...(value.continuationPattern !== undefined
      ? {
          continuationPattern: regex(
            value.continuationPattern,
            `${what}.continuationPattern`,
          ),
        }
      : {}),
    ...(value.requireChallenge !== undefined
      ? { requireChallenge: Boolean(value.requireChallenge) }
      : {}),
    ...(value.missingChallenge !== undefined
      ? {
          missingChallenge: localizedText(
            value.missingChallenge,
            `${what}.missingChallenge`,
          ),
        }
      : {}),
    ...(value.missingContinuation !== undefined
      ? {
          missingContinuation: localizedText(
            value.missingContinuation,
            `${what}.missingContinuation`,
          ),
        }
      : {}),
  };
}

function regex(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length > 300)
    fail(`${what} is a regular expression`);
  try {
    new RegExp(value);
  } catch {
    fail(`${what} is not a regular expression`);
  }
  return value;
}

function errorRules(raw: unknown, what: string): ExtensionCliErrorRule[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 24)
    fail(`${what} is 1 to 24 rules`);
  return raw.map((item, index) => {
    if (!item || typeof item !== "object")
      fail(`${what}[${index}] is an object`);
    const value = item as Partial<ExtensionCliErrorRule>;
    const kinds = ["code", "contains", "regex"].filter(
      (key) => (value as Record<string, unknown>)[key] !== undefined,
    );
    if (kinds.length !== 1)
      fail(`${what}[${index}] has one of code, contains or regex`);
    if (value.code !== undefined) {
      if (typeof value.code !== "string" || value.code.length > 120)
        fail(`${what}[${index}].code is a provider code`);
    }
    if (value.contains !== undefined) {
      const list = Array.isArray(value.contains)
        ? value.contains
        : [value.contains];
      if (
        list.length === 0 ||
        list.length > 8 ||
        list.some(
          (part) => typeof part !== "string" || !part || part.length > 120,
        )
      )
        fail(`${what}[${index}].contains is 1 to 8 strings`);
    }
    if (value.regex !== undefined)
      regex(value.regex, `${what}[${index}].regex`);
    return {
      ...(value.code !== undefined ? { code: value.code } : {}),
      ...(value.contains !== undefined ? { contains: value.contains } : {}),
      ...(value.regex !== undefined ? { regex: value.regex } : {}),
      step: step(value.step, `${what}[${index}].step`),
    };
  });
}

function authorizationState(
  raw: unknown,
  what: string,
): ExtensionCliAuthorizationState {
  if (!raw || typeof raw !== "object") fail(`${what} is an object`);
  const value = raw as Partial<ExtensionCliAuthorizationState>;
  if (
    !["ready", "needs_auth", "expired", "unknown", "unavailable"].includes(
      value.status ?? "",
    )
  )
    fail(`${what}.status is a known authorization status`);
  if (
    value.reason !== undefined &&
    !["bootstrap_available", "cli_upgrade", "check_failed"].includes(
      value.reason,
    )
  )
    fail(`${what}.reason is a known reason`);
  if (
    value.verification !== undefined &&
    !["local_state", "not_checked"].includes(value.verification)
  )
    fail(`${what}.verification is local_state or not_checked`);
  return {
    status: value.status!,
    ...(value.reason ? { reason: value.reason } : {}),
    ...(value.verification ? { verification: value.verification } : {}),
  };
}

function authorizationRead(
  raw: unknown,
  what: string,
  names: Set<string>,
): ExtensionCliAuthorizationRead {
  if (!raw || typeof raw !== "object") fail(`${what} is an object`);
  const value = raw as Partial<ExtensionCliAuthorizationRead>;
  const base = call(value, what, names, false);
  if (value.envelope !== undefined && value.envelope !== false)
    fail(`${what}.envelope is false`);
  if (
    value.source !== undefined &&
    !["stdout", "stderr", "stdoutThenStderr"].includes(value.source)
  )
    fail(`${what}.source is stdout, stderr or stdoutThenStderr`);
  if (value.firstObject !== undefined && value.firstObject !== true)
    fail(`${what}.firstObject is true`);
  if (
    value.upgradeWhen !== undefined &&
    (typeof value.upgradeWhen !== "string" ||
      !value.upgradeWhen ||
      value.upgradeWhen.length > 120)
  )
    fail(`${what}.upgradeWhen is a short output string`);
  const rules = value.rules;
  if (rules !== undefined && (!Array.isArray(rules) || rules.length > 16))
    fail(`${what}.rules is at most 16 rules`);
  return {
    ...base,
    ...(value.envelope === false ? { envelope: false as const } : {}),
    ...(value.source ? { source: value.source } : {}),
    ...(value.firstObject ? { firstObject: true } : {}),
    ...(value.upgradeWhen ? { upgradeWhen: value.upgradeWhen } : {}),
    ...(rules
      ? {
          rules: rules.map((rule, index) => ({
            when: conditions(rule.when, `${what}.rules[${index}].when`),
            state: authorizationState(
              rule.state,
              `${what}.rules[${index}].state`,
            ),
          })),
        }
      : {}),
    ...(value.otherwise !== undefined
      ? {
          otherwise: authorizationState(value.otherwise, `${what}.otherwise`),
        }
      : {}),
    ...(value.onError !== undefined
      ? { onError: authorizationState(value.onError, `${what}.onError`) }
      : {}),
  };
}

function authorizationAuthorize(
  raw: unknown,
  what: string,
  namesFor: (name: string) => Set<string>,
): ExtensionCliAuthorizationAuthorize {
  if (!raw || typeof raw !== "object") fail(`${what} is an object`);
  const value = raw as Partial<ExtensionCliAuthorizationAuthorize>;
  if ((value.begin === undefined) !== (value.poll === undefined))
    fail(`${what} has begin and poll together`);
  const beginSpec = value.begin as
    | (ExtensionCliCall & {
        fallbackWhen?: unknown;
        fallback?: unknown;
      })
    | undefined;
  let begin: ExtensionCliAuthorizationAuthorize["begin"];
  if (beginSpec) {
    begin = {
      ...call(beginSpec, `${what}.begin`, namesFor("scratch"), false),
      ...(beginSpec.fallbackWhen !== undefined
        ? {
            fallbackWhen: strings(
              beginSpec.fallbackWhen,
              `${what}.begin.fallbackWhen`,
            ),
          }
        : {}),
      ...(beginSpec.fallback !== undefined
        ? {
            fallback: call(
              beginSpec.fallback,
              `${what}.begin.fallback`,
              namesFor("scratch"),
              false,
            ),
          }
        : {}),
    };
    if (begin.fallbackWhen && !begin.fallback)
      fail(`${what}.begin.fallbackWhen needs fallback`);
  }
  const poll =
    value.poll === undefined
      ? undefined
      : call(value.poll, `${what}.poll`, namesFor("continuation"), false);
  const state =
    value.state === undefined
      ? undefined
      : stepMapping(value.state, `${what}.state`);
  if ((begin || poll) && (!begin || !poll || !state))
    fail(`${what} needs begin, poll and state together`);
  if (!begin && value.terminalMessage === undefined)
    fail(`${what} needs begin/poll or a terminalMessage`);
  return {
    ...(begin ? { begin } : {}),
    ...(poll ? { poll } : {}),
    ...(state ? { state } : {}),
    ...(value.errors !== undefined
      ? { errors: errorRules(value.errors, `${what}.errors`) }
      : {}),
    ...(value.terminalMessage !== undefined
      ? {
          terminalMessage: localizedText(
            value.terminalMessage,
            `${what}.terminalMessage`,
          ),
        }
      : {}),
    ...(value.noJsonMessage !== undefined
      ? {
          noJsonMessage: localizedText(
            value.noJsonMessage,
            `${what}.noJsonMessage`,
          ),
        }
      : {}),
    ...(value.defaultErrorMessage !== undefined
      ? {
          defaultErrorMessage: localizedText(
            value.defaultErrorMessage,
            `${what}.defaultErrorMessage`,
          ),
        }
      : {}),
  };
}

function authorizations(
  raw: unknown,
  connector: ConnectorDescriptor,
  kind: string,
): ExtensionCliAuthorization[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8)
    fail(`${kind}: cli.authorizations is 1 to 8 groups`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object")
      fail(`${kind}: cli.authorizations[${index}] is an object`);
    const value = item as Partial<ExtensionCliAuthorization>;
    const group = connector.authorizationGroups?.find(
      (candidate) =>
        candidate.id === value.group && candidate.revision === value.revision,
    );
    if (!group)
      fail(
        `${kind}: cli.authorizations[${index}] names no authorization group`,
      );
    if (seen.has(group.id)) fail(`${kind}: authorization ${group.id} repeats`);
    seen.add(group.id);
    const what = `${kind}: cli.authorizations[${index}]`;
    return {
      group: group.id,
      revision: group.revision,
      ...(value.minVersion !== undefined
        ? {
            minVersion: versionNumber(value.minVersion, `${what}.minVersion`),
          }
        : {}),
      ...(value.minVersionState !== undefined
        ? {
            minVersionState: authorizationState(
              value.minVersionState,
              `${what}.minVersionState`,
            ),
          }
        : {}),
      ...(value.upgradeMessage !== undefined
        ? {
            upgradeMessage: localizedText(
              value.upgradeMessage,
              `${what}.upgradeMessage`,
            ),
          }
        : {}),
      read: authorizationRead(value.read, `${what}.read`, new Set()),
      ...(value.authorize !== undefined
        ? {
            authorize: authorizationAuthorize(
              value.authorize,
              `${what}.authorize`,
              (name) => new Set([name]),
            ),
          }
        : {}),
    };
  });
}

function parseEnvelopeSpec(raw: unknown, kind: string): ExtensionCliEnvelope {
  if (!raw || typeof raw !== "object")
    fail(`${kind}: cli.envelope is an object`);
  const value = raw as Partial<ExtensionCliEnvelope>;
  if (
    value.okValue !== undefined &&
    !["string", "number", "boolean"].includes(typeof value.okValue)
  )
    fail(`${kind}: cli.envelope.okValue is a string, number or boolean`);
  return {
    ok: pointer(value.ok, `${kind}: cli.envelope.ok`),
    ...(value.okValue !== undefined ? { okValue: value.okValue } : {}),
    ...(value.code !== undefined
      ? { code: pointer(value.code, `${kind}: cli.envelope.code`) }
      : {}),
    ...(value.error !== undefined
      ? { error: pointer(value.error, `${kind}: cli.envelope.error`) }
      : {}),
    ...(value.hint !== undefined
      ? { hint: pointer(value.hint, `${kind}: cli.envelope.hint`) }
      : {}),
    ...(value.data !== undefined
      ? { data: pointer(value.data, `${kind}: cli.envelope.data`) }
      : {}),
  };
}

function parseEnv(
  raw: unknown,
  what: string,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    fail(`${what} is an object`);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 32)
    fail(`${what} has 1 to 32 variables`);
  const env: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      !/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) ||
      typeof value !== "string" ||
      value.length > 4096
    )
      fail(`${what}.${name} is an environment variable`);
    env[name] = value;
  }
  return env;
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
  const envelope =
    value.envelope === undefined
      ? undefined
      : parseEnvelopeSpec(value.envelope, kind);
  const env = parseEnv(value.env, `${kind}: cli.env`);
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
    ...(value.status?.sites !== undefined
      ? {
          sites: valueAt(value.status.sites, `${kind}: cli.status.sites`),
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
  const parsed: ExtensionCli = {
    status,
    ...(envelope ? { envelope } : {}),
    ...(env ? { env } : {}),
  };
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
      const raw = spec as Partial<ExtensionCliGuidedSignIn> &
        Partial<ExtensionCliCall>;
      if (raw.begin !== undefined || raw.poll !== undefined) {
        if (!raw.begin || !raw.poll || !raw.state)
          fail(`${kind}: cli.signIn.${id} needs begin, poll and state`);
        parsed.signIn[id] = {
          begin: call(
            raw.begin,
            `${kind}: cli.signIn.${id}.begin`,
            new Set([...fields, "scratch"]),
            false,
          ),
          poll: call(
            raw.poll,
            `${kind}: cli.signIn.${id}.poll`,
            new Set([...fields, "continuation"]),
            false,
          ),
          state: stepMapping(raw.state, `${kind}: cli.signIn.${id}.state`),
          ...(raw.errors !== undefined
            ? {
                errors: errorRules(
                  raw.errors,
                  `${kind}: cli.signIn.${id}.errors`,
                ),
              }
            : {}),
        };
      } else {
        parsed.signIn[id] = call(
          spec,
          `${kind}: cli.signIn.${id}`,
          fields,
          false,
        );
      }
    }
  }
  if (value.authorizations !== undefined)
    parsed.authorizations = authorizations(
      value.authorizations,
      connector,
      kind,
    );
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
  if (value === undefined && condition.allowMissing) return true;
  if (condition.equals !== undefined) return value === condition.equals;
  if (condition.includes !== undefined)
    return Array.isArray(value) && value.includes(condition.includes);
  if (condition.anyItem) {
    const items = Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.values(value)
        : [];
    return items.some((item) => holds(item, condition.anyItem!));
  }
  if (condition.nonEmpty === false) {
    if (Array.isArray(value)) return value.length === 0;
    if (value && typeof value === "object")
      return Object.keys(value).length === 0;
    return value === undefined || value === null || value === "";
  }
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
  stderr: string;
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
  environment?: Record<string, string>,
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...extensionBaseEnvironment(),
        ...environment,
        ...overlay.getStore(),
      },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
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
      if (size <= maxOutputBytes) out.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (chunk.length <= maxOutputBytes) err.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      resolve({ code: code ?? -1, stdout, stderr, answer: lastJson(stdout) });
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
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The business object, with the tool's envelope removed when declared. */
function answerOf(ran: Ran, envelope?: ExtensionCliEnvelope): unknown {
  return envelope?.data ? at(ran.answer, envelope.data) : ran.answer;
}

/** The envelope's success value, whether or not the process exited 0. */
function envelopeOk(
  spec: ExtensionCliCall,
  ran: Ran,
  envelope?: ExtensionCliEnvelope,
): boolean {
  const ok = spec.ok ?? envelope?.ok;
  if (!ok) return true;
  return at(ran.answer, ok) === (spec.ok ? true : (envelope?.okValue ?? true));
}

function succeeded(
  spec: ExtensionCliCall,
  ran: Ran,
  envelope?: ExtensionCliEnvelope,
): boolean {
  return ran.code === 0 && envelopeOk(spec, ran, envelope);
}

function failure(
  spec: ExtensionCliCall,
  ran: Ran,
  fallback: string,
  envelope?: ExtensionCliEnvelope,
): string {
  const error = spec.error ?? envelope?.error;
  const hint = spec.hint ?? envelope?.hint;
  const message = error ? at(ran.answer, error) : undefined;
  const extra = hint ? at(ran.answer, hint) : undefined;
  const words = [message, extra]
    .filter((part): part is string => typeof part === "string" && !!part)
    .join(" ");
  return (words || fallback).slice(0, 300);
}

/** Picks a localized string by LANGUAGE/LANG, falling back to English. */
function localized(value: ExtensionCliText | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (!value) return undefined;
  const preferred = [process.env.LANGUAGE, process.env.LANG]
    .flatMap((entry) => (entry ?? "").split(":"))
    .map((entry) => entry.split(".")[0]!.replaceAll("_", "-"))
    .filter(Boolean);
  for (const language of preferred) {
    const exact = Object.entries(value).find(
      ([key]) => key.toLowerCase() === language.toLowerCase(),
    );
    if (exact) return exact[1];
    const base = language.split("-")[0]!.toLowerCase();
    const fallback = Object.entries(value).find(
      ([key]) => key.split("-")[0]!.toLowerCase() === base,
    );
    if (fallback) return fallback[1];
  }
  return value.en ?? value["en-US"] ?? Object.values(value)[0];
}

function rawValue(document: unknown, value: ExtensionCliValue): unknown {
  if (value.firstOf)
    for (const path of value.firstOf) {
      const found = at(document, path);
      if (found !== undefined && found !== null && found !== "") return found;
    }
  return value.pointer ? at(document, value.pointer) : undefined;
}

function transformed(
  document: unknown,
  value: ExtensionCliValue,
): string | undefined {
  const found = rawValue(document, value);
  let result =
    typeof found === "string" || typeof found === "number"
      ? String(found)
      : undefined;
  if (result === undefined) return undefined;
  if (value.stripAfter) {
    const cut = result.indexOf(value.stripAfter);
    if (cut >= 0) result = result.slice(0, cut);
  }
  if (value.asTimestamp) {
    const parsed = Date.parse(result);
    if (Number.isNaN(parsed)) return undefined;
    result = new Date(parsed).toISOString();
  }
  return result;
}

function joined(
  document: unknown,
  value: ExtensionCliValue,
): string | undefined {
  if (!value.items) return transformed(document, value);
  const items = at(document, value.items);
  if (!Array.isArray(items)) return undefined;
  const parts = items
    .map((item) => transformed(item, value))
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : undefined;
}

function listed(document: unknown, value: ExtensionCliValue): string[] {
  if (!value.items) {
    const one = transformed(document, value);
    return one ? [one] : [];
  }
  const items = at(document, value.items);
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => transformed(item, value))
    .filter((part): part is string => Boolean(part));
}

/** What the worker needs of one declarative connector to answer for it. */
export interface DeclarativeConnector {
  descriptor: ConnectorDescriptor;
  cli: ExtensionCli;
}

interface LocatedTool {
  path: string;
  source: "foundry" | "device";
}

function tool(connector: DeclarativeConnector): LocatedTool | undefined {
  const named = connector.descriptor.tool.command;
  const managed = process.env.FOUNDRY_TOOLS_BIN ?? managedToolsBin();
  const managedPath = join(managed, named);
  if (existsSync(managedPath)) return { path: managedPath, source: "foundry" };
  const path = findExtensionCommand(named);
  return path ? { path, source: "device" } : undefined;
}

function env(
  connector: DeclarativeConnector,
): Record<string, string> | undefined {
  return connector.cli.env;
}

async function readVersion(
  connector: DeclarativeConnector,
  command: string,
): Promise<string | undefined> {
  const spec = connector.cli.version;
  if (!spec) return undefined;
  const ran = await run(
    command,
    spec.args,
    undefined,
    20,
    env(connector),
  ).catch(() => undefined);
  return ran
    ? new RegExp(spec.pattern).exec(ran.stdout)?.[1]?.slice(0, 64)
    : undefined;
}

async function statusRun(
  connector: DeclarativeConnector,
  command: string,
): Promise<{ ran: Ran; answer: unknown }> {
  const spec = connector.cli.status;
  let ran: Ran;
  try {
    ran = await run(
      command,
      spec.args.map((arg) => render(arg, {})),
      spec.stdin === undefined ? undefined : render(spec.stdin, {}),
      spec.timeoutSeconds ?? defaultTimeoutSeconds,
      env(connector),
    );
  } catch (error) {
    throw new DeclarativeError(
      `${connector.descriptor.label} could not read its status: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 300),
    );
  }
  if (!succeeded(spec, ran, connector.cli.envelope))
    throw new DeclarativeError(
      failure(
        spec,
        ran,
        `${connector.descriptor.label} could not read its status`,
        connector.cli.envelope,
      ),
    );
  return { ran, answer: answerOf(ran, connector.cli.envelope) };
}

async function readStatus(
  connector: DeclarativeConnector,
): Promise<Methods["connector.status"]["result"]> {
  const located = tool(connector);
  if (!located) return { installed: false, signedIn: false };
  const version = await readVersion(connector, located.path);
  const { answer } = await statusRun(connector, located.path);
  const authorizations = await readAuthorizations(
    connector,
    located.path,
    version,
  );
  const spec = connector.cli.status;
  if (!spec.signedIn.every((condition) => holds(answer, condition)))
    return {
      installed: true,
      installSource: located.source,
      ...(version ? { version } : {}),
      signedIn: false,
      ...(authorizations.length ? { authorizations } : {}),
    };
  for (const problem of spec.problems ?? [])
    if (problem.when.every((condition) => holds(answer, condition)))
      throw new DeclarativeError(problem.message);
  const identity = spec.identity ? joined(answer, spec.identity) : undefined;
  const sites = spec.sites ? listed(answer, spec.sites) : [];
  const expiresAt = spec.expiresAt ? joined(answer, spec.expiresAt) : undefined;
  return {
    installed: true,
    installSource: located.source,
    ...(version ? { version } : {}),
    signedIn: true,
    ...(identity ? { identity: identity.slice(0, 200) } : {}),
    ...(sites.length ? { sites } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(authorizations.length ? { authorizations } : {}),
  };
}

function compareVersions(version: string, minimum: string): number {
  const left = version
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number(part) || 0);
  const right = minimum.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return 1;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return -1;
  }
  return 0;
}

async function readAuthorizations(
  connector: DeclarativeConnector,
  command: string,
  version?: string,
): Promise<
  NonNullable<Methods["connector.status"]["result"]["authorizations"]>
> {
  const specs = connector.cli.authorizations ?? [];
  return Promise.all(
    (connector.descriptor.authorizationGroups ?? []).map(async (group) => {
      const base = { id: group.id, revision: group.revision };
      const spec = specs.find(
        (item) => item.group === group.id && item.revision === group.revision,
      );
      if (!spec)
        return {
          ...base,
          status: "unknown" as const,
          reason: "check_failed" as const,
        };
      if (
        spec.minVersion &&
        (!version || compareVersions(version, spec.minVersion) < 0)
      )
        return {
          ...base,
          status: spec.minVersionState?.status ?? "unavailable",
          ...(spec.minVersionState?.reason
            ? { reason: spec.minVersionState.reason }
            : { reason: "cli_upgrade" as const }),
        };
      try {
        const state = await readAuthorization(connector, command, spec);
        return {
          ...base,
          status: state.status,
          ...(state.reason ? { reason: state.reason } : {}),
        };
      } catch {
        const fallback = spec.read.onError ?? {
          status: "unknown" as const,
          verification: "not_checked" as const,
          reason: "check_failed" as const,
        };
        return {
          ...base,
          status: fallback.status,
          ...(fallback.reason ? { reason: fallback.reason } : {}),
        };
      }
    }),
  );
}

function sourceText(ran: Ran, read: ExtensionCliAuthorizationRead): string {
  const source = read.source ?? "stdout";
  if (source === "stderr") return ran.stderr;
  if (source === "stdoutThenStderr")
    return ran.stdout.includes("{") ? ran.stdout : ran.stderr;
  return ran.stdout;
}

async function readAuthorization(
  connector: DeclarativeConnector,
  command: string,
  spec: ExtensionCliAuthorization,
): Promise<ExtensionCliAuthorizationState> {
  const read = spec.read;
  let ran: Ran;
  try {
    ran = await run(
      command,
      read.args.map((arg) => render(arg, {})),
      read.stdin === undefined ? undefined : render(read.stdin, {}),
      read.timeoutSeconds ?? defaultTimeoutSeconds,
      env(connector),
    );
  } catch {
    return (
      read.onError ?? {
        status: "unknown",
        verification: "not_checked",
        reason: "check_failed",
      }
    );
  }
  if (read.upgradeWhen && ran.stdout.includes(read.upgradeWhen))
    return { status: "unavailable", reason: "cli_upgrade" };
  const raw = sourceText(ran, read);
  const start = read.firstObject ? raw.indexOf("{") : 0;
  const answer =
    start < 0 ? undefined : lastJson(read.firstObject ? raw.slice(start) : raw);
  if (answer === undefined) throw new DeclarativeError("not JSON");
  if (read.envelope !== false) {
    if (!envelopeOk(read, ran, connector.cli.envelope))
      throw new DeclarativeError("not a success envelope");
    const data = answerOf({ ...ran, answer }, connector.cli.envelope);
    for (const rule of read.rules ?? [])
      if (rule.when.every((condition) => holds(data, condition)))
        return rule.state;
  } else {
    for (const rule of read.rules ?? [])
      if (rule.when.every((condition) => holds(answer, condition)))
        return rule.state;
  }
  return (
    read.otherwise ?? {
      status: "unknown",
      verification: "not_checked",
      reason: "check_failed",
    }
  );
}

function mappedStep(
  mapping: ExtensionCliStepMapping,
  answer: unknown,
): ExtensionCliStep {
  const found = at(answer, mapping.pointer);
  const key =
    typeof found === "string" || typeof found === "number"
      ? String(found)
      : undefined;
  let result = (key !== undefined ? mapping.map[key] : undefined) ??
    mapping.otherwise ?? {
      status: "failed" as const,
    };
  for (const rule of mapping.rules ?? [])
    if (rule.when.every((condition) => holds(answer, condition))) {
      result = rule.step;
      break;
    }
  return result;
}

function codeFor(
  ran: Ran,
  envelope?: ExtensionCliEnvelope,
): string | undefined {
  return envelope?.code ? text(at(ran.answer, envelope.code)) : undefined;
}

function ruleMatches(rule: ExtensionCliErrorRule, code: string): boolean {
  if (rule.code !== undefined) return rule.code === code;
  if (rule.contains !== undefined) {
    const parts = Array.isArray(rule.contains)
      ? rule.contains
      : [rule.contains];
    return parts.some((part) => code.includes(part));
  }
  if (rule.regex !== undefined) return new RegExp(rule.regex).test(code);
  return false;
}

function safeCode(code: string | undefined): string {
  return code && /^[A-Z][A-Z0-9_]{2,95}$/.test(code)
    ? code
    : "AUTH_UNKNOWN_ERROR";
}

function publicStep(
  mapping: ExtensionCliStepMapping,
  step: ExtensionCliStep,
  answer: unknown,
  phase: "begin" | "poll",
): { step: Methods["connector.signIn.poll"]["result"]; continuation?: string } {
  const error = localized(step.error);
  if (step.status !== "pending")
    return {
      step: { status: step.status, ...(error ? { error } : {}) },
    };
  const verificationUrl = mapping.verificationUrl
    ? text(at(answer, mapping.verificationUrl))
    : undefined;
  const qr = mapping.qrImage ? text(at(answer, mapping.qrImage)) : undefined;
  if (mapping.requireChallenge && phase === "begin" && !verificationUrl && !qr)
    return {
      step: {
        status: "failed",
        error:
          localized(mapping.missingChallenge) ??
          "The tool started a sign-in without a page to approve it on.",
      },
    };
  let continuation: string | undefined;
  if (mapping.continuation) {
    const found = text(at(answer, mapping.continuation));
    if (
      !found ||
      (mapping.continuationPattern &&
        !new RegExp(mapping.continuationPattern).test(found))
    )
      return {
        step: {
          status: "failed",
          error:
            localized(mapping.missingContinuation) ??
            "The device returned no usable authorization continuation.",
        },
      };
    continuation = found;
  }
  return {
    step: {
      status: "pending",
      ...(verificationUrl ? { verificationUrl } : {}),
      ...(qr ? { challenge: { kind: "qr_image" as const } } : {}),
      ...(error ? { error } : {}),
    },
    ...(continuation ? { continuation } : {}),
  };
}

function stepFromRun(
  connector: DeclarativeConnector,
  mapping: ExtensionCliStepMapping,
  errors: ExtensionCliErrorRule[] | undefined,
  ran: Ran,
  phase: "begin" | "poll",
  authorization?: {
    noJsonMessage?: ExtensionCliText;
    defaultErrorMessage?: ExtensionCliText;
  },
): { step: Methods["connector.signIn.poll"]["result"]; continuation?: string } {
  const envelope = connector.cli.envelope;
  if (ran.answer === undefined) {
    if (authorization)
      return {
        step: {
          status: "failed",
          error: `[CLI_NO_JSON; ${phase}; exit ${ran.code}] ${
            localized(authorization.noJsonMessage) ??
            "The native sign-in command returned no readable response. Check the device's CLI and network; the base login was not signed out."
          }`.slice(0, 300),
        },
      };
    return {
      step: {
        status: "failed",
        error: `${connector.descriptor.label} did not answer in JSON.`,
      },
    };
  }
  if (!envelope ? ran.code !== 0 : !envelopeOk({ args: [] }, ran, envelope)) {
    const rawCode = codeFor(ran, envelope);
    const code = authorization ? safeCode(rawCode) : (rawCode ?? "");
    const rule = errors?.find((item) => ruleMatches(item, code));
    const message =
      localized(rule?.step.error) ??
      localized(authorization?.defaultErrorMessage) ??
      failure({ args: [] }, ran, connector.descriptor.label, envelope);
    if (authorization)
      return {
        step: {
          status: rule?.step.status ?? "failed",
          error: `[${code}; ${phase}; exit ${ran.code}] ${message}`.slice(
            0,
            300,
          ),
        },
      };
    return {
      step: {
        status: rule?.step.status ?? "failed",
        error: localized(rule?.step.error) ?? message,
      },
    };
  }
  const answer = answerOf(ran, envelope);
  return publicStep(mapping, mappedStep(mapping, answer), answer, phase);
}

const activeGuided = new Map<string, string>();

async function attempt(
  command: string,
  args: string[],
  stdin: string | undefined,
  timeoutSeconds: number,
  environment?: Record<string, string>,
): Promise<Ran> {
  try {
    return await run(command, args, stdin, timeoutSeconds, environment);
  } catch {
    return { code: 1, stdout: "", stderr: "", answer: undefined };
  }
}

function methodValues(
  connector: DeclarativeConnector,
  methodId: string,
  options: Record<string, string>,
): { values: Record<string, string> } | { error: string } {
  const method = connector.descriptor.signIn?.methods.find(
    (item) => item.id === methodId,
  );
  if (!method)
    return {
      error: "Sign in from a terminal on the device, then check again.",
    };
  const values: Record<string, string> = {};
  for (const field of method.fields ?? []) {
    const value = (options[field.id] ?? "").trim() || field.default || "";
    if (field.required && !value)
      return { error: `${field.label} is required.` };
    if (value && field.pattern && !new RegExp(field.pattern).test(value))
      return { error: `${field.label} does not have the expected form.` };
    values[field.id] = value;
  }
  return { values };
}

async function signInBegin(
  connector: DeclarativeConnector,
  options: Record<string, string>,
  scratch: string,
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
  const parsed = methodValues(connector, methodId, options);
  if ("error" in parsed) return { status: "failed", error: parsed.error };
  const located = tool(connector);
  if (!located)
    return {
      status: "failed",
      error: `${connector.descriptor.tool.command} is not on this device.`,
    };
  if (!("begin" in spec)) {
    const ran = await attempt(
      located.path,
      spec.args.map((arg) => render(arg, parsed.values)),
      spec.stdin === undefined ? undefined : render(spec.stdin, parsed.values),
      spec.timeoutSeconds ?? 120,
      env(connector),
    );
    return succeeded(spec, ran, connector.cli.envelope)
      ? { status: "complete" }
      : {
          status: "failed",
          error: failure(
            spec,
            ran,
            `${connector.descriptor.label} could not sign in`,
            connector.cli.envelope,
          ),
        };
  }
  activeGuided.set(connector.descriptor.kind, methodId);
  const ran = await attempt(
    located.path,
    spec.begin.args.map((arg) => render(arg, { ...parsed.values, scratch })),
    spec.begin.stdin === undefined
      ? undefined
      : render(spec.begin.stdin, { ...parsed.values, scratch }),
    spec.begin.timeoutSeconds ?? 120,
    env(connector),
  );
  const result = stepFromRun(connector, spec.state, spec.errors, ran, "begin");
  if (result.step.status !== "pending")
    activeGuided.delete(connector.descriptor.kind);
  return result.step;
}

async function signInPoll(
  connector: DeclarativeConnector,
): Promise<Methods["connector.signIn.poll"]["result"]> {
  const methodId = activeGuided.get(connector.descriptor.kind);
  const spec = methodId ? connector.cli.signIn?.[methodId] : undefined;
  if (!spec || !("begin" in spec)) return { status: "expired" };
  const located = tool(connector);
  if (!located)
    return {
      status: "failed",
      error: `${connector.descriptor.tool.command} is not on this device.`,
    };
  const ran = await attempt(
    located.path,
    spec.poll.args.map((arg) => render(arg, {})),
    spec.poll.stdin === undefined ? undefined : render(spec.poll.stdin, {}),
    spec.poll.timeoutSeconds ?? 120,
    env(connector),
  );
  const result = stepFromRun(connector, spec.state, spec.errors, ran, "poll");
  if (result.step.status !== "pending")
    activeGuided.delete(connector.descriptor.kind);
  return result.step;
}

async function authorizationBegin(
  connector: DeclarativeConnector,
  groupId: string,
  revision: number,
  scratch: string,
): Promise<{
  step: Methods["connector.authorization.begin"]["result"]["step"];
  continuation?: unknown;
}> {
  const spec = connector.cli.authorizations?.find(
    (item) => item.group === groupId && item.revision === revision,
  );
  const located = tool(connector);
  if (!spec || !located) {
    throw new DeclarativeError("Unsupported authorization capability.");
  }
  const authorize = spec.authorize;
  if (!authorize?.begin || !authorize.poll || !authorize.state) {
    throw new DeclarativeError(
      localized(authorize?.terminalMessage) ??
        "Unsupported authorization capability.",
    );
  }
  if (spec.minVersion) {
    const version = await readVersion(connector, located.path);
    if (!version || compareVersions(version, spec.minVersion) < 0)
      throw new DeclarativeError(
        localized(spec.upgradeMessage) ??
          `Update ${connector.descriptor.tool.command} to ${spec.minVersion} or newer for this authorization.`,
      );
  }
  let ran = await attempt(
    located.path,
    authorize.begin.args.map((arg) => render(arg, { scratch })),
    authorize.begin.stdin === undefined
      ? undefined
      : render(authorize.begin.stdin, { scratch }),
    authorize.begin.timeoutSeconds ?? 120,
    env(connector),
  );
  if (authorize.begin.fallbackWhen && authorize.begin.fallback) {
    const code = codeFor(ran, connector.cli.envelope);
    const data = answerOf(ran, connector.cli.envelope);
    const hasContinuation = authorize.state.continuation
      ? at(data, authorize.state.continuation) !== undefined
      : false;
    const hasQr = authorize.state.qrImage
      ? at(data, authorize.state.qrImage) !== undefined
      : false;
    if (
      code &&
      authorize.begin.fallbackWhen.includes(code) &&
      !hasContinuation &&
      !hasQr
    )
      ran = await attempt(
        located.path,
        authorize.begin.fallback.args.map((arg) => render(arg, { scratch })),
        authorize.begin.fallback.stdin === undefined
          ? undefined
          : render(authorize.begin.fallback.stdin, { scratch }),
        authorize.begin.fallback.timeoutSeconds ?? 120,
        env(connector),
      );
  }
  return stepFromRun(
    connector,
    authorize.state,
    authorize.errors,
    ran,
    "begin",
    {
      noJsonMessage: authorize.noJsonMessage,
      defaultErrorMessage: authorize.defaultErrorMessage,
    },
  );
}

async function authorizationPoll(
  connector: DeclarativeConnector,
  groupId: string,
  revision: number,
  continuation: unknown,
): Promise<Methods["connector.authorization.poll"]["result"]> {
  const spec = connector.cli.authorizations?.find(
    (item) => item.group === groupId && item.revision === revision,
  );
  if (!spec?.authorize?.poll || !spec.authorize.state)
    return { status: "expired" };
  if (
    typeof continuation !== "string" ||
    (spec.authorize.state.continuationPattern &&
      !new RegExp(spec.authorize.state.continuationPattern).test(continuation))
  )
    return { status: "expired" };
  const located = tool(connector);
  if (!located)
    return {
      status: "failed",
      error: `${connector.descriptor.tool.command} is not on this device.`,
    };
  const ran = await attempt(
    located.path,
    spec.authorize.poll.args.map((arg) => render(arg, { continuation })),
    spec.authorize.poll.stdin === undefined
      ? undefined
      : render(spec.authorize.poll.stdin, { continuation }),
    spec.authorize.poll.timeoutSeconds ?? 120,
    env(connector),
  );
  return stepFromRun(
    connector,
    spec.authorize.state,
    spec.authorize.errors,
    ran,
    "poll",
    {
      noJsonMessage: spec.authorize.noJsonMessage,
      defaultErrorMessage: spec.authorize.defaultErrorMessage,
    },
  ).step;
}

async function signOut(connector: DeclarativeConnector): Promise<void> {
  const spec = connector.cli.signOut;
  if (!spec)
    throw new DeclarativeError(
      `Sign ${connector.descriptor.label} out in a terminal on the device.`,
    );
  const located = tool(connector);
  if (!located)
    throw new DeclarativeError(
      `${connector.descriptor.tool.command} is not on this device.`,
    );
  activeGuided.delete(connector.descriptor.kind);
  const items = spec.forEach
    ? at((await statusRun(connector, located.path)).answer, spec.forEach)
    : [undefined];
  for (const item of Array.isArray(items) ? items : []) {
    const ran = await run(
      located.path,
      spec.args.map((arg) => render(arg, {}, item)),
      spec.stdin === undefined ? undefined : render(spec.stdin, {}, item),
      spec.timeoutSeconds ?? defaultTimeoutSeconds,
      env(connector),
    );
    if (!succeeded(spec, ran, connector.cli.envelope))
      throw new DeclarativeError(
        failure(
          spec,
          ran,
          `${connector.descriptor.label} could not sign out`,
          connector.cli.envelope,
        ),
      );
  }
}

async function listModels(
  connector: DeclarativeConnector,
): Promise<ExtensionModelProfile[]> {
  const spec = connector.cli.modelAccess;
  const located = tool(connector);
  if (!spec || !located) return [];
  const answer = (await statusRun(connector, located.path)).answer;
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
    case "connector.signIn.begin": {
      const options = params as {
        scratch?: string;
        options?: Record<string, string>;
      };
      return (await signInBegin(
        connector,
        options.options ?? {},
        options.scratch ?? "",
      )) as Methods[M]["result"];
    }
    case "connector.signIn.poll":
      return (await signInPoll(connector)) as Methods[M]["result"];
    case "connector.signIn.input":
      return {} as Methods[M]["result"];
    case "connector.signIn.cancel":
      activeGuided.delete(connector.descriptor.kind);
      return {} as Methods[M]["result"];
    case "connector.authorization.begin": {
      const authorization = params as {
        group: string;
        revision: number;
        scratch: string;
      };
      return (await authorizationBegin(
        connector,
        authorization.group,
        authorization.revision,
        authorization.scratch,
      )) as Methods[M]["result"];
    }
    case "connector.authorization.poll": {
      const authorization = params as {
        group: string;
        revision: number;
        continuation?: unknown;
      };
      return (await authorizationPoll(
        connector,
        authorization.group,
        authorization.revision,
        authorization.continuation,
      )) as Methods[M]["result"];
    }
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
