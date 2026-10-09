/**
 * A worker's report on itself, run when a person asks from the device page:
 * how its connection to the server behaves, its runtime, its agents, its
 * workspaces and the end of its own log. It never makes a model request.
 * Also the few repairs a person may ask for.
 */
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  rmSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import type {
  DeviceDiagnostics,
  DeviceRepairAction,
  DeviceRepairResult,
  DiagnosticCheck,
  WorkerConnectionReport,
} from "@bd777/foundry-protocol";
import {
  describeConnectionReport,
  proxyHost,
  recentConnectionReports,
} from "./connection-reports.js";
import { inspectNativeAccount } from "./native-inspection.js";
import { clearNativeCliCache, nativeCli } from "./native-cli.js";
import { clearNativeLoginHealth } from "./native-login.js";
import { serviceLogPaths } from "./service.js";
import { eventLoopDelay, recentStalls } from "./stall-monitor.js";
import { foundryStatePath, foundryStateRoot } from "./state-root.js";
import { clearDeviceCommands } from "./utils.js";
import { runningWorker } from "./worker-identity.js";
import { forgetWorkspaceRegistration, readRegistry } from "./workspaces.js";

type Values = NonNullable<DiagnosticCheck["values"]>;

interface ActivityResult {
  at: string;
  durationMs: number;
  count?: number;
  error?: string;
}

// Longer than this, a blocked worker cannot answer the server in time.
const frozenWorkerMs = 5_000;

const activities = new Map<"skillScan" | "nativeChatSync", ActivityResult>();

/** Remembers how the last skill scan or chat sync went. */
export function recordActivity(
  kind: "skillScan" | "nativeChatSync",
  startedAt: number,
  outcome: { count?: number; error?: unknown },
): void {
  activities.set(kind, {
    at: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    ...(outcome.count !== undefined ? { count: outcome.count } : {}),
    ...(outcome.error !== undefined
      ? {
          error:
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error),
        }
      : {}),
  });
}

const secretPatterns: Array<[RegExp, string]> = [
  [/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[redacted]"],
  [
    /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr]|fdy|glpat)[-_][A-Za-z0-9_-]{8,}/gi,
    "[redacted]",
  ],
  [
    /([?&](?:token|key|secret|password|code|signature|sig|access_token)=)[^&\s"']+/gi,
    "$1[redacted]",
  ],
  [
    /("?(?:token|api[_-]?key|secret|password|authorization|credential|cookie)"?\s*[:=]\s*"?)[^"\s,}]{4,}/gi,
    "$1[redacted]",
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

/** Removes credentials, tokens and email addresses from a log line. */
export function redactLogLine(line: string): string {
  let result = line;
  for (const [pattern, replacement] of secretPatterns)
    result = result.replace(pattern, replacement);
  return result;
}

/** The last lines of a file, reading at most its final 128 KB. */
function tailLines(path: string, count: number): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 128 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
    if (size > length) lines.shift();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}

/** The end of the worker's own logs, secrets removed. */
export function workerLogTail(lines = 200): string[] {
  const paths = serviceLogPaths();
  const half = Math.ceil(lines / 2);
  return [
    ...tailLines(paths.err, half).map((line) => `[err] ${line}`),
    ...tailLines(paths.out, half).map((line) => `[out] ${line}`),
  ].map(redactLogLine);
}

function check(
  id: string,
  status: DiagnosticCheck["status"],
  values?: Values,
): DiagnosticCheck {
  return values ? { id, status, values } : { id, status };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${ms / 1000}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DiagnosticsInput {
  serverURL: string;
  /** Round trip of a ping over the open control socket, in milliseconds. */
  socketRoundTrip: () => Promise<number>;
  /** Overridable for tests. */
  inspect?: typeof inspectNativeAccount;
  fetch?: typeof fetch;
}

async function connectionChecks(
  input: DiagnosticsInput,
): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const started = Date.now();
  try {
    const response = await withTimeout(
      (input.fetch ?? fetch)(new URL("/healthz", input.serverURL)),
      10_000,
    );
    const ms = Date.now() - started;
    checks.push(
      check(
        "connection.server",
        !response.ok ? "error" : ms > 2000 ? "warn" : "ok",
        { url: input.serverURL, status: response.status, ms },
      ),
    );
  } catch (error) {
    checks.push(
      check("connection.server", "error", {
        url: input.serverURL,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  try {
    const ms = await withTimeout(input.socketRoundTrip(), 10_000);
    checks.push(check("connection.socket", ms > 2000 ? "warn" : "ok", { ms }));
  } catch (error) {
    checks.push(
      check("connection.socket", "error", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  checks.push(
    dropsCheck(
      recentConnectionReports().filter(
        (report) => Date.parse(report.closedAt) >= Date.now() - 30 * 60_000,
      ),
    ),
  );
  const proxy = proxyHost();
  checks.push(
    check(
      "connection.proxy",
      proxy ? "warn" : "ok",
      proxy ? { proxy } : undefined,
    ),
  );
  return checks;
}

async function runtimeChecks(): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const delay = eventLoopDelay();
  const stalls = recentStalls();
  checks.push(
    check(
      "runtime.eventLoop",
      stalls.length || (delay && delay.max >= 5000) ? "warn" : "ok",
      {
        uptimeMinutes: Math.round(process.uptime() / 60),
        ...(delay ? { p99Ms: delay.p99, maxMs: delay.max } : {}),
        stalls: stalls.length,
        ...(stalls.at(-1)
          ? {
              lastStall: `${Math.round(stalls.at(-1)!.lagMs / 1000)}s at ${stalls.at(-1)!.at}`,
            }
          : {}),
      },
    ),
  );
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  checks.push(check("runtime.memory", rssMb > 2048 ? "warn" : "ok", { rssMb }));
  try {
    const disk = await statfs(foundryStateRoot());
    const freeGb =
      Math.round(((disk.bavail * disk.bsize) / 1024 ** 3) * 10) / 10;
    checks.push(
      check(
        "runtime.disk",
        freeGb < 0.5 ? "error" : freeGb < 2 ? "warn" : "ok",
        {
          freeGb,
          path: foundryStateRoot(),
        },
      ),
    );
  } catch (error) {
    checks.push(
      check("runtime.disk", "warn", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return checks;
}

async function agentChecks(
  input: DiagnosticsInput,
): Promise<DiagnosticCheck[]> {
  const inspect = input.inspect ?? inspectNativeAccount;
  return Promise.all(
    (["claude", "codex"] as const).map(async (runtime) => {
      const id = `agents.${runtime}`;
      const cli = nativeCli(runtime);
      if (!cli.installed) return check(id, "info", { installed: false });
      const values: Values = {
        installed: true,
        version: cli.version ?? "unknown",
        ...(cli.outdated ? { outdated: true } : {}),
      };
      try {
        const account = await withTimeout(inspect(runtime), 30_000);
        values.login = account.status;
        return check(
          id,
          cli.outdated ||
            account.status === "not_signed_in" ||
            account.status === "unavailable"
            ? "warn"
            : "ok",
          values,
        );
      } catch (error) {
        values.loginError =
          error instanceof Error ? error.message : String(error);
        return check(id, "warn", values);
      }
    }),
  );
}

/** Registered workspace folders that no longer exist. */
export function missingWorkspaces(): Array<{ id: string; path: string }> {
  return readRegistry()
    .filter((entry) => !existsSync(entry.path))
    .map((entry) => ({ id: entry.id, path: entry.path }));
}

function stateChecks(): DiagnosticCheck[] {
  const missing = missingWorkspaces();
  const activity = (kind: "skillScan" | "nativeChatSync", id: string) => {
    const result = activities.get(kind);
    if (!result) return check(id, "info", { ran: false });
    return check(
      id,
      result.error ? "warn" : result.durationMs > 60_000 ? "warn" : "ok",
      {
        ran: true,
        at: result.at,
        seconds: Math.round(result.durationMs / 100) / 10,
        ...(result.count !== undefined ? { count: result.count } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
    );
  };
  return [
    check("workspaces.missing", missing.length ? "warn" : "ok", {
      count: missing.length,
      ...(missing.length
        ? { paths: missing.map((entry) => entry.path).join(", ") }
        : {}),
    }),
    activity("skillScan", "skills.scan"),
    activity("nativeChatSync", "chats.sync"),
  ];
}

/** Runs every check; each one reports its own failure instead of failing the report. */
/**
 * The recent drops, split by cause. A worker frozen for seconds misses the
 * server's pings itself; only the drops it did not cause point at the network.
 */
export function dropsCheck(drops: WorkerConnectionReport[]): DiagnosticCheck {
  const last = drops.at(-1);
  const frozen = (report: WorkerConnectionReport) =>
    (report.maxLagMs ?? 0) >= frozenWorkerMs;
  return check(
    "connection.drops",
    drops.length >= 2 ? "warn" : drops.length ? "info" : "ok",
    {
      count: drops.length,
      silentServer: drops.filter(
        (report) => report.closedBy === "worker" && !frozen(report),
      ).length,
      frozenWorker: drops.filter(frozen).length,
      ...(last ? { last: describeConnectionReport(last) } : {}),
    },
  );
}

export async function runDiagnostics(
  input: DiagnosticsInput,
): Promise<DeviceDiagnostics> {
  const [connection, runtime, agents] = await Promise.all([
    connectionChecks(input),
    runtimeChecks(),
    agentChecks(input),
  ]);
  let logTail: string[];
  try {
    logTail = workerLogTail();
  } catch (error) {
    logTail = [
      `Reading the worker log failed: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return {
    generatedAt: new Date().toISOString(),
    workerVersion: runningWorker().version,
    checks: [...connection, ...runtime, ...agents, ...stateChecks()],
    connections: recentConnectionReports(),
    logTail,
  };
}

/** Runs one repair a person asked for. */
export function runRepair(
  action: DeviceRepairAction,
  recheckAgents: () => void,
): DeviceRepairResult {
  switch (action) {
    case "forget-missing-workspaces": {
      const missing = missingWorkspaces();
      for (const entry of missing)
        forgetWorkspaceRegistration(entry.id, entry.path);
      return {
        action,
        values: {
          count: missing.length,
          ...(missing.length
            ? { paths: missing.map((entry) => entry.path).join(", ") }
            : {}),
        },
      };
    }
    case "clear-skill-scan-cache": {
      const path = foundryStatePath("skill-scan-cache.json");
      const existed = existsSync(path);
      rmSync(path, { force: true });
      return { action, values: { cleared: existed } };
    }
    case "recheck-agents": {
      clearDeviceCommands();
      clearNativeCliCache();
      clearNativeLoginHealth();
      recheckAgents();
      return { action };
    }
    default:
      throw new Error(`unknown repair: ${String(action)}`);
  }
}
