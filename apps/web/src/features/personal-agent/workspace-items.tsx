import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type {
  PersonalAgentItem,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  ContextEmpty,
  ContextList,
  ContextRow,
  ContextRowCopy,
} from "../../components/ui/context-card";
import { FieldHint } from "../../components/ui/field";
import { Skeleton } from "../../components/ui/loading";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { Subheading } from "../../components/ui/subheading";
import { ownerLabel, stateLabel, workspaceLabel } from "./items-marks";
import { usePersonalItems } from "./use-personal-items";

/** The most one read asks for; the rest are on the items page. */
const workspaceItemsLimit = 200;

export interface WorkspaceItemsProps {
  /** The assistant whose list is read. */
  assistantId: string;
  workspaceId: string;
  /** For the home of an item that only touches this workspace. */
  workspaces: WorkspaceProjection[];
  onOpenItem: (itemId: string) => void;
  onOpenAll: () => void;
}

/**
 * A workspace's open items, in two groups: those that live here (their home)
 * and those that only touch it (a helper ran here). A row opens the item's
 * detail on the items page.
 */
export function WorkspaceItems({
  assistantId,
  workspaceId,
  workspaces,
  onOpenItem,
  onOpenAll,
}: WorkspaceItemsProps) {
  const { t } = useTranslation("personalAgent");
  const list = usePersonalItems(assistantId, {
    view: "open",
    workspace: workspaceId,
    limit: workspaceItemsLimit,
  });
  const items = list.value?.items ?? [];
  const home = items.filter((item) => item.homeWorkspaceId === workspaceId);
  const touching = items.filter((item) => item.homeWorkspaceId !== workspaceId);
  const more = (list.value?.total ?? 0) - items.length;
  return (
    <Panel className="grid min-w-0 gap-4 p-5.5 max-[680px]:p-4">
      <PanelHeader>
        <div>
          <h2>{t("items.workspace.title")}</h2>
        </div>
        <Button onClick={onOpenAll} size="sm" variant="secondary">
          {t("items.workspace.openAll")}
        </Button>
      </PanelHeader>
      {list.error ? (
        <Alert
          size="compact"
          title={t("items.workspace.loadFailed")}
          tone="error"
        >
          {list.error}
        </Alert>
      ) : null}
      {!list.value && !list.error ? (
        <Skeleton label={t("loading")} rows={2} />
      ) : null}
      {list.value && !items.length ? (
        <ContextEmpty>{t("items.workspace.empty")}</ContextEmpty>
      ) : null}
      {home.length ? (
        <WorkspaceItemGroup
          items={home}
          label={t("items.workspace.home")}
          onOpenItem={onOpenItem}
        />
      ) : null}
      {touching.length ? (
        <WorkspaceItemGroup
          items={touching}
          label={t("items.workspace.touches")}
          onOpenItem={onOpenItem}
          workspaces={workspaces}
        />
      ) : null}
      {more > 0 ? (
        <FieldHint className="m-0">
          {t("items.workspace.more", { count: more })}
        </FieldHint>
      ) : null}
    </Panel>
  );
}

/** One group of rows; `workspaces` given, each row also names the item's home. */
function WorkspaceItemGroup({
  items,
  label,
  onOpenItem,
  workspaces,
}: {
  items: PersonalAgentItem[];
  label: string;
  onOpenItem: (itemId: string) => void;
  workspaces?: WorkspaceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  return (
    <section aria-label={label} className="grid gap-1.5">
      <Subheading size="caption">{label}</Subheading>
      <ContextList className="gap-1">
        {items.map((item) => (
          <ContextRow
            key={item.id}
            onClick={() => onOpenItem(item.id)}
            title={item.text}
          >
            <ContextRowCopy
              detail={[
                ownerLabel(item.owner, t),
                stateLabel(item, t),
                workspaces
                  ? workspaceLabel(item.homeWorkspaceId, workspaces, t)
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              title={item.text}
            />
            <ChevronRight
              aria-hidden="true"
              className="flex-none text-ink-faint"
              size={14}
            />
          </ContextRow>
        ))}
      </ContextList>
    </section>
  );
}
