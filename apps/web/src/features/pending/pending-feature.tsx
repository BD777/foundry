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
import { LoadingState } from "../../components/ui/loading";
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
          <LoadingState label={t("page.loading")} layout="block" />
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
        <div className="grid gap-2.5">
          {groups.map((group) => (
            <section
              aria-label={t("page.groupLabel", {
                title: group.title,
                workspace: group.workspaceName,
              })}
              className="min-w-0 rounded-xl bg-panel shadow-card"
              key={group.key}
            >
              <header className="flex min-w-0 items-center justify-between gap-3 border-b border-line py-1 pr-2 pl-3.5 max-[640px]:pr-1.5 max-[640px]:pl-3">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1 [&>span]:text-2xs [&>span]:text-ink-muted [&>strong]:min-w-0 [&>strong]:truncate [&>strong]:text-sm [&>strong]:font-[650] [&>strong]:text-ink">
                  <strong>{group.title}</strong>
                  {group.workspaceName ? (
                    <span>{group.workspaceName}</span>
                  ) : null}
                </div>
                {group.issueId || group.sessionId ? (
                  <Button
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
              <div className="grid">
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
