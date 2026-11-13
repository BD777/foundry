import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  MessageChannelCapabilities,
  MessageChannelRule,
  MessageChannelSample,
  MessageChannelVerdict,
} from "@bd777/foundry-protocol";
import { testMessageChannelRules } from "../../api";
import { Badge } from "../../components/ui/badge";
import { DividedList } from "../../components/ui/divided-list";
import { TextInput } from "../../components/ui/field";
import { FormField, FormFieldGroup } from "../../components/ui/form-field";
import { Skeleton } from "../../components/ui/loading";
import { SelectMenu } from "../../components/ui/select-menu";
import { serverErrorText } from "../../lib/errors";
import { clockTime, fullWhen } from "../../lib/time-format";
import {
  availablePlaces,
  missText,
  placeKey,
  placeSample,
  readVerdict,
  ruleSentence,
  type PeerNames,
  type PlaceId,
} from "./channel-model";
import { PaMuted } from "./pa-muted";
import { SettingsGroup } from "./settings-field";

const recentShown = 10;

type T = ReturnType<typeof useTranslation<"personalAgent">>["t"];

/** What a verdict says, in one line: the rule that matched, or why not. */
function verdictText(
  verdict: MessageChannelVerdict,
  rules: readonly MessageChannelRule[],
  capabilities: MessageChannelCapabilities,
  names: PeerNames,
  t: T,
): { keep: boolean; text: string } {
  const reading = readVerdict(verdict, rules);
  if (reading.keep)
    return {
      keep: true,
      text: reading.rule
        ? ruleSentence(reading.rule, capabilities, t, names)
        : "",
    };
  return { keep: false, text: missText(reading, t) };
}

/**
 * Tries the unsaved rules: on a message the person types, and on the
 * source's recent messages that their channels saw.
 */
export function ChannelRuleTrial({
  assistantId,
  capabilities,
  names,
  rules,
  sourceAccountId,
}: {
  assistantId?: string;
  capabilities: MessageChannelCapabilities;
  names: PeerNames;
  rules: MessageChannelRule[];
  sourceAccountId: string;
}) {
  const { t } = useTranslation("personalAgent");
  const ids = useId();
  const places = availablePlaces(capabilities);
  const [text, setText] = useState("");
  const [chosenPlace, setPlace] = useState<PlaceId>("direct");
  const place = places.includes(chosenPlace) ? chosenPlace : places[0];
  const [sample, setSample] = useState<{
    verdict?: MessageChannelVerdict;
    error?: string;
    checking: boolean;
  }>({ checking: false });
  const [recent, setRecent] = useState<{
    verdicts?: MessageChannelVerdict[];
    error?: string;
  }>({});
  // The rules change identity on every render; their content is the key.
  const rulesKey = JSON.stringify(rules);
  const sampleKey = place
    ? JSON.stringify(placeSample(place, text, capabilities))
    : "";

  useEffect(() => {
    let cancelled = false;
    if (!text.trim() || !place) {
      setSample({ checking: false });
      return;
    }
    setSample((current) => ({ ...current, checking: true }));
    const timer = window.setTimeout(() => {
      testMessageChannelRules(assistantId, {
        filters: { rules: JSON.parse(rulesKey) as MessageChannelRule[] },
        samples: [JSON.parse(sampleKey) as MessageChannelSample],
      })
        .then((result) => {
          if (!cancelled)
            setSample({ verdict: result.verdicts[0], checking: false });
        })
        .catch((reason: unknown) => {
          if (!cancelled)
            setSample({ error: serverErrorText(reason), checking: false });
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [assistantId, place, rulesKey, sampleKey, text]);

  useEffect(() => {
    let cancelled = false;
    if (!sourceAccountId) {
      setRecent({});
      return;
    }
    const timer = window.setTimeout(() => {
      testMessageChannelRules(assistantId, {
        filters: { rules: JSON.parse(rulesKey) as MessageChannelRule[] },
        sourceAccountId,
        recent: true,
      })
        .then((result) => {
          if (!cancelled)
            setRecent({
              verdicts: result.verdicts
                .filter((verdict) => verdict.sample === undefined)
                .slice(0, recentShown),
            });
        })
        .catch((reason: unknown) => {
          if (!cancelled) setRecent({ error: serverErrorText(reason) });
        });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [assistantId, rulesKey, sourceAccountId]);

  const shown = sample.verdict
    ? verdictText(sample.verdict, rules, capabilities, names, t)
    : undefined;

  return (
    <>
      {place ? (
        <SettingsGroup title={t("settings.channels.editor.tryTitle")}>
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
            <FormField htmlFor={`${ids}-sample`}>
              <span>{t("settings.channels.editor.trySample")}</span>
              <TextInput
                id={`${ids}-sample`}
                onChange={(event) => setText(event.target.value)}
                placeholder={t("settings.channels.editor.trySamplePlaceholder")}
                tone="boxed"
                value={text}
              />
            </FormField>
            <FormFieldGroup>
              <span>{t("settings.channels.editor.tryPlace")}</span>
              <SelectMenu
                ariaLabel={t("settings.channels.editor.tryPlace")}
                insideDialog
                onChange={(value) => setPlace(value as PlaceId)}
                options={places.map((value) => ({
                  value,
                  label: t(
                    `settings.channels.editor.places.${placeKey(value, capabilities)}`,
                  ),
                }))}
                value={place}
              />
            </FormFieldGroup>
          </div>
          <div aria-live="polite" className="min-h-5 text-xs">
            {!text.trim() ? null : sample.error ? (
              <PaMuted size="xs" tone="error">
                {`${t("settings.channels.editor.tryFailed")}: ${sample.error}`}
              </PaMuted>
            ) : sample.checking || !shown ? (
              <PaMuted size="xs">
                {t("settings.channels.editor.tryChecking")}
              </PaMuted>
            ) : (
              <PaMuted
                className="font-medium"
                size="xs"
                tone={shown.keep ? "ink" : "warning"}
              >
                {shown.keep
                  ? t("settings.channels.editor.tryKept", { rule: shown.text })
                  : t("settings.channels.editor.tryMissed", {
                      reason: shown.text,
                    })}
              </PaMuted>
            )}
          </div>
        </SettingsGroup>
      ) : null}

      {sourceAccountId ? (
        <SettingsGroup title={t("settings.channels.editor.recentTitle")}>
          {recent.error ? (
            <PaMuted size="xs" tone="error">
              {`${t("settings.channels.editor.recentFailed")}: ${recent.error}`}
            </PaMuted>
          ) : recent.verdicts === undefined ? (
            <Skeleton
              className="h-16"
              label={t("settings.channels.editor.recentLoading")}
            />
          ) : recent.verdicts.length === 0 ? (
            <PaMuted size="xs">
              {t("settings.channels.editor.recentEmpty")}
            </PaMuted>
          ) : (
            <DividedList density="compact">
              {recent.verdicts.map((verdict) => (
                <RecentRow
                  key={verdict.envelope.id}
                  result={verdictText(verdict, rules, capabilities, names, t)}
                  verdict={verdict}
                />
              ))}
            </DividedList>
          )}
        </SettingsGroup>
      ) : null}
    </>
  );
}

function RecentRow({
  result,
  verdict,
}: {
  result: { keep: boolean; text: string };
  verdict: MessageChannelVerdict;
}) {
  const { t } = useTranslation("personalAgent");
  const { envelope } = verdict;
  const conversation =
    envelope.conversation.name ||
    `${t(`settings.channels.editor.kind.${envelope.conversation.kind}`, {
      defaultValue: envelope.conversation.kind,
    })} · ${envelope.conversation.id}`;
  const sender =
    envelope.sender.name && envelope.sender.name !== envelope.conversation.name
      ? envelope.sender.name
      : "";
  const body = envelope.text.replace(/\s+/g, " ").trim();
  const at = envelope.occurredAt;

  return (
    <li className="grid min-w-0 gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Badge
          size="xs"
          tone={result.keep && !verdict.textUnknown ? "online" : "neutral"}
        >
          {verdict.textUnknown && result.keep
            ? t("settings.channels.editor.recentDependsOnText")
            : result.keep
              ? t("settings.channels.editor.recentKept")
              : t("settings.channels.editor.recentMissed")}
        </Badge>
        {at ? (
          <time className="text-ink-muted" dateTime={at} title={fullWhen(at)}>
            {clockTime(at, { date: "short" })}
          </time>
        ) : null}
        <span className="min-w-0 font-medium wrap-anywhere text-ink">
          {conversation}
        </span>
        {sender ? <span className="text-ink-muted">{sender}</span> : null}
      </div>
      <PaMuted className="truncate" size="xs" tone="ink">
        {body ||
          t(
            verdict.textUnknown
              ? "settings.channels.editor.recentTextNotKept"
              : "settings.channels.editor.recentNoText",
          )}
      </PaMuted>
      {result.text ? (
        <PaMuted size="xs">
          {verdict.textUnknown && result.keep
            ? t("settings.channels.editor.recentIfTrigger", {
                rule: result.text,
              })
            : result.keep
              ? result.text
              : t("settings.channels.editor.tryMissed", {
                  reason: result.text,
                })}
        </PaMuted>
      ) : null}
    </li>
  );
}
