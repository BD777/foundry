import type {
  DeviceDiagnostics,
  DeviceDisconnect,
  DiagnosticCheck,
  WorkerConnectionReport,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";

type Values = NonNullable<DiagnosticCheck["values"]>;

export interface CheckText {
  title: string;
  detail: string;
  advice?: string;
}

// Check ids and their values come from the worker at run time, so these keys
// are built from data rather than checked against the typed resource map.
const translate = i18n.t as unknown as (key: string, values: Values) => string;
const t = (key: string, values?: Values) =>
  translate(`devices:diagnostics.${key}`, values ?? {});

export const time = (value: unknown) => {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value ?? "")
    : date.toLocaleString(i18n.language, {
        dateStyle: "medium",
        timeStyle: "medium",
      });
};

function loginLabel(values: Values): string {
  if (values.loginError) return t("login.error", values);
  const status = String(values.login ?? "unavailable");
  return t(
    `login.${["verified", "local_login", "not_signed_in"].includes(status) ? status : "unavailable"}`,
  );
}

function activityDetail(values: Values, countKey: string): string {
  if (!values.ran) return t("activity.notRun");
  const parts = [t("activity.last", { at: time(values.at) })];
  if (values.count !== undefined)
    parts.push(t(countKey, { count: Number(values.count) }));
  parts.push(t("activity.seconds", { seconds: values.seconds ?? 0 }));
  if (values.error) parts.push(t("activity.error", { error: values.error }));
  return parts.join(" · ");
}

/** The title, finding and advice of one check, in the reader's language. */
export function checkText(check: DiagnosticCheck): CheckText {
  const values = check.values ?? {};
  const bad = check.status === "warn" || check.status === "error";
  const advise = (key: string) => (bad ? t(key, values) : undefined);
  switch (check.id) {
    case "connection.server":
      return {
        title: t("check.server"),
        detail: values.error
          ? t("server.failed", values)
          : t("server.answered", values),
        advice: advise(
          values.error ? "server.adviceFailed" : "server.adviceSlow",
        ),
      };
    case "connection.socket":
      return {
        title: t("check.socket"),
        detail: values.error ? String(values.error) : t("ms", values),
        advice: advise("socket.advice"),
      };
    case "connection.drops":
      return {
        title: t("check.drops"),
        detail: Number(values.count)
          ? t("drops.some", {
              count: Number(values.count),
              last: values.last ?? "",
            })
          : t("drops.none"),
        advice: bad
          ? Number(values.silentServer)
            ? t("drops.adviceSilent", values)
            : Number(values.frozenWorker)
              ? t("eventLoop.advice")
              : t("drops.advice")
          : undefined,
      };
    case "connection.proxy":
      return {
        title: t("check.proxy"),
        detail: values.proxy ? t("proxy.set", values) : t("proxy.none"),
        advice: advise("proxy.advice"),
      };
    case "runtime.eventLoop":
      return {
        title: t("check.eventLoop"),
        detail: [
          t("eventLoop.uptime", values),
          values.p99Ms !== undefined ? t("eventLoop.delay", values) : "",
          t("eventLoop.stalls", { count: Number(values.stalls ?? 0) }),
          values.lastStall ? t("eventLoop.lastStall", values) : "",
        ]
          .filter(Boolean)
          .join(" · "),
        advice: advise("eventLoop.advice"),
      };
    case "runtime.memory":
      return {
        title: t("check.memory"),
        detail: t("memory.used", values),
        advice: advise("memory.advice"),
      };
    case "runtime.disk":
      return {
        title: t("check.disk"),
        detail: values.error ? String(values.error) : t("disk.free", values),
        advice: advise("disk.advice"),
      };
    case "agents.claude":
    case "agents.codex": {
      const name = check.id === "agents.claude" ? "Claude Code" : "Codex";
      const detail = !values.installed
        ? t("agent.notInstalled")
        : [
            t("agent.version", values),
            loginLabel(values),
            values.outdated ? t("agent.outdated") : "",
          ]
            .filter(Boolean)
            .join(" · ");
      return { title: name, detail, advice: advise("agent.advice") };
    }
    case "workspaces.missing":
      return {
        title: t("check.workspaces"),
        detail: Number(values.count)
          ? t("workspaces.missing", {
              count: Number(values.count),
              paths: values.paths ?? "",
            })
          : t("workspaces.allThere"),
        advice: advise("workspaces.advice"),
      };
    case "skills.scan":
      return {
        title: t("check.skills"),
        detail: activityDetail(values, "activity.skills"),
      };
    case "chats.sync":
      return {
        title: t("check.chats"),
        detail: activityDetail(values, "activity.workspaces"),
      };
    default:
      return {
        title: check.id,
        detail: Object.entries(values)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join(" · "),
      };
  }
}

/** One readable line for a worker's report on a connection. */
// A worker blocked this long cannot answer the server's pings; the drop is
// then the worker's own doing, not the network's.
const frozenMs = 5_000;

export function connectionLine(report: WorkerConnectionReport): string {
  const seconds = (ms?: number) => Math.round((ms ?? 0) / 1000);
  return [
    t("connection.lasted", { seconds: seconds(report.durationMs) }),
    t(`connection.closedBy.${report.closedBy}`),
    report.error ? t("connection.error", { error: report.error }) : "",
    report.sinceServerDataMs !== undefined
      ? t("connection.silence", { seconds: seconds(report.sinceServerDataMs) })
      : "",
    (report.maxLagMs ?? 0) >= frozenMs
      ? t("connection.blocked", { seconds: seconds(report.maxLagMs) })
      : "",
    report.proxy ? t("proxy.set", { proxy: report.proxy }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The device's last drop, from both ends. */
export function disconnectLine(disconnect: DeviceDisconnect): string {
  return [
    time(disconnect.at),
    disconnect.serverReason
      ? t("disconnect.server", { reason: disconnect.serverReason })
      : "",
    disconnect.worker
      ? t("disconnect.worker", { line: connectionLine(disconnect.worker) })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The report as plain text, for pasting into a chat or an issue. */
export function reportText(
  deviceLabel: string,
  report: DeviceDiagnostics,
): string {
  const lines = [
    t("report.heading", {
      device: deviceLabel,
      version: report.workerVersion,
      at: report.generatedAt,
    }),
    "",
    ...report.checks.map((check) => {
      const text = checkText(check);
      const advice = text.advice ? ` — ${text.advice}` : "";
      return `[${t(`status.${check.status}`)}] ${text.title}: ${text.detail}${advice}`;
    }),
  ];
  if (report.connections.length)
    lines.push(
      "",
      t("report.connections"),
      ...report.connections.map(
        (item) => `- ${item.closedAt} ${connectionLine(item)}`,
      ),
    );
  if (report.logTail.length) lines.push("", t("report.log"), ...report.logTail);
  return lines.join("\n");
}
