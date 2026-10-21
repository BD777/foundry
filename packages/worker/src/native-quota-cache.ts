import type { NativeAccountInspection } from "@bd777/foundry-protocol";
import { nativeCli } from "./native-cli.js";
import { inspectNativeAccount } from "./native-inspection.js";

export class NativeAccountChangedError extends Error {}

export const quotaTtlMs = 60_000;
export function createSelectedAccountInspector(
  generationFor: (runtime: "claude" | "codex") => string | undefined,
  inspect: typeof inspectNativeAccount,
) {
  const reads = new Map<
    string,
    {
      promise: Promise<NativeAccountInspection>;
      expires: number;
      pending: boolean;
    }
  >();

  /** Device-local single flight, shared by tabs. Never reuse across a native identity change. */
  return function inspectSelectedAccount(
    runtime: "claude" | "codex",
    expectedGeneration: string,
    refresh = false,
  ): Promise<NativeAccountInspection> {
    const generation = generationFor(runtime);
    if (!expectedGeneration || generation !== expectedGeneration)
      return Promise.reject(
        new NativeAccountChangedError(
          "The selected account changed. Reload the account selection.",
        ),
      );
    const key = `${runtime}:${generation}`;
    const known = reads.get(key);
    if (known && (known.pending || (!refresh && known.expires > Date.now())))
      return known.promise;
    // Bound old identity retention. In-flight callers keep their own promise.
    for (const old of reads.keys())
      if (old.startsWith(`${runtime}:`) && old !== key) reads.delete(old);
    const entry = {
      promise: Promise.resolve(null as unknown as NativeAccountInspection),
      expires: 0,
      pending: true,
    };
    entry.promise = inspect(runtime)
      .then((result) => {
        if (
          generationFor(runtime) !== generation ||
          result.runtimeGeneration !== generation
        )
          throw new NativeAccountChangedError(
            "The selected account changed during this read. Reload the account selection.",
          );
        entry.expires = Date.now() + quotaTtlMs;
        return result;
      })
      .catch((error) => {
        if (reads.get(key) === entry) reads.delete(key);
        throw error;
      })
      .finally(() => {
        entry.pending = false;
      });
    reads.set(key, entry);
    return entry.promise;
  };
}
export const inspectSelectedAccount = createSelectedAccountInspector(
  (runtime) => nativeCli(runtime).generation,
  inspectNativeAccount,
);
