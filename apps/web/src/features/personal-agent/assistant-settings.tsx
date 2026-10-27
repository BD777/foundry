import { ToastFeedback } from "../../components/ui/toast";
import {
  DeviceReferences,
  currentDeviceGrants,
} from "./settings-device-references";
import { isRemovedDevice } from "../../lib/devices";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  PersonalAgent,
  PersonalAgentOverview,
  PersonalAgentSettings,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { listAgentProfiles, updatePersonalAgentSettings } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";
import {
  assistantSettingsSections,
  type AssistantSettingsSection,
} from "../../lib/assistant-settings-sections";
import { onStreamEvent } from "../../stream";
import { serverErrorText } from "../../lib/errors";
import {
  loosenedActions,
  settingsProblems,
  type SettingsProblem,
} from "./assistant-model";
import type { AssistantFeatureEvent } from "./assistant-events";
import { AssistantGate } from "./assistant-gate";
import { ActivitySection } from "./settings-activity";
import { EntrySection } from "./settings-entry";
import { LimitsSection } from "./settings-limits";
import { KnowledgeSection } from "./settings-knowledge";
import { MemorySection } from "./settings-memory";
import { MaintenanceSection } from "./settings-maintenance";
import { RoleRuns } from "./settings-runs";
import { ModelsSection } from "./settings-models";
import { PlacesSection } from "./settings-places";
import { RulesSection } from "./settings-rules";
import { StatusSection } from "./settings-status";
import { StyleSection } from "./settings-style";
import { useAssistant, type AssistantController } from "./use-assistant";

export interface AssistantSettingsProps {
  section: AssistantSettingsSection;
  onSectionChange: (section: AssistantSettingsSection) => void;
  devices: DeviceProjection[];
  agentProfiles: AgentProfileProjection[];
  /** For the names of the projects its activity concerns. */
  workspaces: WorkspaceProjection[];
  onEvent: (event: AssistantFeatureEvent) => void;
}

/** The assistant's settings (/assistant/settings/<section>), §11. */
export function AssistantSettings(props: AssistantSettingsProps) {
  const assistant = useAssistant();
  return (
    <PageSurface variant="settings" className="fdy-pa-settings">
      <AssistantGate
        assistant={assistant}
        devices={props.devices}
        onConnectComputer={() => props.onEvent({ type: "devices.open" })}
      >
        {(agent, overview) => (
          <SettingsPanel
            {...props}
            agent={agent}
            assistant={assistant}
            overview={overview}
          />
        )}
      </AssistantGate>
    </PageSurface>
  );
}

function problemText(
  problem: SettingsProblem,
  t: ReturnType<typeof useTranslation<"personalAgent">>["t"],
): string {
  if (problem.kind === "extraInstructions")
    return t("settings.problems.extraInstructions");
  if (problem.kind === "time") return t(`settings.problems.${problem.field}`);
  const label = t(`settings.limits.labels.${problem.key}`);
  return problem.max === undefined
    ? t("settings.problems.limitNoMax", { label, min: problem.min })
    : t("settings.problems.limit", {
        label,
        min: problem.min,
        max: problem.max,
      });
}

function SettingsPanel({
  agent,
  assistant,
  overview,
  section,
  onSectionChange,
  devices,
  agentProfiles,
  workspaces,
  onEvent,
}: AssistantSettingsProps & {
  agent: PersonalAgent;
  assistant: AssistantController;
  overview: PersonalAgentOverview;
}) {
  const { t } = useTranslation("personalAgent");
  const [draft, setDraft] = useState<PersonalAgentSettings>(agent.settings);
  const [hasWorkspaceMemory, setHasWorkspaceMemory] = useState(false);
  // A removal event revokes only that grant, preserving other unsaved edits.
  // Location references stay explicit until the person reconfigures them.
  useEffect(() => {
    setDraft((current) => currentDeviceGrants(current, devices));
  }, [devices]);
  const [catalog, setCatalog] = useState<AgentProfileProjection[]>();
  const [catalogError, setCatalogError] = useState("");
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const allProfiles = catalog ?? agentProfiles;
  useEffect(() => {
    if (section !== "models" && section !== "memory") return;
    let active = true,
      version = 0;
    const read = async () => {
      const current = ++version;
      try {
        const profiles = await listAgentProfiles();
        if (active && current === version) {
          setCatalog(profiles);
          setCatalogError("");
        }
      } catch (error) {
        if (active && current === version)
          setCatalogError(serverErrorText(error));
      }
    };
    void read();
    const stop = onStreamEvent(
      "foundry_data_changed",
      (event) => {
        if (
          !event.resources?.length ||
          event.resources.some((field) =>
            ["agentProfiles", "devices", "workspaces"].includes(field),
          )
        )
          void read();
      },
      { onResync: () => void read() },
    );
    return () => {
      active = false;
      stop();
    };
  }, [section, catalogRefresh]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmLoosen, setConfirmLoosen] = useState(false);
  const currentSettings = currentDeviceGrants(agent.settings, devices);
  const saved = JSON.stringify(currentSettings);
  const dirty = JSON.stringify(draft) !== saved;
  const owned = devices.filter((device) => device.owned);
  const home = devices.find((device) => device.id === agent.homeDeviceId);
  const notice = (message: string) =>
    onEvent({ type: "notice.requested", message });

  // What the server holds now replaces a draft with no changes.
  useEffect(() => {
    if (!dirty) setDraft(currentSettings);
  }, [saved]);

  const change = (patch: Partial<PersonalAgentSettings>) => {
    setConfirmLoosen(false);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const problems = settingsProblems(draft);
  const loosened = loosenedActions(agent.settings.policy, draft.policy);

  async function save(): Promise<void> {
    if (loosened.length && !confirmLoosen) {
      setConfirmLoosen(true);
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const next = await updatePersonalAgentSettings(draft);
      assistant.replaceAgent(next);
      setDraft(next.settings);
      setConfirmLoosen(false);
      onEvent({
        type: "interface.changed",
        mode: next.settings.simpleInterface ? "simple" : "full",
      });
      notice(t("settings.saved"));
    } catch (reason) {
      setSaveError(serverErrorText(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <header className="fdy-pa-settings-head">
        <h1>{t("settings.title")}</h1>
      </header>
      <SegmentedControl
        aria-label={t("settings.sectionsLabel")}
        className="fdy-pa-sections"
        onValueChange={onSectionChange}
        options={assistantSettingsSections.map((value) => ({
          value,
          label: t(`settings.sections.${value}`),
        }))}
        tone="navigation"
        value={section}
      />
      <DeviceReferences agent={agent} draft={draft} devices={devices} />
      <section
        aria-label={t(`settings.sections.${section}`)}
        className="fdy-pa-section"
      >
        {catalogError && (section === "models" || section === "memory") ? (
          <Alert tone="error" title={t("settings.models.catalogFailed")}>
            <p>{catalogError}</p>
            <Button
              size="sm"
              onClick={() => setCatalogRefresh((value) => value + 1)}
            >
              {t("settings.models.refreshCatalog")}
            </Button>
          </Alert>
        ) : null}
        {section === "status" ? (
          <StatusSection
            agent={agent}
            assistant={assistant}
            onNotice={notice}
            owned={owned}
          />
        ) : section === "style" ? (
          <StyleSection change={change} draft={draft} />
        ) : section === "memory" ? (
          <>
            <KnowledgeSection
              devices={devices}
              workspaces={workspaces}
              profiles={allProfiles}
              onLocation={setHasWorkspaceMemory}
            />
            <MemorySection hasWorkspaceMemory={hasWorkspaceMemory} />
          </>
        ) : section === "rules" ? (
          <RulesSection change={change} draft={draft} />
        ) : section === "places" ? (
          <PlacesSection
            change={change}
            draft={draft}
            homeDeviceId={agent.homeDeviceId}
            onOpenComputer={(deviceId) =>
              onEvent({ type: "devices.open", deviceId })
            }
            owned={owned}
          />
        ) : section === "models" ? (
          <>
            <ModelsSection
              agentProfiles={allProfiles}
              devices={owned}
              workspaces={workspaces.filter(
                (w) =>
                  !isRemovedDevice(devices.find((d) => d.id === w.deviceId)),
              )}
              change={change}
              draft={draft}
              home={home}
            />
          </>
        ) : section === "entry" ? (
          <EntrySection change={change} draft={draft} />
        ) : section === "limits" ? (
          <LimitsSection change={change} draft={draft} usage={overview.usage} />
        ) : (
          <>
            <RoleRuns devices={devices} workspaces={workspaces} />
            <MaintenanceSection workspaces={workspaces} />
            <ActivitySection
              projectName={(id) =>
                workspaces.find((workspace) => workspace.id === id)?.name
              }
            />{" "}
          </>
        )}
      </section>
      {dirty ? (
        <div
          className="fdy-pa-savebar"
          role="region"
          aria-label={t("settings.unsaved")}
        >
          {problems.length ? (
            <Alert tone="warning" title={t("settings.unsaved")}>
              <ul className="fdy-pa-problems">
                {problems.map((problem) => (
                  <li key={problemText(problem, t)}>
                    {problemText(problem, t)}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : confirmLoosen ? (
            <Alert tone="warning" title={t("settings.loosen.title")}>
              {t("settings.loosen.body", {
                actions: loosened
                  .map((action) => t(`settings.rules.actions.${action}`))
                  .join("; "),
              })}
            </Alert>
          ) : (
            <p className="fdy-pa-muted">{t("settings.unsaved")}</p>
          )}
          {saveError ? (
            <ToastFeedback tone="error" title={t("settings.saveFailed")}>
              {saveError}
            </ToastFeedback>
          ) : null}
          <div className="fdy-pa-inline">
            <Button
              aria-busy={saving}
              disabled={saving || problems.length > 0}
              onClick={() => void save()}
              variant="primary"
            >
              {saving
                ? t("settings.saving")
                : confirmLoosen
                  ? t("settings.loosen.confirm")
                  : t("settings.save")}
            </Button>
            <Button
              disabled={saving}
              onClick={() => {
                setDraft(currentSettings);
                setConfirmLoosen(false);
                setSaveError("");
              }}
              variant="ghost"
            >
              {t("settings.discard")}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
