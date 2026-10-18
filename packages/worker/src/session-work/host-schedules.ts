import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { redactSecrets } from "../secret-redaction.js";
import { writePrivateJSONAtomic } from "../storage.js";
import type { SessionWork } from "@bd777/foundry-protocol";

export type HostCommand = (
  argv: string[],
  input?: string,
) => { status: number; stdout: string; stderr: string };
export const hostCommand: HostCommand = (argv, input) => {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    input,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};
export interface HostSchedule {
  id: string;
  source: "crontab" | "systemd" | "launchd";
  raw: string;
  title: string;
  schedule: string;
  active: boolean;
}
interface RecordedSource {
  entry: HostSchedule;
  sessionId: string;
}
export function cronEntries(raw: string): HostSchedule[] {
  const seen = new Map<string, number>();
  return raw.split(/\r?\n/).flatMap((line) => {
    const paused = /^# foundry-work ([a-f0-9]+) (\S+)$/.exec(line);
    const original = paused
      ? Buffer.from(paused[2]!, "base64").toString("utf8")
      : line;
    if (
      !/^\s*(?:@(?:reboot|hourly|daily|weekly|monthly|yearly|annually)|(?:[^\s#]+\s+){5})\s*\S/.test(
        original,
      ) ||
      /^\s*(?:#|\w+\s*=)/.test(original)
    )
      return [];
    const ordinal = seen.get(original) || 0;
    seen.set(original, ordinal + 1);
    const id =
      paused?.[1] ||
      createHash("sha256")
        .update(`${original}\0${ordinal}`)
        .digest("hex")
        .slice(0, 24);
    const parts = original.trim().split(/\s+/);
    const count = parts[0]!.startsWith("@") ? 1 : 5;
    return [
      {
        id,
        source: "crontab" as const,
        raw: original,
        schedule: parts.slice(0, count).join(" "),
        title: redactSecrets(parts.slice(count).join(" ")).slice(0, 250),
        active: !paused,
      },
    ];
  });
}

/** OS adapters retain the exact source locally; neither commands nor writable
 * paths supplied by a browser are trusted as a control target. */
export class HostSchedules {
  private sources: Record<string, RecordedSource> = {};
  constructor(
    private readonly path: string,
    private readonly command: HostCommand = hostCommand,
  ) {
    try {
      this.sources = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private save() {
    writePrivateJSONAtomic(this.path, this.sources);
  }
  scan(): { entries: HostSchedule[]; errors: string[] } {
    const entries: HostSchedule[] = [],
      errors: string[] = [];
    try {
      const result = this.command(["crontab", "-l"]);
      if (
        result.status !== 0 &&
        !/no crontab|not found|no table/i.test(result.stderr)
      )
        throw new Error(result.stderr || "crontab inventory failed");
      entries.push(...cronEntries(result.stdout));
    } catch (e) {
      errors.push(`crontab: ${String(e)}`);
    }
    if (process.platform === "linux")
      try {
        const result = this.command([
          "systemctl",
          "--user",
          "list-timers",
          "--all",
          "--output=json",
          "--no-pager",
        ]);
        if (result.status !== 0) throw new Error(result.stderr);
        const timers = JSON.parse(result.stdout);
        for (const timer of timers)
          if (
            typeof timer.unit === "string" &&
            /^[\w@.\-]+\.timer$/.test(timer.unit)
          )
            entries.push({
              id: timer.unit,
              source: "systemd",
              raw: timer.unit,
              title: timer.unit,
              schedule: "systemd timer",
              active: Number(timer.next || 0) > 0,
            });
      } catch (e) {
        errors.push(`systemd: ${String(e)}`);
      }
    if (process.platform === "darwin")
      try {
        const folder = join(homedir(), "Library", "LaunchAgents");
        for (const file of existsSync(folder) ? readdirSync(folder) : []) {
          if (!file.endsWith(".plist")) continue;
          const path = join(folder, file);
          const parsed = this.command([
            "plutil",
            "-convert",
            "json",
            "-o",
            "-",
            path,
          ]);
          if (parsed.status !== 0) throw new Error(parsed.stderr);
          const job = JSON.parse(parsed.stdout);
          if (!job.StartInterval && !job.StartCalendarInterval) continue;
          if (typeof job.Label !== "string" || !/^[\w.\-]+$/.test(job.Label))
            continue;
          const actual = this.command([
            "launchctl",
            "print",
            `gui/${process.getuid?.()}/${job.Label}`,
          ]);
          entries.push({
            id: job.Label,
            source: "launchd",
            raw: path,
            title: job.Label,
            schedule: job.StartInterval
              ? `Every ${job.StartInterval}s`
              : "Calendar schedule",
            active: actual.status === 0,
          });
        }
      } catch (e) {
        errors.push(`launchd: ${String(e)}`);
      }
    return { entries, errors };
  }
  record(entry: HostSchedule, sessionId: string) {
    const key = `${entry.source}:${entry.id}`;
    if (!this.sources[key]) {
      this.sources[key] = { entry, sessionId };
      this.save();
    }
  }
  recorded(entry: HostSchedule): RecordedSource | undefined {
    return this.sources[`${entry.source}:${entry.id}`];
  }
  async apply(item: SessionWork): Promise<{ active: boolean }> {
    const known = this.sources[item.sourceId || ""];
    if (!known || known.sessionId !== item.sessionId)
      throw new Error("No verified local source mapping for this OS task");
    if (item.management !== "managed")
      throw new Error("OS task ownership must be established before control");
    if (known.entry.source === "crontab")
      return this.applyCron(item, known.entry);
    if (known.entry.source === "launchd")
      return this.applyLaunchd(item, known.entry);
    const name = known.entry.raw;
    const result = this.command([
      "systemctl",
      "--user",
      item.desiredState === "enabled" ? "enable" : "disable",
      "--now",
      name,
    ]);
    if (result.status !== 0)
      throw new Error(result.stderr || "systemd control failed");
    if (item.desiredState === "stopped" || item.desiredState === "removed") {
      const triggers = this.command([
        "systemctl",
        "--user",
        "show",
        "--property=Triggers",
        "--value",
        name,
      ]);
      if (triggers.status !== 0)
        throw new Error(
          triggers.stderr || "Cannot discover systemd triggered services",
        );
      for (const service of triggers.stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean)) {
        if (!/^[\w@.\-]+\.service$/.test(service))
          throw new Error("Unexpected systemd service identity");
        const stopped = this.command(["systemctl", "--user", "stop", service]);
        if (stopped.status !== 0) throw new Error(stopped.stderr);
        const actual = this.command([
          "systemctl",
          "--user",
          "is-active",
          service,
        ]);
        if (!["inactive", "failed"].includes(actual.stdout.trim()))
          throw new Error("Triggered service termination is unconfirmed");
      }
    }
    const check = this.command(["systemctl", "--user", "is-active", name]);
    const active = check.stdout.trim() === "active";
    if (active !== (item.desiredState === "enabled"))
      throw new Error("systemd state has not converged");
    return { active };
  }
  private applyCron(
    item: SessionWork,
    source: HostSchedule,
  ): { active: boolean } {
    const first = this.command(["crontab", "-l"]);
    if (first.status !== 0)
      throw new Error("Cannot read crontab before control");
    const lines = first.stdout.split("\n");
    const paused = `# foundry-work ${source.id} ${Buffer.from(source.raw).toString("base64")}`;
    const indexes = lines.flatMap((line, index) =>
      line === source.raw || line === paused ? [index] : [],
    );
    // Identical unmarked lines cannot be safely singled out. Ask for explicit
    // source repair instead of deleting every matching command.
    if (indexes.length !== 1)
      throw new Error(
        "Cron source is missing or ambiguous; no entries were changed",
      );
    const enabled = item.desiredState === "enabled";
    lines[indexes[0]!] = enabled ? source.raw : paused;
    const beforeCommit = this.command(["crontab", "-l"]);
    if (
      beforeCommit.stdout !== first.stdout ||
      beforeCommit.status !== first.status
    )
      throw new Error(
        "Crontab changed concurrently; retry from a fresh inventory",
      );
    const next = lines.join("\n");
    const written = this.command(
      ["crontab", "-"],
      next.endsWith("\n") ? next : next + "\n",
    );
    if (written.status !== 0)
      throw new Error(written.stderr || "Crontab write failed");
    const check = this.command(["crontab", "-l"]);
    if (check.status !== 0 || check.stdout.trimEnd() !== next.trimEnd())
      throw new Error("Crontab write could not be verified");
    // Removing a source cannot prove the previously detached command ended.
    if (item.desiredState === "stopped" || item.desiredState === "removed")
      throw new Error(
        "Schedule disabled, but pre-existing external executions have not been verified stopped",
      );
    return { active: enabled };
  }
  private applyLaunchd(
    item: SessionWork,
    entry: HostSchedule,
  ): { active: boolean } {
    if (item.desiredState === "paused")
      throw new Error(
        "launchd cannot pause future triggers independently of its current run; use Stop",
      );
    const target = `gui/${process.getuid?.()}/${entry.id}`,
      domain = `gui/${process.getuid?.()}`;
    const enabled = item.desiredState === "enabled";
    const policy = this.command([
      "launchctl",
      enabled ? "enable" : "disable",
      target,
    ]);
    if (policy.status !== 0) throw new Error(policy.stderr);
    const initial = this.command(["launchctl", "print", target]);
    if (enabled && initial.status !== 0) {
      const run = this.command(["launchctl", "bootstrap", domain, entry.raw]);
      if (run.status !== 0) throw new Error(run.stderr);
    }
    if (!enabled && initial.status === 0) {
      const run = this.command(["launchctl", "bootout", target]);
      if (run.status !== 0) throw new Error(run.stderr);
    }
    const actual = this.command(["launchctl", "print", target]);
    if ((actual.status === 0) !== enabled)
      throw new Error("launchd state has not converged");
    return { active: enabled };
  }
}
