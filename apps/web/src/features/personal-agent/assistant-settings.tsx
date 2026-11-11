import { DeviceReferences } from "./settings-device-references";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import type {
  AgentProfileProjection,
  ConnectorAccessLevel,
  DeviceProjection,
  PersonalAgent,
  PersonalAgentConnector,
  PersonalAgentOverview,
  PersonalAgentSettings,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import {
  getPersonalAgentConnectors,
  listAgentProfiles,
  setPersonalAgentConnectors,
  updatePersonalAgentSettings,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { AppLink } from "../../components/ui/app-link";
import { Button } from "../../components/ui/button";
import { PageHeader, SectionHeader } from "../../components/ui/page-header";
import { PageSurface } from "../../components/ui/page-surface";
import { SectionPanel } from "../../components/ui/section-panel";
import { ToastFeedback } from "../../components/ui/toast";
import { type AssistantSettingsSection } from "../../lib/assistant-settings-sections";
import { pathForAppRoute } from "../../lib/routes";
import { cn } from "../../lib/cn";
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
import { ConnectorsSection, connectorLevels } from "./settings-connectors";
import { EntrySection } from "./settings-entry";
import { LimitsSection } from "./settings-limits";
import { KnowledgeSection } from "./settings-knowledge";
import { MemorySection } from "./settings-memory";
import { MaintenanceSection } from "./settings-maintenance";
import { RoleRuns } from "./settings-runs";
import { ModelsSection } from "./settings-models";
import { ButtonRow } from "../../components/ui/button-row";
import { PaMuted } from "./pa-muted";
import { PlacesSection } from "./settings-places";
import { RulesSection } from "./settings-rules";
import { StatusSection } from "./settings-status";
import { StyleSection } from "./settings-style";
import { useAssistant, type AssistantController } from "./use-assistant";
import { AssistantSettingsNav } from "./assistant-settings-nav";

export interface AssistantSettingsProps {
  /** Omitted by /assistant/settings: the narrow index, or Status when wide. */
  section?: AssistantSettingsSection;
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
    <PageSurface variant="settings">
      <AssistantGate
        assistant={assistant}
        devices={props.devices}
        className="pt-6"
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
  const activeSection = section ?? "status";
  const [draft, setDraft] = useState<PersonalAgentSettings>(agent.settings);
  const [connectors, setConnectors] = useState<PersonalAgentConnector[]>();
  const [savedConnectors, setSavedConnectors] =
    useState<PersonalAgentConnector[]>();
  const [connectorLoadError, setConnectorLoadError] = useState("");
  const [connectorReadVersion, setConnectorReadVersion] = useState(0);
  const [hasWorkspaceMemory, setHasWorkspaceMemory] = useState(false);
  const [catalog, setCatalog] = useState<AgentProfileProjection[]>();
  const [catalogError, setCatalogError] = useState("");
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const allProfiles = catalog ?? agentProfiles;
  useEffect(() => {
    if (activeSection !== "models" && activeSection !== "memory") return;
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
  }, [activeSection, catalogRefresh]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmLoosen, setConfirmLoosen] = useState(false);
  const saved = JSON.stringify(agent.settings);
  const settingsDirty = JSON.stringify(draft) !== saved;
  const connectorDraft = JSON.stringify(
    connectors ? connectorLevels(connectors) : [],
  );
  const connectorSaved = JSON.stringify(
    savedConnectors ? connectorLevels(savedConnectors) : [],
  );
  const connectorsDirty =
    connectors !== undefined && connectorDraft !== connectorSaved;
  const dirty = settingsDirty || connectorsDirty;
  const owned = devices.filter((device) => device.owned);
  const home = devices.find((device) => device.id === agent.homeDeviceId);
  const notice = (message: string) =>
    onEvent({ type: "notice.requested", message });

  // What the server holds now replaces a draft with no changes.
  useEffect(() => {
    if (!settingsDirty) setDraft(agent.settings);
  }, [saved]);

  useEffect(() => {
    if (activeSection !== "connectors" || connectors !== undefined) return;
    let active = true;
    setConnectorLoadError("");
    getPersonalAgentConnectors().then(
      (view) => {
        if (!active) return;
        setConnectors(view.connectors);
        setSavedConnectors(view.connectors);
      },
      (reason: unknown) => {
        if (!active) return;
        setConnectorLoadError(serverErrorText(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [activeSection, connectorReadVersion]);

  const change = (patch: Partial<PersonalAgentSettings>) => {
    setConfirmLoosen(false);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const problems = settingsProblems(draft);
  const loosened = loosenedActions(agent.settings.policy, draft.policy);

  async function save(): Promise<void> {
    if (settingsDirty && loosened.length && !confirmLoosen) {
      setConfirmLoosen(true);
      return;
    }
    setSaving(true);
    setSaveError("");
    let failure = "";
    if (settingsDirty) {
      try {
        const next = await updatePersonalAgentSettings(draft);
        assistant.replaceAgent(next);
        setDraft(next.settings);
      } catch (reason) {
        failure = serverErrorText(reason);
      }
    }
    if (connectorsDirty && connectors) {
      try {
        const next = await setPersonalAgentConnectors(
          connectorLevels(connectors),
        );
        setConnectors(next.connectors);
        setSavedConnectors(next.connectors);
      } catch (reason) {
        failure = [failure, serverErrorText(reason)].filter(Boolean).join("\n");
      }
    }
    if (failure) {
      setSaveError(failure);
      setSaving(false);
      return;
    }
    setConfirmLoosen(false);
    if (settingsDirty) {
      onEvent({
        type: "interface.changed",
        mode: draft.simpleInterface ? "simple" : "full",
      });
    }
    notice(t("settings.saved"));
    setSaving(false);
  }

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        title={t("settings.title")}
        description={t("settings.description")}
      />
      <div className="grid min-w-0 gap-6 xl:grid-cols-[220px_minmax(0,1fr)] xl:items-start">
        <div className="grid min-w-0 gap-4.5 xl:col-start-2 xl:row-start-1">
          {section ? (
            <Button
              asChild
              className="justify-self-start xl:hidden"
              size="sm"
              variant="ghost"
            >
              <AppLink href={pathForAppRoute({ view: "assistantSettings" })}>
                <ArrowLeft aria-hidden="true" size={14} />
                {t("settings.allSections")}
              </AppLink>
            </Button>
          ) : null}
          <DeviceReferences agent={agent} draft={draft} devices={devices} />
          <SectionPanel
            aria-labelledby="fdy-assistant-settings-section"
            className={cn(section === undefined && "max-xl:hidden")}
            data-assistant-settings-panel={activeSection}
            role="region"
            spacing="flush"
            variant="plain"
          >
            <SectionHeader
              title={t(`settings.sections.${activeSection}`)}
              description={t(`settings.hints.${activeSection}`)}
              titleId="fdy-assistant-settings-section"
            />
            {catalogError &&
            (activeSection === "models" || activeSection === "memory") ? (
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
            {activeSection === "status" ? (
              <StatusSection
                agent={agent}
                assistant={assistant}
                onNotice={notice}
                owned={owned}
              />
            ) : activeSection === "style" ? (
              <StyleSection change={change} draft={draft} />
            ) : activeSection === "memory" ? (
              <>
                <KnowledgeSection
                  devices={devices}
                  workspaces={workspaces}
                  profiles={allProfiles}
                  onLocation={setHasWorkspaceMemory}
                />
                <MemorySection hasWorkspaceMemory={hasWorkspaceMemory} />
              </>
            ) : activeSection === "rules" ? (
              <RulesSection change={change} draft={draft} />
            ) : activeSection === "places" ? (
              <PlacesSection
                change={change}
                draft={draft}
                homeDeviceId={agent.homeDeviceId}
                onOpenComputer={(deviceId) =>
                  onEvent({ type: "devices.open", deviceId })
                }
                owned={owned}
              />
            ) : activeSection === "models" ? (
              <ModelsSection
                agentProfiles={allProfiles}
                devices={owned}
                workspaces={workspaces}
                change={change}
                draft={draft}
                home={home}
              />
            ) : activeSection === "connectors" ? (
              <ConnectorsSection
                connectors={connectors}
                disabled={saving}
                loadError={connectorLoadError}
                onChange={(accountId, level: ConnectorAccessLevel) => {
                  setConnectors((current) =>
                    current?.map((connector) =>
                      connector.id === accountId
                        ? { ...connector, level }
                        : connector,
                    ),
                  );
                  setSaveError("");
                }}
                onRetry={() => {
                  setConnectors(undefined);
                  setSavedConnectors(undefined);
                  setConnectorReadVersion((value) => value + 1);
                }}
              />
            ) : activeSection === "entry" ? (
              <EntrySection change={change} draft={draft} />
            ) : activeSection === "limits" ? (
              <LimitsSection
                change={change}
                draft={draft}
                usage={overview.usage}
              />
            ) : (
              <>
                <RoleRuns devices={devices} workspaces={workspaces} />
                <MaintenanceSection workspaces={workspaces} />
                <ActivitySection
                  projectName={(id) =>
                    workspaces.find((workspace) => workspace.id === id)?.name
                  }
                />
              </>
            )}
            {dirty ? (
              <div
                className="mt-1 grid w-full gap-2.5 border-t border-line pt-4"
                role="region"
                aria-label={t("settings.unsaved")}
              >
                {problems.length ? (
                  <Alert tone="warning" title={t("settings.unsaved")}>
                    <ul className="grid gap-0.5">
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
                  <PaMuted>{t("settings.unsaved")}</PaMuted>
                )}
                {saveError ? (
                  <ToastFeedback tone="error" title={t("settings.saveFailed")}>
                    {saveError}
                  </ToastFeedback>
                ) : null}
                <ButtonRow gap="wide">
                  <Button
                    aria-busy={saving}
                    disabled={saving || problems.length > 0}
                    onClick={() => void save()}
                    size="sm"
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
                      setDraft(agent.settings);
                      setConnectors(savedConnectors);
                      setConfirmLoosen(false);
                      setSaveError("");
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    {t("settings.discard")}
                  </Button>
                </ButtonRow>
              </div>
            ) : null}
          </SectionPanel>
        </div>
        <div
          className={cn(
            "min-w-0 xl:sticky xl:top-0 xl:col-start-1 xl:row-start-1",
            section !== undefined && "max-xl:hidden",
          )}
        >
          <AssistantSettingsNav
            onSelect={onSectionChange}
            selected={activeSection}
            showIndex={section === undefined}
          />
        </div>
      </div>
    </div>
  );
}
