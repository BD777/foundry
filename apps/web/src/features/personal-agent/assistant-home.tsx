import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { OctagonX, Play, SlidersHorizontal } from "lucide-react";
import type {
  AgentProfileProjection,
  DeviceProjection,
  PersonalAgent,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Conversation } from "../../components/conversation/conversation";
import type { ChatMessageItem } from "../../components/conversation/conversation-types";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { serverErrorText } from "../../lib/errors";
import {
  answerableProposal,
  answeredWithoutModel,
  assistantActivity,
  assistantRuntime,
  channelCommand,
  placeProposals,
} from "./assistant-model";
import { AssistantGate } from "./assistant-gate";
import type { AssistantFeatureEvent } from "./assistant-events";
import { PersonList } from "./person-list";
import { ProposalCard } from "./proposal-card";
import { TaskList } from "./task-list";
import { useAssistant, type AssistantController } from "./use-assistant";
import {
  useAssistantConversation,
  type AssistantRuntime,
} from "./use-assistant-conversation";

export interface AssistantHomeProps {
  /** Every computer the person can see; their own ones carry `owned`. */
  devices: DeviceProjection[];
  /** What the computers run, for the assistant's conversations. */
  agentProfiles: AgentProfileProjection[];
  /** For the names of the projects work goes to. */
  workspaces: WorkspaceProjection[];
  onEvent: (event: AssistantFeatureEvent) => void;
}

/**
 * The assistant's home (/assistant): one conversation with proposals in
 * it, what it is doing, and the stop switch. It reads the assistant's own
 * project directly and never changes the project the rest of Foundry shows.
 */
export function AssistantHome({
  agentProfiles,
  devices,
  workspaces,
  onEvent,
}: AssistantHomeProps) {
  const assistant = useAssistant();
  return (
    <AssistantGate
      assistant={assistant}
      devices={devices}
      onConnectComputer={() => onEvent({ type: "devices.open" })}
    >
      {(agent, overview) => {
        const home = devices.find((device) => device.id === agent.homeDeviceId);
        return (
          <AssistantHomeReady
            agent={agent}
            runtime={assistantRuntime(
              agentProfiles,
              agent.homeDeviceId,
              agent.settings,
            )}
            assistant={assistant}
            devices={devices}
            home={home}
            homeOnline={
              home ? home.status === "connected" : overview.homeDeviceOnline
            }
            onEvent={onEvent}
            workspaces={workspaces}
          />
        );
      }}
    </AssistantGate>
  );
}

function AssistantHomeReady({
  agent,
  runtime,
  assistant,
  devices,
  home,
  homeOnline,
  onEvent,
  workspaces,
}: {
  agent: PersonalAgent;
  runtime: AssistantRuntime | undefined;
  assistant: AssistantController;
  devices: DeviceProjection[];
  home: DeviceProjection | undefined;
  homeOnline: boolean;
  onEvent: (event: AssistantFeatureEvent) => void;
  workspaces: WorkspaceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const conversation = useAssistantConversation(
    agent.workspaceId,
    agent.formerWorkspaceIds,
  );
  const [switching, setSwitching] = useState<"stop" | "resume">();
  const [switchError, setSwitchError] = useState("");
  const stopped = agent.state === "stopped";
  const name = agent.settings.assistantName.trim() || t("defaultName");
  const notice = (message: string) =>
    onEvent({ type: "notice.requested", message });

  async function stopAll(): Promise<void> {
    notice(await assistant.stopAll());
  }
  async function resume(): Promise<void> {
    notice(await assistant.resume());
  }
  async function flip(action: "stop" | "resume"): Promise<void> {
    setSwitching(action);
    setSwitchError("");
    try {
      await (action === "stop" ? stopAll() : resume());
    } catch (reason) {
      setSwitchError(serverErrorText(reason));
    } finally {
      setSwitching(undefined);
    }
  }

  // The fixed words are answered here, before the model (§4, §8).
  async function send(
    text: string,
    _attachments: unknown,
    options?: { idempotencyKey?: string },
  ): Promise<true | "replied"> {
    const command = channelCommand(text);
    if (command === "stop") {
      await stopAll();
      return "replied";
    }
    if (command === "resume" && stopped) {
      await resume();
      return "replied";
    }
    const proposal =
      command === "accept" || command === "decline"
        ? answerableProposal(assistant.proposals)
        : undefined;
    if (proposal) {
      await assistant.answer(proposal, command === "accept");
      notice(
        t(command === "accept" ? "commands.accepted" : "commands.declined", {
          summary: proposal.summary,
        }),
      );
      return "replied";
    }
    if (stopped) throw new Error(t("conversation.stopped"));
    if (!runtime)
      throw new Error(
        t("conversation.noRuntime", {
          device: home?.label ?? agent.homeDeviceId,
        }),
      );
    await conversation.send(
      text,
      options?.idempotencyKey ?? crypto.randomUUID(),
      runtime,
    );
    return true;
  }

  const messages = useMemo(() => {
    const firstAt = conversation.lines[0]?.at ?? "";
    const shown = assistant.proposals.filter(
      (proposal) =>
        proposal.status === "pending" ||
        (firstAt !== "" && proposal.createdAt >= firstAt),
    );
    const items: ChatMessageItem[] = [];
    for (const entry of placeProposals(conversation.lines, shown)) {
      if ("proposal" in entry) {
        const { proposal } = entry;
        items.push({
          id: `proposal:${proposal.id}`,
          role: "bot",
          at: proposal.createdAt,
          text: (
            <ProposalCard
              onAnswer={(accept) => assistant.answer(proposal, accept)}
              proposal={proposal}
            />
          ),
        });
        continue;
      }
      const { line } = entry;
      if (line.startsConversation)
        items.push({
          id: `${line.id}:boundary`,
          role: "bot",
          kind: "boundary",
          text: t("conversation.newConversation"),
        });
      items.push({
        id: line.id,
        clientId: line.clientId,
        role: line.role === "person" ? "user" : "bot",
        text: line.text,
        copyText: line.text,
        at: line.at,
        streaming: line.streaming,
      });
    }
    const last = conversation.lines[conversation.lines.length - 1];
    const activity = assistantActivity(
      conversation.latestSession,
      devices,
      Boolean(last?.streaming),
    );
    if (activity && activity !== "working")
      items.push({
        id: "assistant-waiting",
        role: "bot",
        kind: "waiting",
        text: t("conversation.waitingForComputerDetail", {
          computer: activity.waitingFor.label,
        }),
        title: t("conversation.waitingForComputer", {
          computer: activity.waitingFor.label,
        }),
      });
    else if (activity === "working")
      items.push({
        id: "assistant-working",
        role: "bot",
        kind: "process",
        text: "",
        title: t("conversation.working"),
        streaming: true,
      });
    return items;
  }, [
    conversation.lines,
    conversation.latestSession,
    devices,
    assistant.proposals,
    t,
  ]);

  const historyNotice =
    conversation.state === "loading" ? (
      <p className="fdy-pa-muted" role="status">
        {t("loading")}
      </p>
    ) : conversation.state === "failed" ? (
      <Alert tone="error" title={t("conversation.loadFailed")}>
        <p>{conversation.error}</p>
        <Button onClick={() => void conversation.retry()} size="sm">
          {t("retry")}
        </Button>
      </Alert>
    ) : messages.length === 0 ? (
      <EmptyState
        body={t("conversation.emptyBody")}
        title={t("conversation.emptyTitle")}
      />
    ) : undefined;
  // In the transcript's column, as wide as its messages.
  const history = historyNotice ? (
    <div className="fdy-pa-home-history">{historyNotice}</div>
  ) : undefined;

  return (
    <div className="fdy-pa-home">
      <header className="fdy-pa-home-head">
        <div className="fdy-pa-home-title">
          <h1>{name}</h1>
          <Badge tone={stopped ? "warn" : "online"}>
            {stopped ? t("home.stopped.title") : t("settings.status.running")}
          </Badge>
        </div>
        <p className="fdy-pa-home-intro">{t("home.intro")}</p>
        <div className="fdy-pa-home-actions">
          {stopped ? (
            <Button
              aria-busy={switching === "resume"}
              disabled={Boolean(switching)}
              onClick={() => void flip("resume")}
              variant="primary"
            >
              <Play aria-hidden="true" size={15} />
              {switching === "resume" ? t("home.resuming") : t("home.resume")}
            </Button>
          ) : (
            <Button
              aria-busy={switching === "stop"}
              disabled={Boolean(switching)}
              onClick={() => void flip("stop")}
              variant="secondary"
            >
              <OctagonX aria-hidden="true" size={15} />
              {switching === "stop" ? t("home.stopping") : t("home.stopAll")}
            </Button>
          )}
          <Button
            onClick={() => onEvent({ type: "settings.open" })}
            variant="ghost"
          >
            <SlidersHorizontal aria-hidden="true" size={15} />
            {t("home.openSettings")}
          </Button>
        </div>
        {switchError ? (
          <Alert tone="error" title={t("loadFailed")}>
            {switchError}
          </Alert>
        ) : null}
        {stopped ? (
          <Alert tone="warning" title={t("home.stopped.title")}>
            {t("home.stopped.body")}
          </Alert>
        ) : null}
        {homeOnline ? null : (
          <Alert
            tone="warning"
            title={t("home.offline.title", {
              device: home?.label ?? agent.homeDeviceId,
            })}
          >
            <p>{t("home.offline.body")}</p>
            <Button
              onClick={() =>
                onEvent({ type: "settings.open", section: "status" })
              }
              size="inline"
              variant="link"
            >
              {t("home.offline.action")}
            </Button>
          </Alert>
        )}
      </header>
      <section
        aria-label={t("conversation.label")}
        className="fdy-pa-home-conversation"
      >
        <Conversation
          active={conversation.working}
          activeExecutionId={conversation.latestTurnId}
          canSendDuringExecution={(text) =>
            answeredWithoutModel(text, stopped, assistant.proposals)
          }
          composer={{ mode: "plain" }}
          disabled={!homeOnline}
          disabledReason={t("conversation.offline")}
          history={history}
          inputLabel={t("conversation.inputLabel")}
          messages={messages}
          onSend={send}
          onStop={() => conversation.stopReply()}
          placeholder={t("conversation.placeholder")}
          sendLabel={t("conversation.send")}
          stopLabel={t("conversation.stopReply")}
          threadKey={`assistant:${agent.workspaceId}`}
        />
      </section>
      <aside className="fdy-pa-home-side">
        <PersonList
          error={assistant.listItemsError}
          items={assistant.listItems}
          onDelete={assistant.deleteItem}
          onEdit={assistant.editItem}
          onTick={assistant.tickItem}
          tasks={assistant.tasks}
        />
        <TaskList
          error={assistant.listsError}
          onStop={assistant.stopTask}
          projectName={(id) =>
            workspaces.find((workspace) => workspace.id === id)?.name
          }
          tasks={assistant.tasks}
        />
      </aside>
    </div>
  );
}
