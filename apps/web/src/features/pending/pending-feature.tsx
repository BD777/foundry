import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
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
  navigateToIssue,
} from "../../lib/in-app-navigation";
import { PendingItemCard } from "./pending-item-card";
import { groupPendingItems, type PendingFilter } from "./pending-model";
import type { PendingItems } from "./use-pending-items";

/** Opens where an item was found: its message in the chat, or its Issue. */
export function openPendingItem(item: PendingItem): void {
  if (item.issueId) navigateToIssue(item.issueId);
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
  const { list } = pending;
  const groups = useMemo(
    () =>
      list ? groupPendingItems(list.items, filter, t("page.untitled")) : [],
    [list, filter, t],
  );
  return (
    <PageSurface variant="pending">
      <header className="fdy-pending-intro">
        <strong>{t("page.title")}</strong>
        <p>{t("page.intro")}</p>
      </header>
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
        <Alert size="compact" title={t("page.failed")} tone="error">
          <Button onClick={pending.refresh} size="sm">
            {t("page.retry")}
          </Button>
        </Alert>
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
        <div className="fdy-pending-groups">
          {groups.map((group) => (
            <section
              aria-label={t("page.groupLabel", {
                title: group.title,
                workspace: group.workspaceName,
              })}
              className="fdy-pending-group"
              key={group.key}
            >
              <header className="fdy-pending-group-head">
                <div className="fdy-pending-group-title">
                  <strong>{group.title}</strong>
                  {group.workspaceName ? (
                    <span>{group.workspaceName}</span>
                  ) : null}
                </div>
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
              </header>
              <div className="fdy-pending-group-items">
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
