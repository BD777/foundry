/**
 * When this process last heard from the Foundry server over its control
 * socket: any message, ping or pong. A Worker whose process and event loop
 * are fine can still be cut off from the server (DEV-217: a socket it
 * closed itself was never replaced); this is what notices.
 */
let lastContactAt = Date.now();

export function noteServerContact(now: number = Date.now()): void {
  lastContactAt = now;
}

export function lastServerContactAt(): number {
  return lastContactAt;
}

/** How long a Worker may go without the server before it restarts. */
export const serverContactLimitMs = Number(
  process.env.FOUNDRY_SERVER_CONTACT_LIMIT_MS || 5 * 60_000,
);

/**
 * Whether the Worker should end its process so its service manager starts
 * a fresh one: nothing from the server for longer than the limit. Turns that
 * run in this process (no execution host) are not ended for it: they keep
 * their outbox and finish; the restart waits for them.
 */
export function shouldRestartForServerSilence(input: {
  now: number;
  lastContactAt: number;
  limitMs: number;
  turnsInThisProcess: number;
}): boolean {
  return (
    input.now - input.lastContactAt > input.limitMs &&
    input.turnsInThisProcess === 0
  );
}
