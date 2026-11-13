/**
 * The choice of a permission set (DEV-136), shared by every connector that
 * has one: GitHub's scopes on a device, Cloudflare's and Feishu's on the
 * server. Pure functions; the picker renders them.
 */
export interface PermissionScope {
  id: string;
  /** Words for the scope; the id is always shown too. */
  label?: string;
  recommended?: boolean;
  /** Always asked for, never removed (a tool's minimum). */
  required?: boolean;
  /** Broader scopes that include this one. */
  impliedBy?: string[];
  /** A tenant administrator may have to approve it. */
  approval?: boolean;
  /** The app does not hold it, so a login cannot get it. */
  unavailable?: boolean;
  /** Heading the scope is listed under. */
  area?: string;
}

export interface PermissionPreset {
  id: string;
  label: string;
  hint: string;
  excludeScopes: string[];
}

/** A server-held provider's catalog (Cloudflare, Feishu) as a permission list. */
export function catalogScopes(
  catalog: {
    scopes: {
      id: string;
      recommended?: boolean;
      approval?: boolean;
      unavailable?: boolean;
    }[];
  },
  area?: (id: string) => string,
): PermissionScope[] {
  return catalog.scopes.map((scope) => ({
    id: scope.id,
    recommended: scope.recommended,
    approval: scope.approval,
    unavailable: scope.unavailable,
    area: area?.(scope.id),
  }));
}

export type PermissionMode =
  "recommended" | "all" | "custom" | `preset:${string}`;

export interface PermissionPlan {
  /** Exactly what the provider is asked for (always-scopes first). */
  request: string[];
  add: string[];
  remove: string[];
}

const ids = (
  scopes: PermissionScope[],
  keep: (s: PermissionScope) => boolean,
) => scopes.filter(keep).map((scope) => scope.id);

/** Selected scopes plus everything they include. */
export function effectiveScopes(
  selected: readonly string[],
  scopes: PermissionScope[],
): Set<string> {
  const held = new Set(selected);
  for (const scope of scopes)
    if ((scope.impliedBy ?? []).some((parent) => selected.includes(parent)))
      held.add(scope.id);
  return held;
}

/**
 * The selection as it will be asked for: listed scopes only, required
 * ones added, and a scope dropped when a selected broader one includes it.
 */
export function normalizeSelection(
  selected: readonly string[],
  scopes: PermissionScope[],
): string[] {
  const chosen = new Set([
    ...ids(scopes, (s) => !!s.required),
    ...selected.filter((id) => scopes.some((scope) => scope.id === id)),
  ]);
  return scopes
    .filter(
      (scope) =>
        chosen.has(scope.id) &&
        !(scope.impliedBy ?? []).some((parent) => chosen.has(parent)),
    )
    .map((scope) => scope.id);
}

export function selectionFor(
  mode: Exclude<PermissionMode, "custom">,
  scopes: PermissionScope[],
  presets: PermissionPreset[] = [],
): string[] {
  const preset = mode.startsWith("preset:")
    ? presets.find((entry) => `preset:${entry.id}` === mode)
    : undefined;
  return normalizeSelection(
    mode === "all"
      ? ids(scopes, (s) => !s.unavailable)
      : preset
        ? ids(
            scopes,
            (scope) =>
              !scope.unavailable && !preset.excludeScopes.includes(scope.id),
          )
        : mode === "recommended"
          ? ids(scopes, (s) => !!s.recommended || !!s.required)
          : [],
    scopes,
  );
}

/**
 * Where the picker starts: what is granted now when that is known (an
 * update starts from the current set), else the recommended set.
 */
export function initialSelection(
  scopes: PermissionScope[],
  granted?: readonly string[],
): { mode: PermissionMode; selected: string[] } {
  if (granted?.length)
    return { mode: "custom", selected: normalizeSelection(granted, scopes) };
  return { mode: "recommended", selected: selectionFor("recommended", scopes) };
}

/**
 * What a selection asks for and how it changes the current grant. With
 * `removes`, scopes left out are no longer held afterwards; otherwise an
 * authorization only adds.
 */
export function permissionPlan(
  selected: readonly string[],
  scopes: PermissionScope[],
  options: {
    granted?: readonly string[];
    always?: readonly string[];
    removes: boolean;
  },
): PermissionPlan {
  const chosen = normalizeSelection(selected, scopes);
  const always = (options.always ?? []).filter((id) => !chosen.includes(id));
  const granted = new Set(options.granted ?? []);
  const held = effectiveScopes(chosen, scopes);
  return {
    request: [...always, ...chosen],
    add: chosen.filter(
      (id) =>
        !granted.has(id) &&
        !(scopes.find((s) => s.id === id)?.impliedBy ?? []).some((parent) =>
          granted.has(parent),
        ),
    ),
    remove: options.removes
      ? [...granted].filter(
          (id) =>
            !held.has(id) &&
            scopes.some((scope) => scope.id === id && !scope.required),
        )
      : [],
  };
}

/** A pasted list (spaces, commas or lines): the listed ids and the rest. */
export function parseScopeList(
  text: string,
  scopes: PermissionScope[],
): { known: string[]; unknown: string[] } {
  const named = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  return {
    known: named.filter((id) => scopes.some((scope) => scope.id === id)),
    unknown: named.filter((id) => !scopes.some((scope) => scope.id === id)),
  };
}

/** Scopes whose id, words or heading contain the filter. */
export function filterScopes(
  scopes: PermissionScope[],
  filter: string,
): PermissionScope[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return scopes;
  return scopes.filter((scope) =>
    [scope.id, scope.label ?? "", scope.area ?? ""].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  );
}

/** Scopes under their headings, in list order. */
export function groupByArea(
  scopes: PermissionScope[],
): { area: string; scopes: PermissionScope[] }[] {
  const groups = new Map<string, PermissionScope[]>();
  for (const scope of scopes) {
    const area = scope.area ?? "";
    groups.set(area, [...(groups.get(area) ?? []), scope]);
  }
  return [...groups.entries()].map(([area, list]) => ({ area, scopes: list }));
}
