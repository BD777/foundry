import { isAbortError } from "../../api";
import { ApiError } from "../../api/http";
import { i18n } from "../../i18n";

export function deviceFileErrorKey(
  error: unknown,
):
  | "update"
  | "changed"
  | "offline"
  | "slow"
  | "missing"
  | "forbidden"
  | "tooLarge"
  | "denied"
  | "notFile"
  | "secret"
  | "switchedOff"
  | "unavailable" {
  if (!(error instanceof ApiError)) return "unavailable";
  if (error.code === "worker_update_required") return "update";
  if (error.code === "file_denied") return "denied";
  if (error.code === "not_a_file") return "notFile";
  if (error.code === "file_sensitive") return "secret";
  if (error.code === "device_files_off") return "switchedOff";
  if (error.code === "file_changed") return "changed";
  if (error.status === 409) return "offline";
  if (error.status === 504) return "slow";
  if (error.status === 404) return "missing";
  if (error.status === 401 || error.status === 403) return "forbidden";
  if (error.status === 413) return "tooLarge";
  return "unavailable";
}

export function deviceFileErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  return i18n.t(`chat:detail.fileRead.${deviceFileErrorKey(error)}`);
}

function retryable(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof ApiError)
    return (
      error.code !== "worker_update_required" &&
      (error.status === 409 || error.status >= 500)
    );
  return error instanceof TypeError;
}

/** Only reads are repeated. Each manual attempt gets one transient retry. */
export async function requestDeviceFile<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
  onRetry: () => void = () => {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      if (signal.aborted || attempt > 0 || !retryable(error)) throw error;
      onRetry();
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
