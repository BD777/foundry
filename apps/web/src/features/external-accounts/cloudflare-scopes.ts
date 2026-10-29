/**
 * Cloudflare OAuth scopes as Connectors shows them (DEV-091): a scope is
 * `<resource>:<action>` or `<resource>.<action>` ("zone.read",
 * "workers_scripts:write"); resources group under their product area.
 */
export interface CloudflareScopeResource {
  name: string;
  actions: string[];
}
export interface CloudflareScopeGroup {
  area: string;
  label: string;
  resources: CloudflareScopeResource[];
}
export interface CloudflareScopeSummary {
  asked: number;
  granted: number;
  write: number;
}

/** Not a permission: it only lets the grant be refreshed. */
const refreshOnly = "offline_access";

const acronyms: Record<string, string> = {
  ai: "AI",
  api: "API",
  d1: "D1",
  dns: "DNS",
  kv: "KV",
  r2: "R2",
  ssl: "SSL",
  waf: "WAF",
};

const minorWords = new Set(["and", "of", "for"]);

export function parseCloudflareScope(scope: string): {
  resource: string;
  action: string;
} {
  const cut = Math.max(scope.lastIndexOf(":"), scope.lastIndexOf("."));
  if (cut <= 0) return { resource: scope, action: "" };
  return { resource: scope.slice(0, cut), action: scope.slice(cut + 1) };
}

export function isCloudflareWriteScope(scope: string): boolean {
  const { action } = parseCloudflareScope(scope);
  return scope !== refreshOnly && action !== "" && action !== "read";
}

function permissions(scopes: readonly string[] | undefined): string[] {
  return [...new Set(scopes ?? [])].filter((s) => s && s !== refreshOnly);
}

export function summarizeCloudflareScopes(
  granted: readonly string[] | undefined,
  requested: readonly string[] | undefined,
): CloudflareScopeSummary {
  const have = permissions(granted);
  return {
    asked: permissions(requested).length,
    granted: have.length,
    write: have.filter(isCloudflareWriteScope).length,
  };
}

function areaOf(resource: string): string {
  return resource.split(/[_.:]/)[0] || resource;
}

export function cloudflareAreaLabel(area: string): string {
  return area
    .split("-")
    .map((word, i) =>
      i > 0 && minorWords.has(word)
        ? word
        : (acronyms[word] ?? word.charAt(0).toUpperCase() + word.slice(1)),
    )
    .join(" ");
}

/** Groups the granted permissions by area; filter matches scope or area. */
export function groupCloudflareScopes(
  granted: readonly string[] | undefined,
  filter = "",
): CloudflareScopeGroup[] {
  const needle = filter.trim().toLowerCase();
  const areas = new Map<string, Map<string, Set<string>>>();
  for (const scope of permissions(granted)) {
    const { resource, action } = parseCloudflareScope(scope);
    const area = areaOf(resource);
    if (
      needle &&
      !scope.toLowerCase().includes(needle) &&
      !cloudflareAreaLabel(area).toLowerCase().includes(needle)
    )
      continue;
    const resources = areas.get(area) ?? new Map<string, Set<string>>();
    areas.set(area, resources);
    const actions = resources.get(resource) ?? new Set<string>();
    resources.set(resource, actions);
    if (action) actions.add(action);
  }
  const order = (a: string) => (a === "read" ? 0 : 1);
  return [...areas.entries()]
    .map(([area, resources]) => ({
      area,
      label: cloudflareAreaLabel(area),
      resources: [...resources.entries()]
        .map(([name, actions]) => ({
          name,
          actions: [...actions].sort(
            (a, b) => order(a) - order(b) || a.localeCompare(b),
          ),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
