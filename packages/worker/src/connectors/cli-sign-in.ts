import type { ChildProcess } from "node:child_process";
import type { ToolRun } from "./device-held.js";

/**
 * One interactive sign-in of a vendor CLI running on the device: the CLI
 * prints what the person opens, may wait for what they paste back on its
 * stdin, and ends by itself. The adapter reads the output it collects and
 * decides what the page sees; nothing here is shown verbatim, since a CLI's
 * output can hold a token. Ends the CLI's whole process group on cancel or
 * once its lifetime is over.
 */
export class CliSignIn {
  private child: ChildProcess | undefined;
  private collected = "";
  private exitCode: number | null | undefined;
  private expiry: NodeJS.Timeout | undefined;

  constructor(private readonly lifetimeMs = 10 * 60_000) {}

  start(run: ToolRun, args: string[]): void {
    this.cancel();
    if (!run.spawn) throw new Error("This worker cannot run a CLI sign-in.");
    const child = run.spawn(args);
    this.child = child;
    this.collected = "";
    this.exitCode = undefined;
    const take = (chunk: Buffer) => {
      this.collected = (this.collected + chunk.toString()).slice(-64 * 1024);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => {
      this.collected += `\n${error.message}`;
      this.exitCode = -1;
    });
    child.on("exit", (code) => {
      this.exitCode = code ?? -1;
    });
    this.expiry = setTimeout(() => this.cancel(), this.lifetimeMs);
    this.expiry.unref?.();
  }

  get running(): boolean {
    return !!this.child && this.exitCode === undefined;
  }

  get started(): boolean {
    return !!this.child;
  }

  /** The exit code once the CLI ended, undefined while it runs. */
  get exit(): number | null | undefined {
    return this.exitCode;
  }

  get output(): string {
    return this.collected;
  }

  /**
   * Waits until found(output) answers or the CLI ends; undefined when it
   * ended first or nothing came within timeoutMs (then the CLI is ended).
   */
  async waitFor<T>(
    found: (output: string) => T | undefined,
    timeoutMs = 30_000,
  ): Promise<T | undefined> {
    const started = Date.now();
    for (;;) {
      const value = found(this.collected);
      if (value !== undefined) return value;
      if (this.exitCode !== undefined) return undefined;
      if (Date.now() - started > timeoutMs) {
        this.cancel();
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Types one line into the waiting CLI. */
  send(line: string): void {
    if (!this.running || !this.child?.stdin?.writable)
      throw new Error(
        "This sign-in is no longer waiting for input; start again.",
      );
    this.child.stdin.write(`${line}\n`);
  }

  cancel(): void {
    if (this.child && this.exitCode === undefined) {
      const pid = this.child.pid;
      try {
        // The CLI's whole process group (ToolRun.spawn starts it detached).
        if (pid) process.kill(-pid, "SIGTERM");
        else this.child.kill("SIGTERM");
      } catch {
        this.child.kill("SIGTERM");
      }
    }
    this.finish();
  }

  /** Forgets the CLI (it ended and its result was read). */
  finish(): void {
    clearTimeout(this.expiry);
    this.child = undefined;
  }
}
