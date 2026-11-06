import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import type {
  ConnectorAuthorizationGroup,
  ConnectorScopeChange,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { CheckLabel } from "../../components/ui/check-label";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import {
  Checkbox,
  FieldHint,
  Textarea,
  TextInput,
} from "../../components/ui/field";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { MutedText } from "../../components/ui/text";
import { relativeWhen } from "./account-format";
import { localized } from "./connector-text";
import {
  filterScopes,
  groupByArea,
  initialSelection,
  normalizeSelection,
  parseScopeList,
  permissionPlan,
  selectionFor,
  type PermissionMode,
  type PermissionScope,
} from "./permission-selection";

export interface PermissionSource {
  label: string;
  url?: string;
  /** The vendor's authoritative list of every scope: only then is there "All". */
  complete: boolean;
}

export interface PermissionPickerProps {
  scopes: PermissionScope[];
  source?: PermissionSource;
  /** Asked for on every authorization (offline_access…), not choosable. */
  always?: string[];
  /** Granted now, read back from the vendor. */
  granted?: string[];
  /** Leaving a granted scope out removes it (otherwise authorizing only adds). */
  removes: boolean;
  /** Why leaving out removes: the tool drops it, or a new grant replaces the old. */
  removal?: "drops" | "replaces";
  lastChange?: ConnectorScopeChange;
  /** Preselected on top of the starting set (a deep link naming a scope). */
  preselect?: string[];
  submitLabel: string;
  busy?: boolean;
  onSubmit: (request: string[], selected: string[]) => void;
}

const linkClass =
  "inline-flex w-fit items-center gap-1 text-brand underline underline-offset-3";
const scopeListClass =
  "block max-h-24 overflow-auto rounded-sm bg-inset px-2 py-1.5 font-mono text-xs leading-normal break-all text-ink-2";

/**
 * The one permission-set choice of every connector (DEV-136): recommended,
 * all (only from an authoritative list), or a custom pick with a filter
 * and a pasted list; shows exactly what is asked for and how it changes
 * what is granted now.
 */
export function PermissionPicker({
  scopes,
  source,
  always = [],
  granted,
  removes,
  removal = "drops",
  lastChange,
  preselect = [],
  submitLabel,
  busy,
  onSubmit,
}: PermissionPickerProps) {
  const { t } = useTranslation("externalAccounts");
  const start = useMemo(() => {
    const initial = initialSelection(scopes, granted);
    const extra = preselect.filter((id) => scopes.some((s) => s.id === id));
    return extra.length
      ? {
          mode: "custom" as const,
          selected: normalizeSelection([...initial.selected, ...extra], scopes),
        }
      : initial;
  }, []);
  const [mode, setMode] = useState<PermissionMode>(start.mode);
  const [selected, setSelected] = useState<string[]>(start.selected);
  const [filter, setFilter] = useState("");
  const [pasted, setPasted] = useState("");
  const [unknown, setUnknown] = useState<string[]>([]);
  const chosen = normalizeSelection(selected, scopes);
  const plan = permissionPlan(chosen, scopes, { granted, always, removes });
  const heldBySelection = (scope: PermissionScope) =>
    (scope.impliedBy ?? []).find((parent) => chosen.includes(parent));
  const shown = filterScopes(scopes, filter);
  const choose = (next: string[]) => {
    setMode("custom");
    setSelected(normalizeSelection(next, scopes));
  };
  const modes: { value: PermissionMode; label: string }[] = [
    { value: "recommended", label: t("authorization.recommended") },
    ...(source?.complete
      ? [{ value: "all" as const, label: t("authorization.all") }]
      : []),
    { value: "custom", label: t("authorization.custom") },
  ];

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-2">
        <SegmentedControl
          aria-label={t("authorization.permissions")}
          fill
          onValueChange={(value) => {
            setMode(value);
            if (value !== "custom") setSelected(selectionFor(value, scopes));
          }}
          options={modes}
          value={mode}
        />
        {source ? (
          <MutedText>
            {source.complete
              ? t("authorization.sourceComplete", { source: source.label })
              : t("authorization.sourcePartial", { source: source.label })}{" "}
            {source.url ? (
              <a
                className={linkClass}
                href={source.url}
                rel="noreferrer"
                target="_blank"
              >
                {t("authorization.sourceLink")}
                <ExternalLink aria-hidden="true" size={13} />
              </a>
            ) : null}
          </MutedText>
        ) : null}
        {lastChange ? <ScopeChangeNote change={lastChange} /> : null}
      </div>

      {mode === "custom" ? (
        <div className="grid gap-2">
          {scopes.length > 12 ? (
            <TextInput
              aria-label={t("authorization.filter")}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("authorization.filterPlaceholder")}
              tone="boxed"
              type="search"
              value={filter}
            />
          ) : null}
          <ScrollArea className="max-h-56 rounded-sm shadow-hairline">
            <div className="grid gap-3 p-3">
              {groupByArea(shown).map((group) => (
                <fieldset className="grid min-w-0 gap-2" key={group.area}>
                  {group.area ? (
                    <legend className="mb-1 text-xs font-medium text-ink-2">
                      {group.area}
                    </legend>
                  ) : null}
                  {group.scopes.map((scope) => {
                    const parent = heldBySelection(scope);
                    const checked = chosen.includes(scope.id) || !!parent;
                    return (
                      <CheckLabel key={scope.id}>
                        <Checkbox
                          checked={checked}
                          disabled={
                            busy ||
                            !!scope.required ||
                            !!parent ||
                            (!!scope.unavailable && !checked)
                          }
                          onChange={(event) =>
                            choose(
                              event.target.checked
                                ? [...chosen, scope.id]
                                : chosen.filter((id) => id !== scope.id),
                            )
                          }
                        />
                        <span>
                          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                            {scope.label ?? scope.id}
                            {granted?.includes(scope.id) ? (
                              <Badge tone="online">
                                {t("authorization.granted")}
                              </Badge>
                            ) : null}
                          </span>
                          <FieldHint as="small" className="mt-0">
                            {[
                              scope.label ? scope.id : "",
                              scope.required
                                ? t("authorization.requiredHint")
                                : "",
                              parent
                                ? t("authorization.includedIn", {
                                    scope: parent,
                                  })
                                : "",
                              scope.approval
                                ? t("authorization.approvalHint")
                                : "",
                              scope.unavailable
                                ? t("authorization.unavailableHint")
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </FieldHint>
                        </span>
                      </CheckLabel>
                    );
                  })}
                </fieldset>
              ))}
              {!shown.length ? (
                <MutedText>{t("authorization.noMatch")}</MutedText>
              ) : null}
            </div>
          </ScrollArea>
          <Disclosure>
            <DisclosureSummary>
              {t("authorization.manualTitle")}
            </DisclosureSummary>
            <Textarea
              aria-label={t("authorization.manualTitle")}
              onChange={(event) => setPasted(event.target.value)}
              placeholder={t("authorization.manualPlaceholder")}
              rows={3}
              tone="boxed"
              value={pasted}
            />
            <FieldHint as="small">{t("authorization.manualHint")}</FieldHint>
            <ButtonRow align="end" as="span">
              <Button
                disabled={busy || !pasted.trim()}
                onClick={() => {
                  const list = parseScopeList(pasted, scopes);
                  setUnknown(list.unknown);
                  choose(list.known);
                }}
                size="sm"
              >
                {t("authorization.manualApply")}
              </Button>
            </ButtonRow>
            {unknown.length ? (
              <FieldHint as="small" tone="warning">
                {t("authorization.manualUnknown", {
                  scopes: unknown.join(", "),
                })}
              </FieldHint>
            ) : null}
          </Disclosure>
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <MutedText>
          {t("authorization.requesting", { count: plan.request.length })}
        </MutedText>
        <code className={scopeListClass}>{plan.request.join(" ")}</code>
        {granted ? (
          <MutedText>
            {plan.add.length || plan.remove.length
              ? [
                  plan.add.length
                    ? t("authorization.adds", { scopes: plan.add.join(", ") })
                    : "",
                  plan.remove.length
                    ? t("authorization.removes", {
                        scopes: plan.remove.join(", "),
                      })
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : t("authorization.noChange")}
          </MutedText>
        ) : null}
        <FieldHint>
          {removes
            ? t(
                removal === "replaces"
                  ? "authorization.replacesNote"
                  : "authorization.removesNote",
              )
            : t("authorization.additiveNote")}
        </FieldHint>
      </div>
      <Button
        disabled={busy || !chosen.length}
        onClick={() => onSubmit(plan.request, chosen)}
        variant="primary"
      >
        {submitLabel}
      </Button>
    </div>
  );
}

/** "Changed outside Foundry 2 hours ago: +workflow". */
export function ScopeChangeNote({ change }: { change: ConnectorScopeChange }) {
  const { t } = useTranslation("externalAccounts");
  const parts = [
    ...change.added.map((scope) => `+${scope}`),
    ...change.removed.map((scope) => `−${scope}`),
  ].join(" ");
  return (
    <MutedText
      as="small"
      className="block"
      tone={change.source === "outside" ? "warning" : undefined}
    >
      {t(
        change.source === "outside"
          ? "authorization.changedOutside"
          : "authorization.changedInFoundry",
        { when: relativeWhen(change.at), scopes: parts },
      )}
    </MutedText>
  );
}

/** A device connector's authorization group as a permission list. */
export function groupScopes(
  group: ConnectorAuthorizationGroup,
): PermissionScope[] {
  return (group.scopes ?? []).map((scope) => ({
    id: scope.id,
    label: localized(scope.label, scope.labels),
    recommended: scope.recommended,
    required: scope.required,
    impliedBy: scope.impliedBy,
  }));
}

/** The picker for a device connector's authorization group. */
export function AuthorizationScopePicker({
  group,
  granted,
  lastChange,
  preselect,
  submitLabel,
  onStart,
}: {
  group: ConnectorAuthorizationGroup;
  granted?: string[];
  lastChange?: ConnectorScopeChange;
  preselect?: string[];
  submitLabel?: string;
  onStart: (options: Record<string, string>) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const source = group.scopeSource;
  return (
    <PermissionPicker
      granted={granted}
      lastChange={lastChange}
      onSubmit={(_request, selected) => onStart({ scopes: selected.join(",") })}
      preselect={preselect}
      removes={!!group.scopesRemovable}
      scopes={groupScopes(group)}
      source={
        source
          ? {
              label: localized(source.label, source.labels),
              url: source.url,
              complete: source.complete,
            }
          : undefined
      }
      submitLabel={submitLabel ?? t("authorization.authorizeSelected")}
    />
  );
}
