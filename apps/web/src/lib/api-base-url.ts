/**
 * Where the browser API is served. Vite supplies import.meta.env; without it
 * (Node tests) the default applies.
 */
export const apiBaseUrl: string =
  import.meta.env?.VITE_API_BASE_URL ?? "http://127.0.0.1:31982";
