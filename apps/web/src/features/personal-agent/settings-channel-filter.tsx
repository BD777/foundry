import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import type {
  MessageChannelCapabilities,
  MessageChannelPeer,
  MessageChannelPeers,
  MessageChannelRule,
  MessageChannelTriState,
  MessageConversationKind,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { CheckLabel } from "../../components/ui/check-label";
import { ChipInput } from "../../components/ui/chip-input";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { Checkbox, FieldHint, TextInput } from "../../components/ui/field";
import {
  FieldLabel,
  FormField,
  FormFieldGroup,
} from "../../components/ui/form-field";
import {
  MultiPick,
  type MultiPickOption,
} from "../../components/ui/multi-pick";
import { SelectMenu } from "../../components/ui/select-menu";
import { Switch } from "../../components/ui/switch";
import {
  availablePlaces,
  channelBounds,
  customKinds,
  filterRules,
  newCustomRule,
  peerNames,
  placeKey,
  problemText,
  ruleSentence,
  shownPlaces,
  triStates,
  type ChannelProblem,
  type FilterDraft,
  type PeerNames,
  type PlaceId,
} from "./channel-model";

type T = ReturnType<typeof useTranslation<"personalAgent">>["t"];

/** The problem of this kind (and rule), as the in-place sentence. */
function problemAt(
  problems: readonly ChannelProblem[],
  t: T,
  kind: ChannelProblem["kind"],
  rule?: number,
): string | undefined {
  const found = problems.find(
    (problem) =>
      problem.kind === kind && (!("rule" in problem) || problem.rule === rule),
  );
  return found ? problemText(found, t) : undefined;
}

/** A problem under its control; the editor focuses the first one on Save. */
export function ProblemHint({ children }: { children?: string }) {
  return children ? (
    <FieldHint data-channel-problem="" tone="warning">
      {children}
    </FieldHint>
  ) : null;
}

/**
 * The channel's filter: shared trigger words, the places they apply in
 * (from what the source can tell apart), each resulting rule as a
 * sentence, and custom rules under Advanced.
 */
export function ChannelFilterEditor({
  advancedOpen,
  capabilities,
  filter,
  onAdvancedOpenChange,
  onChange,
  peers,
  problems,
}: {
  advancedOpen: boolean;
  capabilities: MessageChannelCapabilities;
  filter: FilterDraft;
  onAdvancedOpenChange: (open: boolean) => void;
  onChange: (filter: FilterDraft) => void;
  peers?: MessageChannelPeers;
  problems: readonly ChannelProblem[];
}) {
  const { t } = useTranslation("personalAgent");
  const ids = useId();
  const places = availablePlaces(capabilities);
  // An older place stays listed while the editor is open, to turn back on.
  const [initialPlaces] = useState(filter.places);
  const listed = shownPlaces(capabilities, [
    ...initialPlaces,
    ...filter.places,
  ]);
  const names = peerNames(peers);
  const rules = filterRules(filter, capabilities).filter(
    (rule) => rule.enabled,
  );
  const togglePlace = (place: PlaceId, on: boolean) =>
    onChange({
      ...filter,
      places: on
        ? [...filter.places.filter((entry) => entry !== place), place]
        : filter.places.filter((entry) => entry !== place),
    });
  const setCustom = (custom: MessageChannelRule[]) =>
    onChange({ ...filter, custom });
  const full = filter.triggers.length >= channelBounds.prefixes;

  return (
    <>
      <FormFieldGroup data-channel-field="">
        <FieldLabel htmlFor={`${ids}-triggers`}>
          {t("settings.channels.editor.triggers")}
        </FieldLabel>
        <ChipInput
          aria-describedby={`${ids}-triggers-hint`}
          id={`${ids}-triggers`}
          invalid={problems.some((problem) => problem.kind === "noTriggers")}
          maxItems={channelBounds.prefixes}
          maxLength={channelBounds.prefix}
          onChange={(triggers) => onChange({ ...filter, triggers })}
          placeholder={t("settings.channels.editor.triggersPlaceholder")}
          removeLabel={(word) =>
            t("settings.channels.editor.removeTrigger", { word })
          }
          values={filter.triggers}
        />
        <ProblemHint>{problemAt(problems, t, "noTriggers")}</ProblemHint>
        {full ? (
          <FieldHint>{t("settings.channels.editor.triggersFull")}</FieldHint>
        ) : null}
        <FieldHint id={`${ids}-triggers-hint`}>
          {t("settings.channels.editor.triggersHint")}
        </FieldHint>
      </FormFieldGroup>

      <fieldset
        className="grid min-w-0 gap-2 border-0 p-0"
        data-channel-field=""
      >
        <FieldLabel as="span">
          {t("settings.channels.editor.placesTitle")}
        </FieldLabel>
        {listed.map((place) => (
          <label
            className="flex min-w-0 cursor-pointer items-start gap-2.5 text-sm text-ink"
            key={place}
          >
            <Switch
              checked={filter.places.includes(place)}
              className="mt-0.5"
              onCheckedChange={(on) => togglePlace(place, on)}
            />
            <span>
              {t(
                `settings.channels.editor.places.${placeKey(place, capabilities)}`,
              )}
            </span>
          </label>
        ))}
        <ProblemHint>{problemAt(problems, t, "noPlace")}</ProblemHint>
      </fieldset>

      <div className="grid min-w-0 gap-1.5 rounded-lg bg-inset px-3.5 py-3">
        <FieldLabel as="span">
          {t("settings.channels.editor.summaryTitle")}
        </FieldLabel>
        {rules.length ? (
          <ul className="grid list-disc gap-1 ps-4 text-xs leading-normal text-ink">
            {rules.map((rule) => (
              <li className="wrap-anywhere" key={rule.id}>
                {ruleSentence(rule, capabilities, t, names)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-muted">
            {t("settings.channels.editor.summaryEmpty")}
          </p>
        )}
      </div>

      <Disclosure
        onToggle={(event) => onAdvancedOpenChange(event.currentTarget.open)}
        open={advancedOpen}
      >
        <DisclosureSummary>
          {t("settings.channels.editor.advanced")}
          {filter.custom.length ? ` · ${filter.custom.length}` : ""}
        </DisclosureSummary>
        <div className="grid min-w-0 gap-3 pt-1">
          <FieldHint className="mt-0">
            {t("settings.channels.editor.customHint")}
          </FieldHint>
          {filter.custom.length ? (
            <ol className="grid min-w-0 list-none gap-3 p-0">
              {filter.custom.map((rule, index) => (
                <CustomRuleEditor
                  capabilities={capabilities}
                  index={index}
                  key={rule.id}
                  names={names}
                  onChange={(next) =>
                    setCustom(
                      filter.custom.map((entry, at) =>
                        at === index ? next : entry,
                      ),
                    )
                  }
                  onRemove={() =>
                    setCustom(filter.custom.filter((_, at) => at !== index))
                  }
                  peers={peers}
                  problems={problems}
                  rule={rule}
                />
              ))}
            </ol>
          ) : null}
          <Button
            className="justify-self-start"
            disabled={
              places.length + filter.custom.length >= channelBounds.rules
            }
            onClick={() =>
              setCustom([...filter.custom, newCustomRule(filter, capabilities)])
            }
            size="sm"
            variant="secondary"
          >
            <Plus aria-hidden="true" size={14} />
            {t("settings.channels.editor.addRule")}
          </Button>
        </div>
      </Disclosure>
    </>
  );
}

function peerOptions(
  list: readonly MessageChannelPeer[],
  t: T,
  withKind: boolean,
): MultiPickOption[] {
  return list.map((peer) => ({
    value: peer.id,
    label: peer.name || peer.id,
    detail:
      withKind && peer.conversationKind
        ? `${t(`settings.channels.editor.kind.${peer.conversationKind}`)} · ${peer.id}`
        : peer.id,
    status: t("settings.channels.editor.peerSeen", { count: peer.count }),
  }));
}

const idLists = [
  ["conversationIds", "conversations", "onlyConversations"],
  ["excludeConversationIds", "conversations", "excludeConversations"],
  ["senderIds", "senders", "onlySenders"],
  ["excludeSenderIds", "senders", "excludeSenders"],
] as const;

function CustomRuleEditor({
  capabilities,
  index,
  names,
  onChange,
  onRemove,
  peers,
  problems,
  rule,
}: {
  capabilities: MessageChannelCapabilities;
  index: number;
  names: PeerNames;
  onChange: (next: MessageChannelRule) => void;
  onRemove: () => void;
  peers?: MessageChannelPeers;
  problems: readonly ChannelProblem[];
  rule: MessageChannelRule;
}) {
  const { t } = useTranslation("personalAgent");
  const ids = useId();
  const set = (patch: Partial<MessageChannelRule>) =>
    onChange({ ...rule, ...patch });
  const sentence = ruleSentence(rule, capabilities, t, names);
  const toggleKind = (kind: MessageConversationKind, on: boolean) =>
    set({
      conversationKinds: on
        ? [...rule.conversationKinds.filter((value) => value !== kind), kind]
        : rule.conversationKinds.filter((value) => value !== kind),
    });
  const triOptions = (group: "mentions" | "fromSelfOptions") =>
    triStates.map((value) => ({
      value,
      label: t(`settings.channels.editor.${group}.${value}`),
    }));
  const showMention = capabilities.mentionsMe || rule.mentionsMe !== "any";
  const showSelf = capabilities.fromSelf || rule.fromSelf !== "any";
  const noPeers =
    !peers || (peers.conversations.length === 0 && peers.senders.length === 0);

  return (
    <li className="grid min-w-0 gap-3 rounded-lg bg-inset p-3.5">
      <div className="flex min-w-0 items-start gap-2.5">
        <Switch
          aria-label={`${sentence} · ${t("settings.channels.editor.ruleEnabled")}`}
          checked={rule.enabled}
          className="mt-0.5"
          onCheckedChange={(enabled) => set({ enabled })}
        />
        <strong className="min-w-0 flex-1 text-sm font-semibold wrap-anywhere text-ink">
          {sentence}
        </strong>
        <Button
          aria-label={`${sentence} · ${t("settings.channels.editor.removeRule")}`}
          onClick={onRemove}
          size="icon"
          variant="icon"
        >
          <Trash2 aria-hidden="true" size={15} />
        </Button>
      </div>
      <fieldset
        className="grid min-w-0 gap-1.5 border-0 p-0"
        data-channel-field=""
      >
        <FieldLabel as="span">
          {t("settings.channels.editor.rulePlaces")}
        </FieldLabel>
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1.5">
          {customKinds(capabilities, rule).map((kind) => (
            <CheckLabel key={kind}>
              <Checkbox
                checked={rule.conversationKinds.includes(kind)}
                onChange={(event) => toggleKind(kind, event.target.checked)}
              />
              <span>{t(`settings.channels.editor.kind.${kind}`)}</span>
            </CheckLabel>
          ))}
        </div>
        <ProblemHint>
          {problemAt(problems, t, "customNoPlace", index)}
        </ProblemHint>
      </fieldset>
      {showMention || showSelf ? (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {showMention ? (
            <FormFieldGroup>
              <span>{t("settings.channels.editor.mentionsMe")}</span>
              <SelectMenu
                ariaLabel={`${sentence} · ${t("settings.channels.editor.mentionsMe")}`}
                insideDialog
                onChange={(value) =>
                  set({ mentionsMe: value as MessageChannelTriState })
                }
                options={triOptions("mentions")}
                value={rule.mentionsMe}
              />
            </FormFieldGroup>
          ) : null}
          {showSelf ? (
            <FormFieldGroup>
              <span>{t("settings.channels.editor.fromSelf")}</span>
              <SelectMenu
                ariaLabel={`${sentence} · ${t("settings.channels.editor.fromSelf")}`}
                insideDialog
                onChange={(value) =>
                  set({ fromSelf: value as MessageChannelTriState })
                }
                options={triOptions("fromSelfOptions")}
                value={rule.fromSelf}
              />
            </FormFieldGroup>
          ) : null}
        </div>
      ) : null}
      <FormFieldGroup data-channel-field="">
        <FieldLabel htmlFor={`${ids}-triggers`}>
          {t("settings.channels.editor.ruleTriggers")}
        </FieldLabel>
        <ChipInput
          id={`${ids}-triggers`}
          maxItems={channelBounds.prefixes}
          maxLength={channelBounds.prefix}
          onChange={(textPrefixes) => set({ textPrefixes })}
          placeholder={t("settings.channels.editor.triggersPlaceholder")}
          removeLabel={(word) =>
            t("settings.channels.editor.removeTrigger", { word })
          }
          values={rule.textPrefixes}
        />
        <ProblemHint>
          {problemAt(problems, t, "customNoTrigger", index)}
        </ProblemHint>
      </FormFieldGroup>
      {noPeers ? (
        <FieldHint className="mt-0">
          {t("settings.channels.editor.peersEmpty")}
        </FieldHint>
      ) : null}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {idLists.map(([key, list, label]) => (
          <FormFieldGroup key={key}>
            <span>{t(`settings.channels.editor.${label}`)}</span>
            <MultiPick
              addLabel={t("settings.channels.editor.pickAdd")}
              ariaLabel={`${sentence} · ${t(`settings.channels.editor.${label}`)}`}
              emptyText={t("settings.channels.editor.pickEmpty")}
              labelFor={(id) => names(list, id)}
              onChange={(values) => set({ [key]: values })}
              options={peerOptions(
                peers?.[list] ?? [],
                t,
                list === "conversations",
              )}
              removeLabel={(name) =>
                t("settings.channels.editor.removePeer", { name })
              }
              searchPlaceholder={t("settings.channels.editor.pickSearch")}
              values={rule[key] ?? []}
            />
          </FormFieldGroup>
        ))}
      </div>
      <FormField className="max-w-sm" htmlFor={`${ids}-label`}>
        <span>{t("settings.channels.editor.ruleLabel")}</span>
        <TextInput
          id={`${ids}-label`}
          maxLength={channelBounds.name}
          onChange={(event) => set({ label: event.target.value })}
          tone="boxed"
          value={rule.label ?? ""}
        />
      </FormField>
    </li>
  );
}
