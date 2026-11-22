import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  PersonalAgentItem,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { EmptyState } from "../../components/ui/empty-state";
import { SelectMenu } from "../../components/ui/select-menu";
import { Skeleton } from "../../components/ui/loading";
import {
  SegmentedControl,
  type SegmentOption,
} from "../../components/ui/segmented-control";
import { cn } from "../../lib/cn";
import { serverErrorText } from "../../lib/errors";
import { itemsWorkspaceParam } from "../../lib/in-app-navigation";
import { readPageQuery, replacePageQuery } from "../../lib/page-query";
import { dateOnly } from "../../lib/time-format";
import {
  customRange,
  inboxFilter,
  itemsFilterQuery,
  rangeFor,
  rangePresets,
  type RangePreset,
} from "./items-model";
import { ItemDetail } from "./items-detail";
import { homeChoices } from "./items-home";
import { ItemsList } from "./items-list";
import { workspaceLabel } from "./items-marks";
import { ItemsReview } from "./items-review";
import {
  personalItemActions,
  usePagedPersonalItems,
  usePersonalItemDetail,
  usePersonalItemReport,
  usePersonalOperations,
} from "./use-personal-items";

/** The page's tabs: the view the server keeps each item in. */
type ItemsTab = "open" | "finished" | "archived";
type RangeChoice = RangePreset | "custom";

export interface AssistantItemsPageProps {
  assistantId?: string;
  /** The item whose detail is open; the URL names it. */
  selectedItemId?: string;
  onSelectItem: (itemId: string | undefined) => void;
  /** Back to the assistant's conversation, e.g. after asking for a summary. */
  onOpenAssistant: () => void;
  /** For the names of the workspaces items live in, and the filter. */
  workspaces: WorkspaceProjection[];
}

/**
 * 「事项」: every item the person has, by tab (open, finished, archived), by
 * the time it last changed, searched, a page at a time; the one item's detail
 * beside it, or the review of a range in its place.
 */
export function AssistantItemsPage({
  assistantId,
  selectedItemId,
  onSelectItem,
  onOpenAssistant,
  workspaces,
}: AssistantItemsPageProps) {
  const { t, i18n } = useTranslation("personalAgent");
  const [tab, setTab] = useState<ItemsTab>("open");
  const [range, setRange] = useState<RangeChoice>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [search, setSearch] = useState("");
  // A workspace id, the inbox or "" for every item. The URL is read once
  // when the page opens; the filter writes it back, never the other way.
  const [workspaceFilter, setWorkspaceFilter] = useState(() =>
    readPageQuery(itemsWorkspaceParam),
  );
  const chooseWorkspace = (value: string) => {
    setWorkspaceFilter(value);
    replacePageQuery({ [itemsWorkspaceParam]: value });
  };
  const query = useDebounced(search.trim(), 250);
  const [reviewing, setReviewing] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [tickError, setTickError] = useState("");

  // Open items are what is open now: the range applies to finished and
  // archived ones, and to the review, which always reads the chosen range.
  const shownRange = tab === "open" && !reviewing ? "all" : range;
  const bounds =
    shownRange === "custom"
      ? customRange(customFrom, customTo)
      : rangeFor(shownRange);
  const list = usePagedPersonalItems(
    assistantId,
    reviewing
      ? undefined
      : {
          view: tab,
          from: bounds.from,
          to: bounds.to,
          ...itemsFilterQuery(workspaceFilter),
          q: query || undefined,
        },
  );
  const detail = usePersonalItemDetail(assistantId, selectedItemId);
  const operations = usePersonalOperations(assistantId);
  const review = usePersonalItemReport(
    assistantId,
    reviewing
      ? {
          from: bounds.from ?? "1970-01-01T00:00:00.000Z",
          to: bounds.to ?? "2100-01-01T00:00:00.000Z",
        }
      : undefined,
  );

  const reloadAll = async () => {
    await Promise.all([list.reload(), detail.reload()]);
  };

  const tick = async (item: PersonalAgentItem) => {
    setBusyId(item.id);
    setTickError("");
    try {
      await personalItemActions.setStatus(assistantId, item, "done");
      await reloadAll();
    } catch (reason) {
      setTickError(serverErrorText(reason));
    } finally {
      setBusyId("");
    }
  };

  const tabOptions: SegmentOption<ItemsTab>[] = [
    { value: "open", label: t("items.tabs.open") },
    { value: "finished", label: t("items.tabs.finished") },
    { value: "archived", label: t("items.tabs.archived") },
  ];
  const rangeOptions: SegmentOption<RangeChoice>[] = [
    ...rangePresets.map((preset) => ({
      value: preset,
      label: t(`items.range.${preset}`),
    })),
    { value: "custom", label: t("items.range.custom") },
  ];
  const described = describeRange(bounds, t, i18n.language);
  const rangePicker = (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        aria-label={t("items.range.label")}
        onValueChange={setRange}
        options={rangeOptions}
        size="sm"
        value={range}
      />
      {range === "custom" ? (
        <>
          <TextInput
            aria-label={t("items.range.from")}
            onChange={(event) => setCustomFrom(event.target.value)}
            tone="boxed"
            type="date"
            value={customFrom}
          />
          <span className="text-sm text-ink-muted">–</span>
          <TextInput
            aria-label={t("items.range.to")}
            onChange={(event) => setCustomTo(event.target.value)}
            tone="boxed"
            type="date"
            value={customTo}
          />
        </>
      ) : null}
    </div>
  );

  const choices = homeChoices(workspaces).map((workspace) => ({
    value: workspace.id,
    label: workspace.name,
  }));
  const workspaceFilterOptions = [
    { value: "", label: t("items.filter.all") },
    { value: inboxFilter, label: t("items.home.inbox") },
    ...choices,
    // A link may name a workspace that is no longer a choice (archived).
    ...(workspaceFilter &&
    workspaceFilter !== inboxFilter &&
    !choices.some((choice) => choice.value === workspaceFilter)
      ? [
          {
            value: workspaceFilter,
            label: workspaceLabel(workspaceFilter, workspaces, t),
          },
        ]
      : []),
  ];

  const listError = list.error || detail.error;
  const shown = list.items.length;
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="grid gap-2.5 border-b border-line px-5.5 pt-4.5 pb-3.5 max-[860px]:px-4 max-[860px]:pt-3.5 max-[860px]:pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
          <h1 className="text-2xl leading-tight font-semibold wrap-anywhere text-ink">
            {t("items.title")}
          </h1>
          <Button
            className="ms-auto"
            disabled={reviewing}
            onClick={() => setReviewing(true)}
            size="sm"
            variant="secondary"
          >
            {t("items.review.open")}
          </Button>
        </div>
        {reviewing ? (
          rangePicker
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                aria-label={t("items.tabs.label")}
                onValueChange={setTab}
                options={tabOptions}
                size="sm"
                value={tab}
              />
              <SelectMenu
                ariaLabel={t("items.filter.workspace")}
                className="w-48 max-w-full"
                onChange={chooseWorkspace}
                options={workspaceFilterOptions}
                tone="pill"
                value={workspaceFilter}
              />
              <TextInput
                aria-label={t("items.search.label")}
                className="ms-auto w-56 max-w-full"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("items.search.placeholder")}
                tone="boxed"
                type="search"
                value={search}
              />
            </div>
            {tab === "open" ? null : rangePicker}
          </>
        )}
      </header>
      {reviewing ? (
        <div className="min-h-0 overflow-y-auto">
          <ItemsReview
            askText={described.ask}
            assistantId={assistantId}
            error={review.error}
            onAsked={onOpenAssistant}
            onBack={() => setReviewing(false)}
            rangeLabel={described.label}
            report={review.value}
          />
        </div>
      ) : (
        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] min-[861px]:grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
          <div
            className={cn(
              "min-h-0 overflow-y-auto px-5.5 py-4 max-[860px]:px-4",
              selectedItemId && "max-[860px]:hidden",
            )}
          >
            {listError ? (
              <Alert
                className="mb-3"
                title={t("items.list.loadFailed")}
                tone="error"
              >
                {listError}
              </Alert>
            ) : null}
            {tickError ? (
              <Alert
                className="mb-3"
                title={t("items.card.tickFailed")}
                tone="error"
              >
                {tickError}
              </Alert>
            ) : null}
            {list.loading ? (
              <Skeleton label={t("loading")} rows={4} />
            ) : (
              <>
                <ItemsList
                  busyId={busyId}
                  items={list.items}
                  workspaces={workspaces}
                  onOpen={(itemId) => onSelectItem(itemId)}
                  onTick={(item) => void tick(item)}
                  selectedItemId={selectedItemId}
                />
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {list.hasMore ? (
                    <Button
                      onClick={() => void list.loadMore()}
                      size="sm"
                      variant="secondary"
                    >
                      {t("items.list.loadMore")}
                    </Button>
                  ) : null}
                  {shown > 0 ? (
                    <p className="text-xs text-ink-faint">
                      {t("items.list.shown", { shown, total: list.total })}
                    </p>
                  ) : null}
                </div>
              </>
            )}
          </div>
          <div
            className={cn(
              "min-h-0 overflow-y-auto min-[861px]:border-s min-[861px]:border-line",
              !selectedItemId && "max-[860px]:hidden",
            )}
          >
            {selectedItemId ? (
              <ItemDetail
                assistantId={assistantId}
                detail={detail.value}
                error={detail.error}
                items={list.items.filter((entry) => entry.status === "open")}
                key={selectedItemId}
                onBack={() => onSelectItem(undefined)}
                onChanged={reloadAll}
                onOpenAssistant={onOpenAssistant}
                onDeleted={() => {
                  onSelectItem(undefined);
                  void list.reload();
                }}
                operations={operations.value ?? []}
                workspaces={workspaces}
              />
            ) : (
              <EmptyState
                body={t("items.page.selectBody")}
                title={t("items.page.selectTitle")}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The range as the reader sees it, and the short form the review's message names. */
function describeRange(
  bounds: { from?: string; to?: string },
  t: TFunction<"personalAgent">,
  language: string,
): { label: string; ask: string } {
  if (!bounds.from && !bounds.to)
    return {
      label: t("items.range.all"),
      ask: t("items.review.askAll"),
    };
  // The window is half-open: its last day is the day before `to`.
  const first = bounds.from ? new Date(bounds.from) : undefined;
  const last = bounds.to ? new Date(Date.parse(bounds.to) - 1) : undefined;
  const short = new Intl.DateTimeFormat(language, {
    month: "numeric",
    day: "numeric",
  });
  const shortRange = `${first ? short.format(first) : ""}–${last ? short.format(last) : ""}`;
  return {
    label: `${first ? dateOnly(bounds.from ?? "") : ""} – ${last ? dateOnly(last.toISOString()) : ""}`,
    ask: t("items.review.askText", { range: shortRange }),
  };
}

/** A value that follows its source after `delayMs` of no change. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
