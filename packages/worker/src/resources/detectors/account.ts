// Accounts signed in on this device, by name only: GitHub CLI hosts and
// users, AWS profile names, Kubernetes context names. Only the lines that
// name them are taken from local config; a token, key or certificate is
// never read into a report, and nothing is asked over the network, so a
// listed account is configured here, not known to work.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectContext, DetectedInstance, Detector } from "../detector.js";
import { findOnPath } from "../exec.js";

/** Configured here; only a real use could verify it. */
const configured = { ready: true, level: "configured" } as const;

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function home(context: DetectContext): string {
  return context.env.HOME || context.env.USERPROFILE || homedir();
}

/** gh's hosts.yml: where the GitHub CLI keeps who is signed in where. */
function ghHostsPath(context: DetectContext): string {
  if (context.env.GH_CONFIG_DIR)
    return join(context.env.GH_CONFIG_DIR, "hosts.yml");
  if (context.platform === "win32" && context.env.APPDATA)
    return join(context.env.APPDATA, "GitHub CLI", "hosts.yml");
  return join(
    context.env.XDG_CONFIG_HOME || join(home(context), ".config"),
    "gh",
    "hosts.yml",
  );
}

/**
 * Each host of a hosts.yml and its active user. Only top-level keys and
 * `user:` lines are read; every other line (tokens) is skipped unparsed.
 */
export function githubLogins(text: string): { host: string; user: string }[] {
  const logins: { host: string; user: string }[] = [];
  let host: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9.-]+):\s*$/.exec(line);
    if (top) {
      host = top[1];
      continue;
    }
    const user = /^ {2,4}user:\s*([A-Za-z0-9-]+)\s*$/.exec(line);
    if (host && user) logins.push({ host, user: user[1]! });
  }
  return logins;
}

/** Profile names in an AWS config file ([default], [profile name]). */
export function awsProfiles(text: string): string[] {
  const profiles: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[\s*(default|profile\s+([^\]\s]+))\s*\]\s*$/.exec(
      line,
    );
    if (section) profiles.push(section[2] ?? "default");
  }
  return [...new Set(profiles)];
}

function account(
  provider: string,
  id: string,
  name: string,
  details: Record<string, string>,
): DetectedInstance {
  return {
    key: `account/${provider}/${id}`,
    type: "account",
    platform: "any",
    name,
    readiness: configured,
    details: { provider, ...details },
  };
}

async function kubernetesContexts(
  context: DetectContext,
): Promise<DetectedInstance[]> {
  const kubectl = findOnPath("kubectl", context.env, context.platform);
  if (!kubectl) return [];
  const [names, current] = await Promise.all([
    context.exec(kubectl, ["config", "get-contexts", "-o", "name"], {
      timeoutMs: 3000,
    }),
    context.exec(kubectl, ["config", "current-context"], { timeoutMs: 3000 }),
  ]);
  if (names.code !== 0) return [];
  const active = current.code === 0 ? current.stdout.trim() : "";
  return names.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((name) =>
      account("kubernetes", name, name, {
        context: name,
        current: name === active ? "yes" : "no",
        tool: "kubectl",
      }),
    );
}

export const accountDetector: Detector = {
  id: "account",
  version: 1,
  type: "account",
  platforms: ["darwin", "linux", "win32"],
  intervalMs: 10 * 60_000,
  timeoutMs: 5000,
  async detect(context) {
    const instances: DetectedInstance[] = [];
    const hosts = readText(ghHostsPath(context));
    if (hosts)
      for (const { host, user } of githubLogins(hosts))
        instances.push(
          account("github", `${host}/${user}`, `${user} @ ${host}`, {
            host,
            user,
            tool: "gh",
          }),
        );
    const awsConfig = readText(
      context.env.AWS_CONFIG_FILE || join(home(context), ".aws", "config"),
    );
    if (awsConfig)
      for (const profile of awsProfiles(awsConfig).slice(0, 50))
        instances.push(
          account("aws", profile, `AWS profile ${profile}`, {
            profile,
            tool: "aws",
          }),
        );
    instances.push(...(await kubernetesContexts(context)));
    return instances;
  },
};
