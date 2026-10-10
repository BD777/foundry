import { useRef, useState } from "react";

export interface SingleFlightOptions {
  /**
   * A run still going after this long is aborted through the signal its
   * task gets, so a stalled request fails and the run waiting behind it
   * starts. The task must pass the signal on to what it waits for.
   */
  timeoutMs?: number;
}

/**
 * Runs `task` one at a time. A call while it runs does not start a second
 * run beside it: it waits for one more run that starts after the current one
 * ends, which every call made meanwhile shares. So a caller always gets a
 * result that began after its call, and at most one run waits.
 */
export function singleFlight<T>(
  task: (signal: AbortSignal) => Promise<T>,
  { timeoutMs }: SingleFlightOptions = {},
): () => Promise<T> {
  let current: Promise<T> | undefined;
  let next: Promise<T> | undefined;
  const start = (): Promise<T> => {
    const controller = new AbortController();
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new DOMException(
                  `No answer within ${timeoutMs} ms`,
                  "TimeoutError",
                ),
              ),
            timeoutMs,
          );
    let run: Promise<T>;
    try {
      run = task(controller.signal);
    } catch (error) {
      run = Promise.reject(error);
    }
    current = run;
    const settle = () => {
      clearTimeout(timer);
      if (current === run) current = undefined;
    };
    run.then(settle, settle);
    return run;
  };
  return () => {
    if (!current) return start();
    next ??= current
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        next = undefined;
        // A call after the run ended may already have started the next one.
        return current ?? start();
      });
    return next;
  };
}

/**
 * singleFlight for a component: the task is read when a run starts, so it
 * sees that render's state; the returned function is stable.
 */
export function useSingleFlight<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: SingleFlightOptions = {},
): () => Promise<T> {
  const latest = useRef(task);
  latest.current = task;
  const [run] = useState(() =>
    singleFlight((signal) => latest.current(signal), options),
  );
  return run;
}

/** What a selection read covers: the default set (`all`) and named fields. */
export interface FieldSelection<F> {
  all: boolean;
  fields: ReadonlySet<F>;
}

/** A call's part of a selection read; no call names the default set. */
export interface FieldRequest<F> {
  all?: boolean;
  fields?: readonly F[];
}

/**
 * singleFlight for reads of a selection of fields: `read()` asks for the
 * default set, `read({ fields })` for those fields. One read runs at a
 * time; calls while it runs share one more read that covers everything
 * they asked for, so each caller gets a read that began after its call and
 * covered what it asked for.
 */
export function selectionFlight<F, T>(
  task: (selection: FieldSelection<F>, signal: AbortSignal) => Promise<T>,
  options: SingleFlightOptions = {},
): (request?: FieldRequest<F>) => Promise<T> {
  let pending: { all: boolean; fields: Set<F> } | undefined;
  const run = singleFlight((signal) => {
    const selection = pending ?? { all: true, fields: new Set<F>() };
    pending = undefined;
    return task(selection, signal);
  }, options);
  return ({ all = false, fields = [] } = { all: true }) => {
    pending ??= { all: false, fields: new Set() };
    pending.all ||= all;
    fields.forEach((field) => pending!.fields.add(field));
    return run();
  };
}

/** selectionFlight for a component, like useSingleFlight. */
export function useSelectionFlight<F, T>(
  task: (selection: FieldSelection<F>, signal: AbortSignal) => Promise<T>,
  options: SingleFlightOptions = {},
): (request?: FieldRequest<F>) => Promise<T> {
  const latest = useRef(task);
  latest.current = task;
  const [run] = useState(() =>
    selectionFlight<F, T>(
      (selection, signal) => latest.current(selection, signal),
      options,
    ),
  );
  return run;
}
