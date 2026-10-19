import { claudeAgentSpawn } from "../agent-processes.js";
/** One SDK entry point; every query pins the selected immutable SDK generation. */
import { pathToFileURL } from "node:url";
import { acquireRuntime } from "./maintenance.js";
import { runtimeDescriptor } from "./state.js";

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
      let released = false;
      const finish = () => {
        if (!released) {
          released = true;
          release?.();
        }
      };
      const children: Promise<void>[] = [];
      let disposing: Promise<void> | undefined;
      const spawn =
        input.options?.spawnClaudeCodeProcess ??
        claudeAgentSpawn(input.options?.stderr, true)!;

      const ready = (async () => {
        release = await acquireRuntime(
          "claude",
          input.options?.abortController?.signal,
        );
        if (closed) {
          finish();
          throw new Error("Claude query closed before starting.");
        }
        try {
          query = sdk.query({
            ...input,
            options: {
              ...input.options,
              env: { ...input.options?.env, DISABLE_AUTOUPDATER: "1" },
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
          finish();
          throw error;
        }
      })();
      void ready.catch(() => {});
      const dispose = () => {
        closed = true;
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
            finish();
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
                  finish();
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
