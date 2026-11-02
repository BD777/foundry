/**
 * Runs tasks one at a time, in the order they are queued. A task that fails
 * rejects only its own promise; the tasks behind it still run.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Settles once every task queued so far has settled. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}

/**
 * A serial queue per key: tasks with the same key run one at a time in
 * order, tasks with different keys run concurrently. A key's queue is
 * dropped once it empties. For a bound on how many keys run at once, use
 * ConcurrentTaskScheduler.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const run = (this.tails.get(key) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }

  /** Keys with queued or running tasks. */
  get size(): number {
    return this.tails.size;
  }
}
