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
      const ready = (async () => {
        release = await acquireRuntime(
          "claude",
          input.options?.abortController?.signal,
        );
        if (closed) {
          release();
          throw new Error("Claude query closed before starting.");
        }
        try {
          query = sdk.query({
            ...input,
            options: {
              ...input.options,
              env: { ...input.options?.env, DISABLE_AUTOUPDATER: "1" },
            },
          });
          return query;
        } catch (error) {
          release();
          throw error;
        }
      })();
      void ready.catch(() => {});
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
                  release?.();
                }
              };
            if (key === "close")
              return () => {
                closed = true;
                query?.close?.();
                // Releasing at close is safe only after the SDK stream has ended.
                // Iteration's finally owns the lease; a metadata-only query drains below.
                if (query && !iterated)
                  void (async () => {
                    try {
                      for await (const _ of query) {
                      }
                    } catch {
                    } finally {
                      release?.();
                    }
                  })();
              };
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
