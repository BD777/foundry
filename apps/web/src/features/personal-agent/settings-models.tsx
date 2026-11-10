import { useEffect, useId, useMemo, useState } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  PersonalAgentRunPreference,
  PersonalAgentSettings,
  PersonalAgentWhenUnavailable,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";
import { useProfileModels } from "../../components/workspace/agent-default-fields";
import {
  claudeEffortOptions,
  codexEffortOptions,
} from "../../lib/agent-effort";
import { navigateAppRoute } from "../../lib/in-app-navigation";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { runtimeMeta } from "../../components/agent-runtime/runtime-mark";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../components/ui/select-menu";
import { FieldHint } from "../../components/ui/field";
import { Button } from "../../components/ui/button";
import { renderMermaidSvg } from "../../components/conversation/markdown-mermaid";
import { useFoundryTheme } from "../../components/ui/theme-context";
import { cn } from "../../lib/cn";
import {
  SettingsField,
  SettingsGroup,
  type ChangeSettings,
} from "./settings-field";

/** The assistant's flows besides its conversation (§g), in the page's order. */
const flows = ["executor", "digest", "memory", "governance"] as const;
type Flow = (typeof flows)[number];

type DiagramLabel =
  | "you"
  | "coordinator"
  | "dispatch"
  | "executor"
  | "report"
  | "notices"
  | "ended"
  | "digest"
  | "files"
  | "governance"
  | "patch"
  | "entries"
  | "memory";

/**
 * The topology of the flows: which event starts which flow, and which flow
 * feeds another, one chain per line. Flows are emphasized; events are not.
 */
const topology: { step: DiagramLabel; flow?: boolean }[][] = [
  [
    { step: "you" },
    { step: "coordinator", flow: true },
    { step: "dispatch" },
    { step: "executor", flow: true },
    { step: "report" },
    { step: "notices" },
    { step: "coordinator", flow: true },
  ],
  [{ step: "ended" }, { step: "digest", flow: true }],
  [
    { step: "files" },
    { step: "governance", flow: true },
    { step: "patch" },
    { step: "digest", flow: true },
  ],
  [{ step: "entries" }, { step: "memory", flow: true }],
];

/** Steps that label the arrow between two others rather than a box. */
const connectors = new Set<DiagramLabel>(["dispatch", "report", "patch"]);

const mermaidText = (text: string) => text.replaceAll('"', "#quot;");

/** The topology as a Mermaid flowchart: flows are boxes, events rounded. */
export function topologyChart(label: (step: DiagramLabel) => string): string {
  const lines = ["flowchart TB"];
  const nodes = new Set<DiagramLabel>();
  const edges = new Set<string>();
  for (const chain of topology) {
    let from: DiagramLabel | undefined;
    let via: DiagramLabel | undefined;
    for (const link of chain) {
      if (connectors.has(link.step)) {
        via = link.step;
        continue;
      }
      if (!nodes.has(link.step)) {
        nodes.add(link.step);
        const text = mermaidText(label(link.step));
        lines.push(
          link.flow
            ? `  ${link.step}["${text}"]:::flow`
            : `  ${link.step}("${text}"):::event`,
        );
      }
      if (from) {
        const arrow = via ? `-->|"${mermaidText(label(via))}"|` : "-->";
        edges.add(`  ${from} ${arrow} ${link.step}`);
      }
      from = link.step;
      via = undefined;
    }
  }
  lines.push(
    ...edges,
    "  classDef flow stroke-width:2px",
    "  classDef event fill:none,stroke-dasharray:4 3",
  );
  return lines.join("\n");
}

/**
 * The topology as a diagram, with the chains as a list for screen readers.
 * The list shows instead on a narrow screen, where the diagram's words get
 * too small, while the diagram draws, and if it cannot.
 */
function FlowTopology() {
  const { t } = useTranslation("personalAgent");
  const theme = useFoundryTheme();
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const chart = useMemo(
    () => topologyChart((step) => t(`settings.models.diagram.${step}`)),
    [t],
  );
  const [drawn, setDrawn] = useState<{ source: string; svg: string }>();
  const source = `${theme}\n${chart}`;
  useEffect(() => {
    let cancelled = false;
    renderMermaidSvg(`flows-${id}`, chart, theme).then(
      (svg) => {
        if (!cancelled) setDrawn({ source, svg });
      },
      (error: unknown) => {
        if (!cancelled) setDrawn(undefined);
        console.error("The assistant's flow diagram failed to draw", error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [chart, id, source, theme]);
  const svg = drawn?.source === source ? drawn.svg : undefined;
  return (
    <>
      {svg ? (
        <div
          aria-hidden="true"
          className="hidden w-full place-items-center rounded-lg border border-line p-3 sm:grid [&_svg]:block [&_svg]:max-w-full"
          // Mermaid's own output, drawn with securityLevel "strict" from
          // the page's fixed labels.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : null}
      <ol
        aria-label={t("settings.models.diagram.label")}
        className={cn(
          "m-0 grid w-full list-none gap-1.5 rounded-lg border border-line p-3 text-xs leading-[1.6] text-ink-muted",
          svg && "sm:sr-only",
        )}
      >
        {topology.map((chain, index) => (
          <li
            className="flex min-w-0 flex-wrap items-center gap-x-1.5"
            key={index}
          >
            {chain.map((link, at) => (
              <span className="inline-flex items-center gap-x-1.5" key={at}>
                {at > 0 ? (
                  <ArrowRight aria-hidden className="flex-none" size={12} />
                ) : null}
                <span
                  className={link.flow ? "font-semibold text-ink" : undefined}
                >
                  {t(`settings.models.diagram.${link.step}`)}
                </span>
              </span>
            ))}
          </li>
        ))}
      </ol>
    </>
  );
}

export function ModelsSection({
  draft,
  change,
  agentProfiles,
  home,
  devices,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
  agentProfiles: AgentProfileProjection[];
  home: DeviceProjection | undefined;
  devices: DeviceProjection[];
  workspaces?: WorkspaceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const ownOverride = draft.roleOverrides?.coordinator;
  const assistant: PersonalAgentRunPreference = ownOverride ??
    draft.runDefault ?? {
      profileId: draft.assistantProfileId || "device_default",
      model: draft.assistantModel,
    };
  // The assistant runs on its home computer; its choice carries no
  // computer, so the flows that follow it run on each project's computer.
  const updateAssistant = (value: PersonalAgentRunPreference) => {
    const next = { ...value, deviceId: undefined };
    const assistantProfileId =
      next.profileId === "device_default" ? "" : (next.profileId ?? "");
    if (ownOverride)
      change({
        roleOverrides: { ...draft.roleOverrides, coordinator: next },
      });
    else
      change({
        runDefault: next,
        assistantProfileId,
        assistantModel: next.model ?? "",
      });
  };
  const sources = everySource(agentProfiles, devices);
  return (
    <>
      <FieldHint>{t("settings.models.flowsIntro")}</FieldHint>
      <FlowTopology />
      <SettingsGroup title={t("settings.models.flows.coordinator.title")}>
        <FieldHint>{t("settings.models.flows.coordinator.trigger")}</FieldHint>
        <FieldHint>
          {t("settings.models.assistantIntro", {
            device: home?.label ?? t("settings.models.homeComputer"),
          })}
        </FieldHint>
        <ChoiceFields
          title={t("settings.models.flows.coordinator.title")}
          value={assistant}
          onChange={(patch) => updateAssistant({ ...assistant, ...patch })}
          sources={homeSources(agentProfiles, home?.id)}
          defaultLabel={t("settings.models.homeDefault")}
        />
      </SettingsGroup>
      {flows.map((flow) => (
        <FlowChoice
          change={change}
          draft={draft}
          flow={flow}
          key={flow}
          sources={sources}
        />
      ))}
      <p className="m-0 flex flex-wrap items-center gap-x-2 text-xs leading-[1.6] text-ink-muted">
        <span>{t("settings.models.chatUnaffected")}</span>
        <Button
          variant="link"
          size="sm"
          onClick={() => navigateAppRoute({ view: "profiles" })}
        >
          {t("settings.models.manageProviders")}
          <ChevronRight size={14} aria-hidden />
        </Button>
      </p>
      <FieldHint>{t("settings.models.applyNext")}</FieldHint>
    </>
  );
}

/** How a flow chooses its model. */
type FlowMode = "same" | "each" | "chosen";

function flowModeOf(draft: PersonalAgentSettings, flow: Flow): FlowMode {
  const own = draft.roleOverrides?.[flow];
  if (own)
    return (!own.profileId || own.profileId === "device_default") &&
      !own.model &&
      !own.runtime
      ? "each"
      : "chosen";
  // Without its own choice, the work handed off follows DEV-150's setting;
  // every other flow follows the assistant.
  if (flow === "executor")
    return draft.runDefault || draft.delegateModel === "same_as_assistant"
      ? "same"
      : "each";
  return "same";
}

/** One flow: when it runs, and the model it runs on. */
function FlowChoice({
  draft,
  change,
  flow,
  sources,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
  flow: Flow;
  sources: Source[];
}) {
  const { t } = useTranslation("personalAgent");
  const saved = flowModeOf(draft, flow);
  // "Choose one" stays shown while its source is still to be picked.
  const [picking, setPicking] = useState(false);
  const mode: FlowMode = picking ? "chosen" : saved;
  const own = draft.roleOverrides?.[flow];
  const title = t(`settings.models.flows.${flow}.title`);
  // Budgets and fallbacks set earlier carry over.
  const keep: PersonalAgentRunPreference = {
    ...(own?.tokenBudget ? { tokenBudget: own.tokenBudget } : {}),
    ...(own?.timeoutMinutes ? { timeoutMinutes: own.timeoutMinutes } : {}),
    ...(own?.fallbacks?.length ? { fallbacks: own.fallbacks } : {}),
  };
  const withOwn = (value: PersonalAgentRunPreference | undefined) => {
    const roleOverrides = { ...draft.roleOverrides };
    if (value) roleOverrides[flow] = value;
    else delete roleOverrides[flow];
    return roleOverrides;
  };
  const setMode = (next: FlowMode) => {
    setPicking(next === "chosen" && saved !== "chosen");
    if (next === saved) return;
    if (next === "same")
      change(
        flow === "executor"
          ? {
              roleOverrides: withOwn(undefined),
              delegateModel: "same_as_assistant",
            }
          : { roleOverrides: withOwn(undefined) },
      );
    else if (next === "each")
      change(
        flow === "executor"
          ? {
              roleOverrides: withOwn({ ...keep, profileId: "device_default" }),
              delegateModel: "device_default",
            }
          : {
              roleOverrides: withOwn({ ...keep, profileId: "device_default" }),
            },
      );
  };
  const value: PersonalAgentRunPreference =
    mode === "chosen" && own && saved === "chosen" ? own : { profileId: "" };
  return (
    <SettingsGroup title={title}>
      <FieldHint>{t(`settings.models.flows.${flow}.trigger`)}</FieldHint>
      <FieldHint>{t(`settings.models.flows.${flow}.what`)}</FieldHint>
      <SettingsField label={t("settings.models.flowMode")}>
        <SegmentedControl
          aria-label={`${title} ${t("settings.models.flowMode")}`}
          value={mode}
          onValueChange={setMode}
          options={(["same", "each", "chosen"] as const).map((option) => ({
            value: option,
            label: t(`settings.models.helperModes.${option}`),
          }))}
        />
      </SettingsField>
      {mode === "chosen" ? (
        <>
          <ChoiceFields
            title={title}
            value={value}
            sources={sources}
            chooseLabel={t("settings.models.chooseSource")}
            onChange={(patch) => {
              const next = { ...keep, ...value, ...patch, deviceId: undefined };
              if (next.profileId) {
                setPicking(false);
                change({ roleOverrides: withOwn(next) });
              }
            }}
          />
          <SettingsField
            label={t("settings.models.whenUnavailable")}
            hint={t("settings.models.whenUnavailableHint")}
          >
            <SelectMenu
              ariaLabel={`${title} ${t("settings.models.whenUnavailable")}`}
              className="max-w-full min-w-55"
              disabled={!own || saved !== "chosen"}
              value={own?.whenUnavailable || "wait"}
              options={(["wait", "device_default"] as const).map((option) => ({
                value: option,
                label: t(`settings.models.whenUnavailableOptions.${option}`),
              }))}
              onChange={(whenUnavailable) =>
                own &&
                change({
                  roleOverrides: withOwn({
                    ...own,
                    whenUnavailable:
                      whenUnavailable as PersonalAgentWhenUnavailable,
                  }),
                })
              }
            />
          </SettingsField>
        </>
      ) : (
        <FieldHint>
          {t(
            mode === "same"
              ? "settings.models.flowSameHint"
              : "settings.models.helperEachHint",
          )}
        </FieldHint>
      )}
    </SettingsGroup>
  );
}

/** One model source as the pickers offer it. */
interface Source {
  id: string;
  label: string;
  runtime: AgentProfileProjection["runtime"];
  /** The profile whose model list the model select shows. */
  catalog: AgentProfileProjection;
  meta: string;
  disabled?: boolean;
}

/** The home computer's sources: its sign-ins and the APIs assigned to it. */
function homeSources(
  profiles: AgentProfileProjection[],
  homeId: string | undefined,
): Source[] {
  return profiles
    .filter((profile) => !homeId || profile.deviceId === homeId)
    .map((profile) => ({
      id: profile.id,
      label: profile.label,
      runtime: profile.runtime,
      catalog: profile,
      meta: `${runtimeMeta(profile.runtime).label} · ${i18n.t(
        profile.status === "healthy"
          ? "personalAgent:settings.models.available"
          : "personalAgent:settings.models.unavailable",
      )}`,
    }));
}

/**
 * Sources across the person's computers, one per id: a sign-in has the same
 * id on every computer and a server API is assigned to several, so a helper
 * choice is resolved on each project's own computer.
 */
function everySource(
  profiles: AgentProfileProjection[],
  devices: DeviceProjection[],
): Source[] {
  const own = new Set(devices.map((device) => device.id));
  const byId = new Map<string, AgentProfileProjection[]>();
  for (const profile of profiles) {
    if (!own.has(profile.deviceId)) continue;
    byId.set(profile.id, [...(byId.get(profile.id) ?? []), profile]);
  }
  const online = new Set(
    devices
      .filter((device) => device.status === "connected")
      .map((device) => device.id),
  );
  return [...byId.values()].map((found) => {
    const ready = found.filter((profile) => profile.status === "healthy");
    // The model list comes from a computer that can answer now.
    const catalog =
      ready.find((profile) => online.has(profile.deviceId)) ??
      ready[0] ??
      found[0]!;
    return {
      id: catalog.id,
      label: catalog.label,
      runtime: catalog.runtime,
      catalog,
      meta: `${runtimeMeta(catalog.runtime).label} · ${i18n.t(
        "personalAgent:settings.models.onComputers",
        { count: ready.length, total: devices.length },
      )}`,
    };
  });
}

/** A source, its model and the effort: selection only. */
function ChoiceFields({
  title,
  value,
  sources,
  defaultLabel,
  chooseLabel,
  onChange,
}: {
  title: string;
  value: PersonalAgentRunPreference;
  sources: Source[];
  /** Offered first: the computer's own default; omitted, a source is required. */
  defaultLabel?: string;
  chooseLabel?: string;
  onChange: (patch: Partial<PersonalAgentRunPreference>) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const followsDefault =
    !value.profileId || value.profileId === "device_default";
  const chosen = followsDefault
    ? undefined
    : sources.find((source) => source.id === value.profileId);
  // A computer's default with a runtime named lists that runtime's models.
  const catalog =
    chosen ??
    (followsDefault && value.runtime
      ? sources.find((source) => source.runtime === value.runtime)
      : undefined);
  const { models, loading } = useProfileModels(catalog?.catalog);
  const options: SelectMenuOption[] = [
    ...(defaultLabel ? [{ value: "device_default", label: defaultLabel }] : []),
    ...sources.map((source) => ({
      value: source.id,
      label: source.label,
      meta: source.meta,
    })),
  ];
  if (!followsDefault && !chosen)
    options.push({
      value: value.profileId!,
      label: t("settings.models.missingChoice", { name: value.profileId }),
      disabled: true,
    });
  const modelOptions: SelectMenuOption[] = [
    { value: "", label: t("settings.models.modelDefault") },
    ...models.map((model) => ({ value: model, label: model })),
  ];
  if (value.model && !models.includes(value.model))
    modelOptions.push({
      value: value.model,
      label: t("settings.models.missingChoice", { name: value.model }),
    });
  const runtime = catalog?.runtime ?? value.runtime;
  const efforts =
    runtime === "codex"
      ? codexEffortOptions()
      : runtime === "claude"
        ? claudeEffortOptions()
        : [];
  return (
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
      <SettingsField label={t("settings.models.provider")}>
        <SelectMenu
          ariaLabel={`${title} ${t("settings.models.provider")}`}
          className="w-full max-w-full"
          options={options}
          placeholder={chooseLabel}
          value={
            followsDefault
              ? defaultLabel
                ? "device_default"
                : ""
              : (value.profileId ?? "")
          }
          onChange={(profileId) => {
            const source = sources.find((s) => s.id === profileId);
            onChange({
              profileId,
              runtime: source?.runtime ?? "",
              model: "",
              effort: "",
            });
          }}
        />
      </SettingsField>
      <SettingsField label={t("settings.models.model")}>
        <SelectMenu
          ariaLabel={`${title} ${t("settings.models.model")}`}
          busy={loading}
          className="w-full max-w-full"
          disabled={!catalog}
          options={modelOptions}
          value={value.model ?? ""}
          onChange={(model) => onChange({ model })}
        />
      </SettingsField>
      <SettingsField label={t("settings.models.effort")}>
        <SelectMenu
          ariaLabel={`${title} ${t("settings.models.effort")}`}
          className="w-full max-w-full"
          disabled={!catalog}
          options={[
            { value: "", label: t("settings.models.modelDefault") },
            ...efforts,
          ]}
          value={value.effort ?? ""}
          onChange={(effort) => onChange({ effort })}
        />
      </SettingsField>
    </div>
  );
}
