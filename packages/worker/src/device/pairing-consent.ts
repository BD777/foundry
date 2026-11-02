/**
 * Pairing under a system account another person's device already uses
 * (docs/devices-and-workspaces.md, "一台电脑上的几个人"): the person is told
 * plainly that they would share it and chooses, here or in the web app.
 * Nothing is paired until they continue.
 */

import { createInterface } from "node:readline/promises";
import {
  PairingError,
  SharedAccountError,
  pairDevice,
} from "./device-pairing.js";

/** Pairing tokens last 15 minutes in the web, an hour from the CLI. */
const waitLimitMs = 60 * 60 * 1000;

export interface PairingConsentIO {
  /**
   * Asks the person in the terminal; undefined when there is no terminal
   * to ask in. Rejects when `signal` aborts.
   */
  ask?: (question: string, signal: AbortSignal) => Promise<string>;
  log: (line: string) => void;
  pollMs: number;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

function terminalAsk():
  ((question: string, signal: AbortSignal) => Promise<string>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return async (question, signal) => {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await terminal.question(question, { signal });
    } finally {
      terminal.close();
    }
  };
}

const defaultIO = (): PairingConsentIO => ({
  ask: terminalAsk(),
  log: (line) => console.log(line),
  pollMs: 3_000,
  sleep: (ms, signal) =>
    new Promise((done) => {
      const timer = setTimeout(done, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          done();
        },
        { once: true },
      );
    }),
});

/**
 * Pairs with the token. When another person's device already uses this
 * system account, says so and waits for the person's choice: "y" in the
 * terminal, Continue in the web app, or --share-system-account given up
 * front. Throws when they cancel.
 */
export async function pairWithConsent(
  serverURL: string,
  token: string,
  options: { shareSystemAccount?: boolean } = {},
  io: PairingConsentIO = defaultIO(),
): Promise<{ deviceId: string; credential: string }> {
  try {
    return await pairDevice(serverURL, token, {
      acceptSharedAccount: options.shareSystemAccount,
    });
  } catch (error) {
    if (!(error instanceof SharedAccountError)) throw error;
    io.log("");
    io.log(error.message);
    io.log("");
    return await waitForChoice(serverURL, token, io);
  }
}

async function waitForChoice(
  serverURL: string,
  token: string,
  io: PairingConsentIO,
): Promise<{ deviceId: string; credential: string }> {
  const stop = new AbortController();
  io.log(
    io.ask
      ? "You can also choose in the Foundry web app (Devices → Add device)."
      : "Choose in the Foundry web app (Devices → Add device), or run this command again with --share-system-account to continue. Waiting…",
  );
  // Continue or Cancel in the web ends the wait as well.
  const fromWeb = pollWeb(serverURL, token, io, stop.signal);
  // Settled even when the terminal answers first.
  const webOutcome = fromWeb.catch(() => undefined);
  const fromTerminal = io.ask
    ? io
        .ask("Continue and share this computer account? [y/N] ", stop.signal)
        .then(
          (answer) => ({ answer: answer.trim().toLowerCase() }),
          () => undefined,
        )
    : new Promise<undefined>(() => {});
  try {
    const first = await Promise.race([fromWeb, fromTerminal]);
    if (first && "credential" in first) return first;
    if (first && "answer" in first) {
      stop.abort();
      // A request already on its way may have paired after a web choice.
      const late = await webOutcome;
      if (late) return late;
      if (first.answer !== "y" && first.answer !== "yes")
        throw new Error(
          "Pairing cancelled; nothing was paired. To have your own separate space, create a separate system account on this computer and install the worker there.",
        );
      return await pairDevice(serverURL, token, { acceptSharedAccount: true });
    }
    throw new Error("Pairing was not completed.");
  } finally {
    stop.abort();
  }
}

/** Pairs again every few seconds until the web made the choice. */
async function pollWeb(
  serverURL: string,
  token: string,
  io: PairingConsentIO,
  signal: AbortSignal,
): Promise<{ deviceId: string; credential: string } | undefined> {
  const deadline = Date.now() + waitLimitMs;
  while (!signal.aborted && Date.now() < deadline) {
    await io.sleep(io.pollMs, signal);
    if (signal.aborted) return undefined;
    try {
      return await pairDevice(serverURL, token);
    } catch (error) {
      if (error instanceof SharedAccountError) continue;
      if (error instanceof PairingError && error.status === 401) throw error;
      // A dropped request is tried again.
    }
  }
  if (signal.aborted) return undefined;
  throw new Error("The pairing token expired while waiting for a choice.");
}
