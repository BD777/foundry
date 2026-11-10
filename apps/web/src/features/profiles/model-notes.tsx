import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import type {
  AgentProfileProjection,
  ModelNote,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import {
  appendModelNote,
  deleteModelNote,
  listModelNotes,
  updateModelNote,
  type ModelNoteTarget,
} from "../../api";
import { i18n } from "../../i18n";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { FieldHint, Textarea } from "../../components/ui/field";
import { SectionHeader } from "../../components/ui/page-header";
import { runtimeMeta } from "../../components/agent-runtime/runtime-mark";

type ProviderKind = ModelNoteTarget["providerKind"];

interface NoteSource extends ModelNoteTarget {
  key: string;
  providerLabel: string;
}

interface ProviderGroup {
  key: string;
  label: string;
  kind: ProviderKind;
  runtime: ModelNoteTarget["runtime"];
  models: NoteSource[];
}

function kindOf(profile: AgentProfileProjection): ProviderKind | undefined {
  if (profile.connectionType === "local_login") return "subscription";
  if (profile.connectionType === "external") return "environment";
  if (
    profile.connectionType === "anthropic_compatible" ||
    profile.connectionType === "openai_compatible"
  )
    return profile.origin === "server" ? "api" : "discovered";
  return undefined;
}

function modelIds(profile: { model?: string; models?: string[] }): string[] {
  return [...new Set([profile.model ?? "", ...(profile.models ?? [])])].filter(
    Boolean,
  );
}

function noteSources(
  profiles: ProfileDefinition[],
  agentProfiles: AgentProfileProjection[],
  kinds: readonly ProviderKind[],
  runtimes: readonly string[],
): ProviderGroup[] {
  const sources = new Map<string, NoteSource>();
  const add = (
    providerKind: ProviderKind,
    providerId: string,
    providerLabel: string,
    runtime: string,
    model: string,
  ) => {
    const target: NoteSource = {
      key: [providerKind, providerId, runtime, model].join("\u0000"),
      providerKind,
      providerId,
      providerLabel,
      runtime: runtime as ModelNoteTarget["runtime"],
      model,
    };
    sources.set(target.key, target);
  };
  for (const profile of profiles) {
    for (const model of modelIds(profile))
      add("api", profile.id, profile.label, profile.runtime, model);
  }
  for (const profile of agentProfiles) {
    const providerKind = kindOf(profile);
    if (!providerKind) continue;
    for (const model of modelIds(profile))
      add(providerKind, profile.id, profile.label, profile.runtime, model);
  }
  const grouped = new Map<string, ProviderGroup>();
  for (const source of sources.values()) {
    if (!kinds.includes(source.providerKind)) continue;
    if (!runtimes.includes(source.runtime)) continue;
    const key = [source.providerKind, source.providerId, source.runtime].join(
      "\u0000",
    );
    let group = grouped.get(key);
    if (!group) {
      group = {
        key,
        label: source.providerLabel,
        kind: source.providerKind,
        runtime: source.runtime,
        models: [],
      };
      grouped.set(key, group);
    }
    group.models.push(source);
  }
  return [...grouped.values()]
    .map((group) => ({
      ...group,
      models: group.models.sort((a, b) => a.model.localeCompare(b.model)),
    }))
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label) || a.runtime.localeCompare(b.runtime),
    );
}

/** Model-specific lessons the orchestrator may read before delegating. */
export function ModelNotesSection({
  profiles,
  agentProfiles,
  kinds,
  runtimes,
}: {
  profiles: ProfileDefinition[];
  agentProfiles: AgentProfileProjection[];
  kinds: readonly ProviderKind[];
  runtimes: readonly string[];
}) {
  const { t } = useTranslation("profiles");
  const providers = noteSources(profiles, agentProfiles, kinds, runtimes);
  return (
    <section className="grid min-w-0 gap-3 border-t border-line pt-4">
      <SectionHeader
        level={3}
        title={t("modelNotes.title")}
        description={t("modelNotes.intro")}
      />
      {providers.length ? (
        <div className="grid min-w-0 gap-2">
          {providers.map((provider) => (
            <details
              className="group min-w-0 border-b border-line-soft pb-2"
              key={provider.key}
            >
              <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-2 rounded-sm py-1.5 text-sm font-semibold [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="flex-none transition-transform group-open:rotate-90"
                  size={15}
                />
                <span className="min-w-0 truncate">{provider.label}</span>
                <small className="ml-auto text-2xs font-normal text-ink-muted max-[680px]:basis-full max-[680px]:pl-5">
                  {t(`modelNotes.kinds.${provider.kind}`)} ·{" "}
                  {runtimeMeta(provider.runtime).label} ·{" "}
                  {t("modelNotes.modelCount", {
                    count: provider.models.length,
                  })}
                </small>
              </summary>
              <div className="grid min-w-0 gap-1 pl-5">
                {provider.models.map((source) => (
                  <ModelNotes key={source.key} source={source} />
                ))}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <FieldHint>{t("modelNotes.none")}</FieldHint>
      )}
    </section>
  );
}

function targetOf(source: NoteSource): ModelNoteTarget {
  return {
    providerKind: source.providerKind,
    providerId: source.providerId,
    runtime: source.runtime,
    model: source.model,
  };
}

function noteTime(value: string): string {
  return new Date(value).toLocaleString(i18n.language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ModelNotes({ source }: { source: NoteSource }) {
  const { t } = useTranslation("profiles");
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<ModelNote[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [writing, setWriting] = useState(false);
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<string>();
  const [editBody, setEditBody] = useState("");

  async function load(offset = 0) {
    setLoading(true);
    setError("");
    try {
      const page = await listModelNotes(targetOf(source), { offset });
      setNotes((current) =>
        offset === 0 ? page.notes : [...current, ...page.notes],
      );
      setTotal(page.total);
      setNextOffset(page.nextOffset);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("modelNotes.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }

  function opened() {
    if (open) return;
    setOpen(true);
    if (!notes.length && !loading) void load();
  }

  async function append() {
    if (!body.trim()) return;
    setLoading(true);
    setError("");
    try {
      await appendModelNote({ ...targetOf(source), body });
      setBody("");
      setWriting(false);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("modelNotes.saveFailed"),
      );
    } finally {
      setLoading(false);
    }
  }

  async function saveEdit(id: string) {
    setLoading(true);
    setError("");
    try {
      await updateModelNote(id, editBody);
      setEditing(undefined);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("modelNotes.saveFailed"),
      );
    } finally {
      setLoading(false);
    }
  }

  async function remove(id: string) {
    setLoading(true);
    setError("");
    try {
      await deleteModelNote(id);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("modelNotes.deleteFailed"),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="group/model min-w-0 border-t border-line-soft first:border-t-0"
      onToggle={(event) => {
        if (event.currentTarget.open) opened();
        else setOpen(false);
      }}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-1.5 text-xs [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="flex-none transition-transform group-open/model:rotate-90"
          size={13}
        />
        <code className="min-w-0 break-all text-xs">{source.model}</code>
        {open ? (
          <small className="ml-auto flex-none text-2xs text-ink-muted">
            {t("modelNotes.count", { count: total })}
          </small>
        ) : null}
      </summary>
      <div className="grid min-w-0 gap-2 pb-2 pl-5">
        {notes.map((note) => (
          <article
            className="grid min-w-0 gap-1 border-t border-line-soft py-2 first:border-t-0"
            key={note.id}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-ink-muted">
              <strong className="text-ink">{note.authorName}</strong>
              <time dateTime={note.createdAt}>{noteTime(note.createdAt)}</time>
              {note.updatedAt ? (
                <span>
                  {t("modelNotes.edited", { time: noteTime(note.updatedAt) })}
                </span>
              ) : null}
              <span className="ml-auto flex items-center gap-1">
                <Button
                  aria-label={t("modelNotes.editLabel", {
                    model: source.model,
                  })}
                  onClick={() => {
                    setEditing(note.id);
                    setEditBody(note.body);
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <Pencil size={13} />
                </Button>
                <ConfirmButton
                  aria-label={t("modelNotes.deleteLabel", {
                    model: source.model,
                  })}
                  confirmLabel={t("modelNotes.deleteConfirm")}
                  onConfirm={() => void remove(note.id)}
                  size="icon"
                  variant="ghost"
                >
                  <Trash2 size={13} />
                </ConfirmButton>
              </span>
            </div>
            {editing === note.id ? (
              <div className="grid min-w-0 gap-2">
                <Textarea
                  aria-label={t("modelNotes.editLabel", {
                    model: source.model,
                  })}
                  onChange={(event) => setEditBody(event.currentTarget.value)}
                  rows={4}
                  tone="boxed"
                  value={editBody}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={loading || !editBody.trim()}
                    onClick={() => void saveEdit(note.id)}
                    size="sm"
                  >
                    {t("modelNotes.save")}
                  </Button>
                  <Button
                    onClick={() => setEditing(undefined)}
                    size="sm"
                    variant="ghost"
                  >
                    {t("modelNotes.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="m-0 whitespace-pre-wrap text-xs leading-[1.7] text-ink">
                {note.body}
              </p>
            )}
          </article>
        ))}
        {!loading && open && !notes.length ? (
          <FieldHint>{t("modelNotes.empty")}</FieldHint>
        ) : null}
        {writing ? (
          <div className="grid min-w-0 gap-2 border-t border-line-soft pt-2">
            <Textarea
              aria-label={t("modelNotes.addLabel", { model: source.model })}
              onChange={(event) => setBody(event.currentTarget.value)}
              placeholder={t("modelNotes.addPlaceholder")}
              rows={4}
              tone="boxed"
              value={body}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={loading || !body.trim()}
                onClick={() => void append()}
                size="sm"
              >
                {t("modelNotes.add")}
              </Button>
              <Button
                onClick={() => setWriting(false)}
                size="sm"
                variant="ghost"
              >
                {t("modelNotes.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            className="justify-self-start"
            onClick={() => setWriting(true)}
            size="sm"
            variant="link"
          >
            <Plus size={13} />
            {t("modelNotes.addButton")}
          </Button>
        )}
        {nextOffset !== undefined ? (
          <Button
            busy={loading}
            onClick={() => void load(nextOffset)}
            size="sm"
            variant="secondary"
          >
            {t("modelNotes.loadMore")}
          </Button>
        ) : null}
        {error ? <Alert size="compact" tone="error" title={error} /> : null}
      </div>
    </details>
  );
}
