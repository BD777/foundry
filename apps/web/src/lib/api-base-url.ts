/**
 * Where the browser API is served: an explicit VITE_API_BASE_URL (empty means
 * same origin), else the local default, else the page's own origin.
 */
export function resolveApiBaseUrl(
  configured: string | undefined,
  localDefault: string | undefined,
): string {
  return configured ?? localDefault ?? "";
}

/**
 * Only the Vite dev server and Node tests (no import.meta.env) default to the
 * local server. A production build folds `DEV` to false and drops that
 * address, so one made without .env.production still stays on its own origin
 * (scripts/deploy-web-dev.sh refuses bundles that contain it).
 */
export const apiBaseUrl: string = resolveApiBaseUrl(
  import.meta.env?.VITE_API_BASE_URL,
  import.meta.env?.DEV !== false ? "http://127.0.0.1:31982" : undefined,
);
