import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import type { PendingItem } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Skeleton } from "../../components/ui/loading";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";
import {
  navigateToAssistantSettings,
  navigateToChat,
  navigateToChatMessage,
  navigateToConnectors,
  navigateToSkillLibrary,
  navigateToIssue,
} from "../../lib/in-app-navigation";
import { PendingItemCard } from "./pending-item-card";
import {
  groupPendingItems,
  pendingByAssistant,
  pendingFocusItemId,
  pendingItemDomId,
  pendingMatchesAssistant,
  pendingPersonal,
  type PendingAssistantFilter,
  type PendingFilter,
} from "./pending-model";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { FieldHint } from "../../components/ui/field";
import type { PendingItems } from "./use-pending-items";
import { PageHeader } from "../../components/ui/page-header";

/** Opens where an item was found: its message in the chat, or its Issue. */
export function openPendingItem(item: PendingItem): void {
  if (item.source === "bundle_update") navigateToSkillLibrary();
  else if (item.source === "message_channel")
    navigateToAssistantSettings("channels", item.assistantId);
  else if (pendingPersonal(item)) navigateToConnectors(item.rule ?? "");
  else if (item.issueId) navigateToIssue(item.issueId);
  else if (item.source === "assistant_inbox" && item.sessionId)
    // A saved message's attempt is the assistant's conversation itself.
    navigateToChat(item.sessionId, item.workspaceId);
  else if (item.sessionId)
    navigateToChatMessage(item.sessionId, item.workspaceId, item.messageId);
}

/**
 * The Pending page: what the person's chats and Issues wait for them on,
 * grouped by chat, newest first. Open items, or those resolved this week.
 */
export function PendingFeature({ pending }: { pending: PendingItems }) {
  const { t } = useTranslation("pending");
  const [filter, setFilter] = useState<PendingFilter>("open");
  const [assistantFilter, setAssistantFilter] =
    useState<PendingAssistantFilter>("all");
  const { list } = pending;
  // A notice's link names its item: the page shows it and scrolls to it once.
  const [focusItemId] = useState(() =>
    pendingFocusItemId(window.location.search),
  );
  const focusItem = list?.items.find((item) => item.id === focusItemId);
  const focusResolved = focusItem !== undefined && focusItem.state !== "open";
  const focusScrolled = useRef(false);
  const filteredItems = useMemo(
    () =>
      list?.items.filter((item) =>
        pendingMatchesAssistant(item, assistantFilter),
      ) ?? [],
    [assistantFilter, list],
  );
  const groups = useMemo(
    () =>
      list
        ? groupPendingItems(
            filteredItems,
            filter,
            t("page.untitled"),
            t("page.personal"),
            t("page.defaultAssistant"),
            t("page.notices"),
          )
        : [],
    [list, filteredItems, filter, t],
  );
  useEffect(() => {
    if (focusResolved) setFilter("resolved");
  }, [focusResolved]);
  useEffect(() => {
    if (!focusItemId || focusScrolled.current) return;
    const card = document.getElementById(pendingItemDomId(focusItemId));
    if (!card) return;
    focusScrolled.current = true;
    card.scrollIntoView({ block: "center" });
  }, [focusItemId, groups]);
  const assistantItems = useMemo(
    () => filteredItems.filter(pendingByAssistant),
    [filteredItems],
  );
  const assistantOptions = useMemo(
    () => [
      { value: "all" as const, label: t("page.allAssistants") },
      ...(list?.assistants ?? []).map((assistant) => ({
        value: `assistant:${assistant.id}` as const,
        label:
          assistant.name ||
          (assistant.isDefault
            ? t("page.defaultAssistant")
            : t("page.unnamedAssistant")),
      })),
      { value: "none" as const, label: t("page.noAssistant") },
    ],
    [list, t],
  );
  return (
    <PageSurface variant="pending">
      <PageHeader title={t("page.title")} description={t("page.intro")} />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SegmentedControl<PendingFilter>
          aria-label={t("page.filterLabel")}
          onValueChange={setFilter}
          options={[
            {
              value: "open",
              label: t("page.open", { count: list?.open ?? 0 }),
            },
            { value: "resolved", label: t("page.resolved") },
          ]}
          value={filter}
        />
        {list ? (
          <SegmentedControl<PendingAssistantFilter>
            aria-label={t("page.assistantFilterLabel")}
            onValueChange={setAssistantFilter}
            options={assistantOptions}
            tone="navigation"
            value={assistantFilter}
          />
        ) : null}
      </div>
      {pending.failed ? (
        <Alert
          actions={
            <Button onClick={pending.refresh} size="sm">
              {t("page.retry")}
            </Button>
          }
          size="compact"
          title={t("page.failed")}
          tone="error"
        />
      ) : null}
      {!list ? (
        pending.failed ? null : (
          <div className="min-w-0 rounded-xl bg-panel px-4 py-3 shadow-card">
            <Skeleton label={t("page.loading")} rows={4} variant="rows" />
          </div>
        )
      ) : groups.length === 0 ? (
        <EmptyState
          body={
            filter === "open"
              ? t("page.emptyOpenBody")
              : t("page.emptyResolvedBody")
          }
          title={
            filter === "open" ? t("page.emptyOpen") : t("page.emptyResolved")
          }
        />
      ) : (
        <div className="grid gap-5">
          {groups.map((group) => (
            <section
              aria-label={
                group.workspaceName
                  ? t("page.groupLabel", {
                      title: group.title,
                      workspace: group.workspaceName,
                    })
                  : group.title
              }
              className="grid min-w-0 gap-1.5"
              key={group.key}
            >
              <header className="flex min-h-7 min-w-0 items-center justify-between gap-3 pl-1">
                <div className="flex min-w-0 items-baseline gap-2">
                  <h2 className="min-w-0 truncate text-xs font-semibold text-ink-muted">
                    {group.title}
                  </h2>
                  {group.workspaceName ? (
                    <span className="flex-none text-2xs text-ink-faint">
                      {group.workspaceName}
                    </span>
                  ) : null}
                </div>
                {group.issueId || group.sessionId ? (
                  <Button
                    className="flex-none text-ink-muted"
                    onClick={() =>
                      group.issueId
                        ? navigateToIssue(group.issueId)
                        : group.sessionId &&
                          navigateToChat(group.sessionId, group.workspaceId)
                    }
                    size="sm"
                    variant="ghost"
                  >
                    {group.issueId ? t("page.openIssue") : t("page.openChat")}
                    <ArrowRight aria-hidden="true" size={14} />
                  </Button>
                ) : null}
              </header>
              <div className="grid min-w-0 rounded-xl bg-panel shadow-card">
                {group.items.map((item) => (
                  <div id={pendingItemDomId(item.id)} key={item.id}>
                    <PendingItemCard
                      item={item}
                      onOpenMessage={openPendingItem}
                      pending={pending}
                      showOrigin
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {filter === "open" && assistantItems.length ? (
        <Disclosure className="text-sm">
          <DisclosureSummary>
            {t("page.assistantHandling", { count: assistantItems.length })}
          </DisclosureSummary>
          <FieldHint>{t("page.assistantHandlingHint")}</FieldHint>
          <div className="grid min-w-0 rounded-xl bg-panel shadow-card">
            {assistantItems.map((item) => (
              <PendingItemCard
                item={item}
                key={item.id}
                onOpenMessage={openPendingItem}
                pending={pending}
                readOnly
                showOrigin
              />
            ))}
          </div>
        </Disclosure>
      ) : null}
    </PageSurface>
  );
}
