export interface SingleFlightOptions {
  /**
   * Keeps a task's result once it resolves, so later callers share it too
   * (a listener started once per key); only a failure is forgotten, and
   * forget() drops a kept one. By default a key is free again once its task
   * settles.
   */
  keepResolved?: boolean;
}

/**
 * One task per key at a time: a caller asking for a key while its task runs
 * gets that task's promise instead of starting another. The task starts at
 * once, in the caller's turn.
 */
export class SingleFlight<T = unknown> {
  private readonly flights = new Map<string, Promise<T>>();

  constructor(private readonly options: SingleFlightOptions = {}) {}

  run<R extends T>(key: string, task: () => Promise<R>): Promise<R> {
    const running = this.flights.get(key);
    if (running) return running as Promise<R>;
    let flight: Promise<R>;
    try {
      flight = task();
    } catch (error) {
      return Promise.reject(error);
    }
    this.flights.set(key, flight);
    const release = () => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    };
    if (this.options.keepResolved) flight.catch(release);
    else flight.then(release, release);
    return flight;
  }

  /** Whether a task for key is running (or kept). */
  has(key: string): boolean {
    return this.flights.has(key);
  }

  /** Tasks running (or kept) now. */
  get size(): number {
    return this.flights.size;
  }

  /** Frees key, so the next caller starts a new task. */
  forget(key: string): void {
    this.flights.delete(key);
  }
}
