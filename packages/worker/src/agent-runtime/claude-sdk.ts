import { claudeAgentSpawn } from "../agent-processes.js";
/** One SDK entry point; every query pins the selected immutable SDK generation. */
import { pathToFileURL } from "node:url";
import { acquireRuntime } from "./maintenance.js";
import { runtimeDescriptor } from "./state.js";
import {
  prepareExternalConnection,
  type PreparedExternalConnection,
} from "../external-connection.js";

export const claudeSdkPackage = "@anthropic-ai/claude-agent-sdk";
export async function loadClaudeSdk(): Promise<any> {
  const entry = runtimeDescriptor("claude")?.sdkEntry;
  const sdk = await import(
    entry ? pathToFileURL(entry).href : claudeSdkPackage
  );
  return {
    ...sdk,
    query: (input: any) => {
      let closed = false;
      let iterated = false;
      let release: (() => void) | undefined;
      let query: any;
      let finishing: Promise<void> | undefined;
      let connection: PreparedExternalConnection | undefined;
      const abort = new AbortController();
      const parentSignal = input.options?.abortController?.signal as
        AbortSignal | undefined;
      const abortFromParent = () => abort.abort(parentSignal?.reason);
      parentSignal?.addEventListener("abort", abortFromParent, { once: true });
      if (parentSignal?.aborted) abortFromParent();
      const finish = () =>
        (finishing ??= (async () => {
          parentSignal?.removeEventListener("abort", abortFromParent);
          try {
            await connection?.release();
          } finally {
            release?.();
          }
        })());
      const children: Promise<void>[] = [];
      let disposing: Promise<void> | undefined;
      const spawn =
        input.options?.spawnClaudeCodeProcess ??
        claudeAgentSpawn(input.options?.stderr, true)!;

      const ready = (async () => {
        try {
          release = await acquireRuntime("claude", abort.signal);
          if (closed) {
            await finish();
            throw new Error("Claude query closed before starting.");
          }
          const { connectionAdapter, ...options } = input.options ?? {};
          if (connectionAdapter) {
            connection = await prepareExternalConnection(connectionAdapter, {
              env: options.env ?? {},
              cwd: options.cwd,
              settings: options.settings,
              signal: abort.signal,
            });
            connection.signal.addEventListener(
              "abort",
              () => abort.abort(connection!.signal.reason),
              { once: true },
            );
            if (connection.signal.aborted)
              abort.abort(connection.signal.reason);
          }
          abort.signal.throwIfAborted();
          query = sdk.query({
            ...input,
            options: {
              ...options,
              abortController: abort,
              env: {
                ...(connection?.env ?? options.env),
                DISABLE_AUTOUPDATER: "1",
              },
              spawnClaudeCodeProcess: (
                options: Parameters<
                  NonNullable<ReturnType<typeof claudeAgentSpawn>>
                >[0],
              ) => {
                const child = spawn(options);
                children.push(
                  new Promise<void>((resolve) =>
                    child.once("close", () => resolve()),
                  ),
                );
                return child;
              },
            },
          });
          return query;
        } catch (error) {
          await finish();
          throw error;
        }
      })();
      void ready.catch(() => {});
      const dispose = () => {
        closed = true;
        if (!query) abort.abort();
        query?.close?.();
        disposing ??= (async () => {
          try {
            const resolved = await ready;
            resolved.close?.();
            if (!iterated) {
              try {
                for await (const _ of resolved) {
                }
              } catch {}
            }
            await Promise.all(children);
          } catch {
          } finally {
            await finish();
          }
        })();
        return disposing;
      };

      return new Proxy(
        {},
        {
          get(_target, key) {
            if (key === "then") return undefined;
            if (key === Symbol.asyncIterator)
              return async function* () {
                iterated = true;
                try {
                  yield* await ready;
                } finally {
                  query?.close?.();
                  await Promise.all(children);
                  await finish();
                }
              };
            if (key === "close")
              return () => {
                void dispose();
              };
            if (key === "dispose") return dispose;
            return async (...args: any[]) => {
              const resolved = await ready;
              if (typeof resolved[key] !== "function")
                throw new Error(`Claude SDK does not support ${String(key)}`);
              return resolved[key](...args);
            };
          },
        },
      );
    },
  };
}
