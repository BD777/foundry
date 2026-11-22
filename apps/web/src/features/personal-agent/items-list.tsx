import { useTranslation } from "react-i18next";
import type {
  PersonalAgentItem,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import {
  ContextEmpty,
  ContextList,
  ContextRow,
  ContextRowCopy,
} from "../../components/ui/context-card";
import { Subheading } from "../../components/ui/subheading";
import { relativeWhen } from "../../lib/time-format";
import { groupByDay, type ItemDayGroup } from "./items-model";
import {
  ItemLead,
  originLabel,
  ownerLabel,
  stateLabel,
  workspaceLabel,
} from "./items-marks";

export interface ItemsListProps {
  items: PersonalAgentItem[];
  /** For the name of the workspace an item lives in. */
  workspaces: WorkspaceProjection[];
  /** Whether `workspaces` is read; until then an unknown one goes unnamed. */
  workspacesLoaded?: boolean;
  selectedItemId?: string;
  /** The item whose tick is being saved. */
  busyId: string;
  onOpen: (itemId: string) => void;
  onTick: (item: PersonalAgentItem) => void;
}

/** The list: one group per day of last update, newest day first, flat rows. */
export function ItemsList({
  items,
  workspaces,
  workspacesLoaded = true,
  selectedItemId,
  busyId,
  onOpen,
  onTick,
}: ItemsListProps) {
  const { t, i18n } = useTranslation("personalAgent");
  const groups = groupByDay(items);
  if (groups.length === 0)
    return <ContextEmpty>{t("items.list.empty")}</ContextEmpty>;
  return (
    <div className="grid gap-4">
      {groups.map((group) => {
        const label = dayLabel(group, t, i18n.language);
        return (
          <section aria-label={label} className="grid gap-1.5" key={group.key}>
            <Subheading size="caption">{label}</Subheading>
            <ContextList className="gap-1">
              {group.items.map((item) => (
                <ItemListRow
                  busy={busyId === item.id}
                  item={item}
                  key={item.id}
                  onOpen={onOpen}
                  onTick={onTick}
                  selected={item.id === selectedItemId}
                  workspaces={workspaces}
                  workspacesLoaded={workspacesLoaded}
                />
              ))}
            </ContextList>
          </section>
        );
      })}
    </div>
  );
}

function dayLabel(
  group: ItemDayGroup,
  t: (key: "items.list.today" | "items.list.yesterday") => string,
  language: string,
): string {
  if (group.relation === "today") return t("items.list.today");
  if (group.relation === "yesterday") return t("items.list.yesterday");
  return new Intl.DateTimeFormat(language, {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(group.day);
}

function ItemListRow({
  busy,
  item,
  onOpen,
  onTick,
  selected,
  workspaces,
  workspacesLoaded,
}: {
  busy: boolean;
  item: PersonalAgentItem;
  onOpen: (itemId: string) => void;
  onTick: (item: PersonalAgentItem) => void;
  selected: boolean;
  workspaces: WorkspaceProjection[];
  workspacesLoaded: boolean;
}) {
  const { t } = useTranslation("personalAgent");
  // Only a channel names someone else; the person's own web and self-chat items need no chip.
  const origin = item.origin?.kind === "channel" ? originLabel(item, t) : "";
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ItemLead busy={busy} item={item} onTick={onTick} />
      <ContextRow
        className="min-w-0 flex-1"
        onClick={() => onOpen(item.id)}
        selected={selected}
        title={item.text}
      >
        <ContextRowCopy
          detail={[
            ownerLabel(item.owner, t),
            stateLabel(item, t),
            // The inbox is where an item lives by default; only a workspace is named.
            item.homeWorkspaceId
              ? workspaceLabel(
                  item.homeWorkspaceId,
                  workspaces,
                  t,
                  workspacesLoaded,
                )
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          title={item.text}
        />
        <span className="flex flex-none flex-col items-end gap-1">
          <time
            className="text-2xs leading-tight text-ink-faint"
            dateTime={item.updatedAt}
          >
            {relativeWhen(item.updatedAt)}
          </time>
          {origin ? <Badge tone="neutral">{origin}</Badge> : null}
        </span>
      </ContextRow>
    </div>
  );
}
