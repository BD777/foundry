import { ToastFeedback } from "../../components/ui/toast";
import { FieldHint } from "../../components/ui/field";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  OctagonX,
  Play,
  Plus,
  SlidersHorizontal,
  Sparkles,
  UsersRound,
} from "lucide-react";
import type {
  AgentProfileProjection,
  AssistantSummary,
  DeviceProjection,
  PersonalAgent,
  PersonalAgentOverview,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Conversation } from "../../components/conversation/conversation";
import type { ChatMessageItem } from "../../components/conversation/conversation-types";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { DividedList } from "../../components/ui/divided-list";
import {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { EmptyState } from "../../components/ui/empty-state";
import {
  DropdownMenuEntry,
  DropdownMenuLabel,
  DropdownMenuSurface,
} from "../../components/ui/row-menu-parts";
import { Subheading } from "../../components/ui/subheading";
import { PaMuted } from "./pa-muted";
import { serverErrorText } from "../../lib/errors";
import { navigateToChat } from "../../lib/in-app-navigation";
import {
  answerableProposal,
  assistantActivity,
  channelCommand,
  placeProposals,
} from "./assistant-model";
import { AssistantGate } from "./assistant-gate";
import type { AssistantFeatureEvent } from "./assistant-events";
import { AssistantCreateDialog } from "./assistant-list";
import { PersonList } from "./person-list";
import { ProposalCard } from "./proposal-card";
import { TaskList } from "./task-list";
import { useAssistant, type AssistantController } from "./use-assistant";
import { useAssistantConversation } from "./use-assistant-conversation";
import { Skeleton } from "../../components/ui/loading";

export interface AssistantHomeProps {
  /** The assistant this route belongs to; absent only while bootstrapping. */
  assistantId?: string;
  /** For switching assistants from the conversation title. */
  assistants?: AssistantSummary[];
  /** Every computer the person can see; their own ones carry `owned`. */
  devices: DeviceProjection[];
  /** What the computers run, for the assistant's conversations. */
  agentProfiles: AgentProfileProjection[];
  /** For the names of the projects work goes to. */
  workspaces: WorkspaceProjection[];
  onEvent: (event: AssistantFeatureEvent) => void;
}

/**
 * The assistant's home (/assistants/{id}): one conversation with proposals in
 * it, what it is doing, and the stop switch. It reads the assistant's own
 * project directly and never changes the project the rest of Foundry shows.
 */
export function AssistantHome({
  assistantId,
  assistants = [],
  devices,
  workspaces,
  onEvent,
}: AssistantHomeProps) {
  const assistant = useAssistant(assistantId);
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
            assistant={assistant}
            assistants={assistants}
            devices={devices}
            home={home}
            homeOnline={
              home ? home.status === "connected" : overview.homeDeviceOnline
            }
            needsYou={overview.needsYou}
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
  assistant,
  assistants,
  devices,
  home,
  homeOnline,
  needsYou,
  onEvent,
  workspaces,
}: {
  agent: PersonalAgent;
  assistant: AssistantController;
  assistants: AssistantSummary[];
  devices: DeviceProjection[];
  home: DeviceProjection | undefined;
  homeOnline: boolean;
  needsYou: PersonalAgentOverview["needsYou"];
  onEvent: (event: AssistantFeatureEvent) => void;
  workspaces: WorkspaceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const conversation = useAssistantConversation(
    agent.id,
    agent.workspaceId,
    agent.formerWorkspaceIds,
  );
  const [switching, setSwitching] = useState<"stop" | "resume">();
  const [switchError, setSwitchError] = useState("");
  const [creating, setCreating] = useState(false);
  const stopped = agent.state === "stopped";
  const name = agent.settings.assistantName.trim() || t("defaultName");
  const canCreate = devices.some((device) => device.owned);
  const namedTasks = useMemo(
    () =>
      assistant.tasks.map((task) => ({
        ...task,
        title:
          assistant.listItems.find((item) => item.taskId === task.id)?.text ??
          task.title,
      })),
    [assistant.tasks, assistant.listItems],
  );
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
    await conversation.send(
      text,
      options?.idempotencyKey ?? crypto.randomUUID(),
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
    if (conversation.waitingInbox.length) {
      const reason = conversation.waitingInbox[0]?.waitingReason;
      items.push({
        id: "assistant-inbox-receipt",
        role: "bot",
        kind: "waiting",
        text: t("inbox.received", { count: conversation.waitingInbox.length }),
        title: t(
          reason === "device_offline"
            ? "inbox.deviceOffline"
            : reason === "worker_update_required"
              ? "inbox.workerUpdateRequired"
              : reason === "account_unavailable"
                ? "inbox.accountUnavailable"
                : reason === "assistant_paused"
                  ? "inbox.paused"
                  : "inbox.pending",
        ),
      });
    }
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
    conversation.waitingInbox,
    devices,
    assistant.proposals,
    t,
  ]);

  const historyNotice =
    conversation.state === "loading" ? (
      <Skeleton label={t("loading")} rows={3} />
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
    <div className="mx-auto w-full max-w-[calc(var(--fdy-chat-content-max)+2*var(--fdy-chat-content-padding))] px-(--fdy-chat-content-padding)">
      {historyNotice}
    </div>
  ) : undefined;

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_320px] grid-rows-[auto_minmax(0,1fr)] max-[1100px]:grid-cols-[minmax(0,1fr)] max-[1100px]:grid-rows-[auto_auto_minmax(0,1fr)]">
      <header className="col-span-full grid gap-2.5 border-b border-line px-5.5 pt-4.5 pb-3.5 max-[860px]:px-4 max-[860px]:pt-3.5 max-[860px]:pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
          <h1 className="text-2xl leading-tight font-semibold wrap-anywhere text-ink">
            <AssistantTitleMenu
              assistants={assistants}
              canCreate={canCreate}
              currentAssistantId={agent.id}
              name={name}
              onAll={() => onEvent({ type: "assistants.open" })}
              onCreate={() => setCreating(true)}
              onSelect={(assistantId) =>
                onEvent({ type: "assistant.open", assistantId })
              }
            />
          </h1>
          <Badge tone={stopped ? "warn" : "online"}>
            {stopped ? t("home.stopped.title") : t("settings.status.running")}
          </Badge>
        </div>
        <p className="max-w-[680px] text-sm leading-[1.55] text-ink-muted max-[860px]:hidden">
          {t("home.intro")}
        </p>
        <div className="flex flex-wrap gap-2">
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
          <ToastFeedback tone="error" title={t("loadFailed")}>
            {switchError}
          </ToastFeedback>
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
        className="fdy-pa-home-conversation flex min-h-0 min-w-0 flex-col max-[1100px]:row-start-3"
      >
        <Conversation
          active={conversation.working}
          activeExecutionId={conversation.latestTurnId}
          canSendDuringExecution={() => true}
          composer={{ mode: "plain" }}
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
      <aside className="grid min-h-0 min-w-0 content-start gap-5.5 overflow-y-auto border-l border-line px-4.5 py-4 max-[1100px]:row-start-2 max-[1100px]:max-h-[32dvh] max-[1100px]:border-b max-[1100px]:border-l-0 max-[860px]:max-h-[22dvh] max-[860px]:px-4 max-[860px]:py-3">
        {needsYou ? (
          <section
            aria-label={t("home.needsYou.label")}
            className="grid gap-1.5"
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <Subheading as="h2">
                {t("home.needsYou.title", { count: needsYou.open })}
              </Subheading>
              <Button
                onClick={() => onEvent({ type: "pending.open" })}
                size="sm"
                variant="ghost"
              >
                {t("home.needsYou.open")}
                <ChevronRight aria-hidden="true" size={14} />
              </Button>
            </div>
            {needsYou.items.length ? (
              <DividedList density="compact">
                {needsYou.items.map((item) => (
                  <li className="grid min-w-0 gap-0.5" key={item.id}>
                    <span className="min-w-0 truncate text-sm text-ink">
                      {item.title}
                    </span>
                    {item.where ? (
                      <span className="min-w-0 truncate text-2xs text-ink-faint">
                        {item.where}
                      </span>
                    ) : null}
                  </li>
                ))}
              </DividedList>
            ) : (
              <FieldHint>{t("home.needsYou.empty")}</FieldHint>
            )}
          </section>
        ) : null}
        {conversation.inboxError ? (
          <Alert tone="error" title={t("inbox.readFailed")}>
            {conversation.inboxError}
          </Alert>
        ) : null}
        {conversation.waitingInbox.some(
          (entry) => entry.status === "waiting" && !entry.sessionId,
        ) ? (
          <section aria-label={t("inbox.savedWaiting")}>
            <Subheading as="h2">{t("inbox.savedWaiting")}</Subheading>
            <FieldHint>{t("inbox.retrySettingsHint")}</FieldHint>
            <DividedList density="compact">
              {conversation.waitingInbox
                .filter(
                  (entry) => entry.status === "waiting" && !entry.sessionId,
                )
                .map((entry) => (
                  <li className="grid gap-1" key={entry.id}>
                    <p>{entry.text}</p>
                    <Button
                      size="sm"
                      disabled={!!conversation.retryingInboxId}
                      onClick={() => void conversation.retryInbox(entry)}
                    >
                      {t("inbox.retryWithSettings")}
                    </Button>
                  </li>
                ))}
            </DividedList>
          </section>
        ) : null}
        {conversation.failedInbox.length ? (
          <section aria-label={t("inbox.failedTitle")}>
            <Subheading as="h2">{t("inbox.failedTitle")}</Subheading>
            <DividedList density="compact">
              {conversation.failedInbox.map((entry) => (
                <li className="grid gap-1" key={entry.id}>
                  <p>{entry.text}</p>
                  <PaMuted>
                    {entry.resultError || t("inbox.failedTitle")}
                  </PaMuted>
                  <Button
                    size="sm"
                    disabled={Boolean(conversation.retryingInboxId)}
                    onClick={() => void conversation.retryInbox(entry)}
                  >
                    {t("inbox.retrySaved")}
                  </Button>
                  {entry.sessionId ? (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => navigateToChat(entry.sessionId!)}
                    >
                      {t("inbox.openResult")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </DividedList>
          </section>
        ) : null}
        <PersonList
          assistantId={agent.id}
          error={assistant.listItemsError}
          items={assistant.listItems}
          onDelete={assistant.deleteItem}
          onEdit={assistant.editItem}
          onTick={assistant.tickItem}
          tasks={namedTasks}
          operations={assistant.operations}
          workspaces={workspaces}
          onPlan={assistant.planItem}
          onRefresh={assistant.reload}
          onContinue={async (item) => {
            await send(
              t("planning.continuePrompt", { id: item.id, text: item.text }),
              [],
            );
          }}
        />
        <TaskList
          error={assistant.listsError}
          onStop={assistant.stopTask}
          projectName={(id) =>
            workspaces.find((workspace) => workspace.id === id)?.name
          }
          tasks={namedTasks}
        />
      </aside>
      <AssistantCreateDialog
        devices={devices}
        onClose={() => setCreating(false)}
        onCreated={(assistantId) =>
          onEvent({ type: "assistant.created", assistantId })
        }
        open={creating}
      />
    </div>
  );
}

function AssistantTitleMenu({
  assistants,
  canCreate,
  currentAssistantId,
  name,
  onAll,
  onCreate,
  onSelect,
}: {
  assistants: AssistantSummary[];
  canCreate: boolean;
  currentAssistantId: string;
  name: string;
  onAll: () => void;
  onCreate: () => void;
  onSelect: (assistantId: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const label = t("assistants.switcher.open");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`${label}: ${name}`}
          className="h-auto min-w-0 max-w-full justify-start gap-1.5 rounded-sm px-0 py-0 text-left text-2xl leading-tight font-semibold whitespace-normal wrap-anywhere text-ink active:scale-100"
          title={name}
          variant="ghost"
        >
          <span className="min-w-0">{name}</span>
          <ChevronDown
            aria-hidden="true"
            className="flex-none text-ink-muted"
            size={18}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSurface
          align="start"
          aria-label={label}
          className="min-w-[240px]"
          side="bottom"
        >
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {assistants.map((assistant) => {
            const assistantName = assistant.name.trim() || t("defaultName");
            return (
              <DropdownMenuEntry
                icon={<Sparkles aria-hidden="true" size={15} />}
                key={assistant.id}
                onSelect={() => onSelect(assistant.id)}
                reason={
                  assistant.isDefault ? t("assistants.default") : undefined
                }
                selected={assistant.id === currentAssistantId}
              >
                {assistantName}
              </DropdownMenuEntry>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuEntry
            icon={<UsersRound aria-hidden="true" size={15} />}
            onSelect={onAll}
          >
            {t("assistants.all")}
          </DropdownMenuEntry>
          <DropdownMenuEntry
            disabled={!canCreate}
            icon={<Plus aria-hidden="true" size={15} />}
            onSelect={onCreate}
          >
            {t("assistants.new")}
          </DropdownMenuEntry>
        </DropdownMenuSurface>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}
