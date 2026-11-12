import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ModelGuideDetail,
  ModelObservation,
  ModelObservationPage,
} from "@bd777/foundry-protocol";
import { getModelGuide, listModelGuideObservations } from "../../api";
import { MarkdownContent } from "../../components/conversation/markdown-content";
import { runtimeMeta } from "../../components/agent-runtime/runtime-mark";
import { Alert } from "../../components/ui/alert";
import { AppLink } from "../../components/ui/app-link";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint } from "../../components/ui/field";
import { InfoRow } from "../../components/ui/info-row";
import { LoadingState } from "../../components/ui/loading";
import { SectionHeader } from "../../components/ui/page-header";
import { MutedText } from "../../components/ui/text";
import { chatHref } from "../../lib/in-app-navigation";
import { dateTime } from "../../lib/time-format";
import { ModelGuideRevisions } from "./model-guide-diff";
import { modelGuideSectionKeys } from "./model-guide-sections";

/** One guide: sections, aliases, facts read live, observations and revisions. Read-only. */
export function ModelGuideDialog({
  guideId,
  onClose,
}: {
  guideId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("profiles");
  const [detail, setDetail] = useState<ModelGuideDetail>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setError(false);
    getModelGuide(guideId).then(
      (next) => {
        if (active) setDetail(next);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [guideId]);
  const guide = detail?.guide;
  return (
    <Dialog
      description={
        guide
          ? t("modelGuides.detailDescription", {
              revision: guide.revision,
              id: guide.id,
            })
          : undefined
      }
      layout="sectioned"
      open
      size="wide"
      title={guide?.displayName ?? t("modelGuides.title")}
      onClose={onClose}
    >
      <div className="grid min-w-0 gap-5 p-5">
        {error ? (
          <Alert
            size="compact"
            tone="error"
            title={t("modelGuides.detailLoadFailed")}
          />
        ) : !detail || !guide ? (
          <LoadingState label={t("modelGuides.loading")} />
        ) : (
          <>
            <EditHint id={guide.id} />
            {modelGuideSectionKeys.map((key) => (
              <section className="grid min-w-0 gap-1.5" key={key}>
                <SectionHeader
                  level={3}
                  title={t(`modelGuides.sections.${key}`)}
                />
                {guide.sections[key]?.trim() ? (
                  <MarkdownContent>{guide.sections[key]}</MarkdownContent>
                ) : (
                  <MutedText>{t("modelGuides.sectionEmpty")}</MutedText>
                )}
              </section>
            ))}
            <Aliases guide={guide} />
            <Facts facts={detail.facts} />
            <Observations guideId={guide.id} initial={detail.observations} />
            <section className="grid min-w-0 gap-2">
              <SectionHeader level={3} title={t("modelGuides.history")} />
              <ModelGuideRevisions guide={guide} revisions={detail.revisions} />
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}

function EditHint({ id }: { id: string }) {
  const { t } = useTranslation("profiles");
  const example = t("modelGuides.editExample", { id });
  return (
    <div className="grid min-w-0 gap-1 rounded-lg bg-inset p-3">
      <strong className="text-sm">{t("modelGuides.editHintTitle")}</strong>
      <FieldHint className="mt-0">{t("modelGuides.editHint")}</FieldHint>
      <div className="flex min-w-0 items-center gap-2">
        <q className="min-w-0 flex-1 text-sm wrap-anywhere">{example}</q>
        <CopyButton
          copiedLabel={t("modelGuides.copiedExample")}
          label={t("modelGuides.copyExample")}
          text={example}
        />
      </div>
    </div>
  );
}

function Aliases({ guide }: { guide: ModelGuideDetail["guide"] }) {
  const { t } = useTranslation("profiles");
  return (
    <section className="grid min-w-0 gap-1.5">
      <SectionHeader level={3} title={t("modelGuides.aliases")} />
      <div className="grid min-w-0">
        {guide.aliases.map((alias, index) => (
          <InfoRow
            density="compact"
            key={`${alias.providerId}\u0000${alias.runtime}\u0000${alias.model}\u0000${index}`}
            label={alias.model}
            meta={
              alias.providerId || alias.runtime
                ? t("modelGuides.aliasProvider", {
                    provider: alias.providerId || t("modelGuides.anyProvider"),
                    runtime: alias.runtime
                      ? runtimeMeta(alias.runtime).label
                      : "",
                  })
                : t("modelGuides.anyProvider")
            }
          />
        ))}
      </div>
    </section>
  );
}

function Facts({ facts }: { facts: ModelGuideDetail["facts"] }) {
  const { t } = useTranslation("profiles");
  const unknown = t("modelGuides.unknown");
  const number = (value: number) => value.toLocaleString();
  const windows = facts.providers.filter((item) => item.contextWindow);
  const pools = facts.providers.filter((item) => item.tokensPerMinute);
  const usage = facts.usage;
  const rows: { label: string; value: string }[] = [
    {
      label: t("modelGuides.contextWindow"),
      value: windows.length
        ? windows
            .map((item) =>
              t("modelGuides.tokens", {
                value: number(item.contextWindow ?? 0),
              }),
            )
            .join(" / ")
        : unknown,
    },
    {
      label: t("modelGuides.tokensPerMinute"),
      value: pools.length
        ? pools
            .map((item) =>
              t("modelGuides.tokensPerMinuteValue", {
                value: number(item.tokensPerMinute ?? 0),
                group: item.workerGroupLabel ?? item.workerGroupId ?? "",
              }),
            )
            .join(" / ")
        : unknown,
    },
    {
      label: t("modelGuides.workerSessions", { days: usage.windowDays }),
      value: number(usage.workerSessions),
    },
    { label: t("modelGuides.requests"), value: number(usage.requests) },
    {
      label: t("modelGuides.avgRequest"),
      value: usage.avgRequestMs ? requestTime(usage.avgRequestMs) : unknown,
    },
    {
      label: t("modelGuides.tokPerSec"),
      value: usage.tokPerSec
        ? t("modelGuides.tokPerSecValue", { value: usage.tokPerSec.toFixed(1) })
        : unknown,
    },
  ];
  return (
    <section className="grid min-w-0 gap-1.5">
      <SectionHeader
        level={3}
        title={t("modelGuides.facts")}
        description={t("modelGuides.factsNote")}
      />
      <dl className="m-0 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-x-4 gap-y-3">
        {rows.map((row) => (
          <div className="grid min-w-0 gap-0.5" key={row.label}>
            <dt className="text-xs text-ink-faint">{row.label}</dt>
            <dd className="m-0 text-sm font-semibold wrap-anywhere">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Observations({
  guideId,
  initial,
}: {
  guideId: string;
  initial: ModelObservationPage;
}) {
  const { t } = useTranslation("profiles");
  const [items, setItems] = useState<ModelObservation[]>(initial.observations);
  const [next, setNext] = useState(initial.nextOffset);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  async function more() {
    if (next === undefined) return;
    setLoading(true);
    setError(false);
    try {
      const page = await listModelGuideObservations(guideId, { offset: next });
      setItems((current) => [...current, ...page.observations]);
      setNext(page.nextOffset);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="grid min-w-0 gap-1.5">
      <SectionHeader level={3} title={t("modelGuides.observations")} />
      {items.length === 0 ? (
        <MutedText>{t("modelGuides.observationsEmpty")}</MutedText>
      ) : (
        <ul className="m-0 grid min-w-0 list-none p-0">
          {items.map((item) => (
            <li
              className="grid min-w-0 gap-1 border-t border-line-soft py-2.5 first:border-t-0"
              key={item.id}
            >
              <MarkdownContent>{item.body}</MarkdownContent>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-faint">
                <time dateTime={item.createdAt}>
                  {dateTime(item.createdAt)}
                </time>
                {item.sessionIds.length ? (
                  <span>{t("modelGuides.observationSessions")}</span>
                ) : null}
                {item.sessionIds.map((sessionId) => (
                  <AppLink
                    className="font-mono text-(--fdy-info-text) hover:underline"
                    href={chatHref(sessionId)}
                    key={sessionId}
                  >
                    {sessionId}
                  </AppLink>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <Alert
          size="compact"
          tone="error"
          title={t("modelGuides.loadMoreFailed")}
        />
      ) : null}
      {next !== undefined ? (
        <div>
          <Button
            busy={loading}
            disabled={loading}
            size="sm"
            onClick={() => void more()}
          >
            {t("modelGuides.loadMore")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function requestTime(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
