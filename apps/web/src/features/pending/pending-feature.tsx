import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import type { PendingItem } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Skeleton } from "../../components/ui/loading";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";
import {
  navigateToChat,
  navigateToChatMessage,
  navigateToConnectors,
  navigateToIssue,
} from "../../lib/in-app-navigation";
import { PendingItemCard } from "./pending-item-card";
import { TriageSettingsButton } from "./triage-settings";
import {
  groupPendingItems,
  pendingPersonal,
  type PendingFilter,
} from "./pending-model";
import type { PendingItems } from "./use-pending-items";
import { PageHeader } from "../../components/ui/page-header";

/** Opens where an item was found: its message in the chat, or its Issue. */
export function openPendingItem(item: PendingItem): void {
  if (pendingPersonal(item)) navigateToConnectors(item.rule ?? "");
  else if (item.issueId) navigateToIssue(item.issueId);
  else if (item.sessionId)
    navigateToChatMessage(item.sessionId, item.workspaceId, item.messageId);
}

/**
 * The Pending page: what the person's chats and Issues wait for them on,
 * grouped by chat, newest first. Open items, or those resolved this week.
 */
export function PendingFeature({
  pending,
  devices,
  agentProfiles,
}: {
  pending: PendingItems;
  /** For choosing what reads answers: the person's devices, their connections. */
  devices: DeviceProjection[];
  agentProfiles: AgentProfileProjection[];
}) {
  const { t } = useTranslation("pending");
  const [filter, setFilter] = useState<PendingFilter>("open");
  const { list } = pending;
  const groups = useMemo(
    () =>
      list
        ? groupPendingItems(
            list.items,
            filter,
            t("page.untitled"),
            t("page.personal"),
          )
        : [],
    [list, filter, t],
  );
  return (
    <PageSurface variant="pending">
      <PageHeader
        actions={
          <TriageSettingsButton
            agentProfiles={agentProfiles}
            devices={devices}
          />
        }
        title={t("page.title")}
        description={t("page.intro")}
      />
      <SegmentedControl<PendingFilter>
        aria-label={t("page.filterLabel")}
        onValueChange={setFilter}
        options={[
          { value: "open", label: t("page.open", { count: list?.open ?? 0 }) },
          { value: "resolved", label: t("page.resolved") },
        ]}
        value={filter}
      />
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
              aria-label={t("page.groupLabel", {
                title: group.title,
                workspace: group.workspaceName,
              })}
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
                  <PendingItemCard
                    item={item}
                    key={item.id}
                    onOpenMessage={openPendingItem}
                    pending={pending}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageSurface>
  );
}
