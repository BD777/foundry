/** Disposable device preparation. Hashing/expansion stays off the control thread. */
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import type { SessionSkillRef } from "@bd777/foundry-protocol";
import { prepareSkillContents } from "./skill-materializer.js";

export class SkillPrewarmer {
  private worker?: Worker;
  private fingerprint = "";
  private generation = 0;
  private timer?: NodeJS.Timeout;
  private retired: Promise<void> = Promise.resolve();

  constructor(
    private readonly report: (message: string) => void = console.warn,
  ) {}

  update(refs: SessionSkillRef[], serverURL: string): void {
    const fingerprint = JSON.stringify([
      serverURL,
      refs.map((r) => [r.checksum, r.sourceDigest, r.byteSize]).sort(),
    ]);
    if (fingerprint === this.fingerprint) return;
    this.stop();
    this.fingerprint = fingerprint;
    const generation = this.generation;
    if (!refs.length) return;
    void this.retired.then(() => {
      if (this.generation !== generation) return;
      this.start(refs, serverURL, generation);
    });
  }

  private start(
    refs: SessionSkillRef[],
    serverURL: string,
    generation: number,
  ): void {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { skillPrewarm: true, refs, serverURL },
    });
    this.worker = worker;
    let answered = false;
    const finish = (error?: string) => {
      if (this.generation !== generation) return;
      clearTimeout(this.timer);
      this.worker = undefined;
      if (error) {
        this.fingerprint = "";
        this.report(`Skill prewarm: ${error}`);
      }
    };
    worker.once("message", (result: { error?: string }) => {
      answered = true;
      finish(result.error);
    });
    worker.once("error", (error) => finish(error.message));
    worker.once("exit", (code) => {
      if (!answered) finish(`preparation ended without a result (${code})`);
    });
    this.timer = setTimeout(() => {
      if (this.generation !== generation) return;
      this.report(
        "Skill prewarm timed out; foreground preparation will retry missing versions.",
      );
      this.stop();
    }, 120_000);
    this.timer.unref();
  }

  stop(): void {
    this.generation++;
    this.fingerprint = "";
    clearTimeout(this.timer);
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    this.retired = new Promise((resolve) =>
      worker.once("exit", () => resolve()),
    );
    worker.postMessage("cancel");
    const timer = setTimeout(() => {
      void worker.terminate();
    }, 2000);
    timer.unref();
    worker.once("exit", () => clearTimeout(timer));
  }
}

if (!isMainThread && parentPort && workerData?.skillPrewarm) {
  const abort = new AbortController();
  parentPort.on("message", (message) => {
    if (message === "cancel") abort.abort();
  });
  try {
    const { stats } = await prepareSkillContents(
      workerData.refs,
      workerData.serverURL,
      { signal: abort.signal },
    );
    parentPort.postMessage({ stats });
  } catch (error) {
    parentPort.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    parentPort.close();
  }
}
