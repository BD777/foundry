// The base URL of a compatible model provider as its runtime expects it.
// Claude Code calls `<base>/v1/messages`, so its base carries no `/v1`; Codex
// calls `<base>/responses`, so its base carries the version (`/v1`). People
// paste the URL from a provider's docs, which often names the full endpoint
// or the other runtime's convention, and the run then fails as an unknown
// model (`/v1/v1/messages` answers 404). The server applies this on every
// save (apps/server/internal/httpapi/provider_endpoint.go, same rules,
// shared fixtures in test/provider-endpoint-fixtures.json); the web previews
// it and the worker repairs older saved values before a run.

/** A change made to reach the runtime's form of the URL. */
export type ProviderEndpointCorrection =
  /** No scheme was typed; https (http for a loopback host) was assumed. */
  | "scheme_added"
  /** A request path such as `/messages`, `/responses` or `/models` was removed. */
  | "endpoint_path_removed"
  /** Claude: a trailing `/v1` was removed, Claude Code appends it itself. */
  | "version_removed"
  /**
   * Codex: a bare host got `/v1`, which Codex does not append itself. A host
   * typed with a request path (`https://host/responses`) already names its
   * base and gets none.
   */
  | "version_added";

/** Why a base URL cannot be used. */
export type ProviderEndpointError =
  | "empty"
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "query_or_fragment";

export type ProviderEndpointResult =
  | { baseUrl: string; corrections: ProviderEndpointCorrection[] }
  | { error: ProviderEndpointError };

export interface ProviderEndpointOptions {
  /**
   * Add `/v1` to a bare Codex host (default true). A run repairing an older
   * saved value passes false: a host that answered without it keeps working.
   */
  addMissingVersion?: boolean;
}

/** Request paths a pasted URL may end with, per runtime. */
const endpointSuffixes: Readonly<
  Record<"claude" | "codex", readonly string[]>
> = {
  claude: ["/messages", "/models", "/chat/completions"],
  codex: ["/responses", "/chat/completions", "/completions", "/models"],
};

const loopbackHost = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

export function normalizeProviderBaseUrl(
  runtime: string,
  raw: string,
  options: ProviderEndpointOptions = {},
): ProviderEndpointResult {
  let value = raw.trim();
  if (!value) return { error: "empty" };
  if (/\s/.test(value)) return { error: "invalid_url" };
  const corrections: ProviderEndpointCorrection[] = [];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const host = value.split(/[/?#]/, 1)[0] ?? "";
    value = `${loopbackHost.test(host) ? "http" : "https"}://${value}`;
    corrections.push("scheme_added");
  }
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(.*)$/i.exec(value);
  if (!match) return { error: "invalid_url" };
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!;
  let path = match[3]!;
  if (scheme !== "http" && scheme !== "https") {
    return { error: "unsupported_scheme" };
  }
  if (!authority || authority.startsWith(":")) return { error: "invalid_url" };
  if (authority.includes("@")) return { error: "credentials_in_url" };
  if (match[4]) return { error: "query_or_fragment" };

  path = trimSlashes(path);
  const suffixes =
    runtime === "claude" ? endpointSuffixes.claude : endpointSuffixes.codex;
  for (let removed = true; removed;) {
    removed = false;
    for (const suffix of suffixes) {
      if (path.toLowerCase().endsWith(suffix)) {
        path = trimSlashes(path.slice(0, -suffix.length));
        if (!corrections.includes("endpoint_path_removed")) {
          corrections.push("endpoint_path_removed");
        }
        removed = true;
      }
    }
  }
  if (runtime === "claude" && path.toLowerCase().endsWith("/v1")) {
    path = trimSlashes(path.slice(0, -"/v1".length));
    corrections.push("version_removed");
  }
  if (
    runtime === "codex" &&
    !path &&
    !corrections.includes("endpoint_path_removed") &&
    options.addMissingVersion !== false
  ) {
    path = "/v1";
    corrections.push("version_added");
  }
  return { baseUrl: `${scheme}://${authority}${path}`, corrections };
}

function trimSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}
