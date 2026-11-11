import type {
  EdgeAccess,
  EdgeAccessInput,
  EdgeAccessMatch,
} from "@bd777/foundry-protocol";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  createEdgeAccessCredential,
  deleteEdgeAccessCredential,
  getEdgeAccessCredentials,
  replaceEdgeAccessCredential,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { Dialog } from "../../components/ui/dialog";
import { DividedList } from "../../components/ui/divided-list";
import { EmptyState } from "../../components/ui/empty-state";
import { FieldHint, TextInput } from "../../components/ui/field";
import {
  FieldLabel,
  FormFieldGroup,
  FormLayout,
} from "../../components/ui/form-field";
import { LoadingState } from "../../components/ui/loading";
import { SectionHeader } from "../../components/ui/page-header";
import { MutedText } from "../../components/ui/text";
import { takeEdgeAccessPrefill } from "../../lib/in-app-navigation";
import { serverErrorText } from "../../lib/errors";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { ConnectorSection } from "./connector-section";

interface EdgeAccessDraft {
  label: string;
  host: string;
  pathPrefix: string;
  team: string;
  audience: string;
  clientId: string;
  clientSecret: string;
}

function draftFor(
  item?: EdgeAccess,
  prefill?: EdgeAccessMatch,
): EdgeAccessDraft {
  return {
    label: item?.label ?? "",
    host: item?.match.host ?? prefill?.host ?? "",
    pathPrefix: item?.match.pathPrefix ?? prefill?.pathPrefix ?? "",
    team: item?.team ?? "",
    audience: item?.audience ?? "",
    clientId: "",
    clientSecret: "",
  };
}

function scopeLabel(match: EdgeAccessMatch): string {
  return `${match.host}${match.pathPrefix ?? ""}`;
}

export interface EdgeAccessListViewProps {
  credentials: EdgeAccess[];
  onAdd: () => void;
  onDelete: (item: EdgeAccess) => void;
  onReplace: (item: EdgeAccess) => void;
}

/** The credential list without its API state, for the Connectors page and tests. */
export function EdgeAccessListView({
  credentials,
  onAdd,
  onDelete,
  onReplace,
}: EdgeAccessListViewProps) {
  const { t } = useTranslation("externalAccounts");
  return (
    <div className="grid min-w-0 gap-3.5">
      <div className="flex min-w-0 justify-end">
        <Button onClick={onAdd} size="sm" variant="primary">
          <Plus aria-hidden="true" size={14} />
          {t("edgeAccess.add")}
        </Button>
      </div>
      {credentials.length === 0 ? (
        <EmptyState
          body={t("edgeAccess.emptyBody")}
          title={t("edgeAccess.emptyTitle")}
        />
      ) : (
        <DividedList density="roomy">
          {credentials.map((item) => (
            <li
              className="grid min-w-0 gap-2.5"
              data-edge-access-id={item.id}
              key={item.id}
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="grid min-w-0 gap-1">
                  <strong className="wrap-anywhere text-sm text-ink">
                    {item.label}
                  </strong>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral">
                      {t(`edgeAccess.providers.${item.provider}`)}
                    </Badge>
                    {item.team ? (
                      <Badge dot={false} tone="slate">
                        {t("edgeAccess.team", { team: item.team })}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <ButtonRow align="end">
                  <Button
                    onClick={() => onReplace(item)}
                    size="sm"
                    variant="ghost"
                  >
                    <Pencil aria-hidden="true" size={14} />
                    {t("edgeAccess.replace")}
                  </Button>
                  <Button
                    onClick={() => onDelete(item)}
                    size="sm"
                    variant="ghost"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    {t("edgeAccess.delete")}
                  </Button>
                </ButtonRow>
              </div>
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-[1.5]">
                <dt className="text-ink-faint">{t("edgeAccess.matchLabel")}</dt>
                <dd className="m-0 min-w-0">
                  <code className="wrap-anywhere text-ink-muted">
                    {scopeLabel(item.match)}
                  </code>
                  {!item.match.pathPrefix ? (
                    <span className="ml-2 text-ink-faint">
                      {t("edgeAccess.wholeHost")}
                    </span>
                  ) : null}
                </dd>
                <dt className="text-ink-faint">
                  {t("edgeAccess.lastUsedLabel")}
                </dt>
                <dd className="m-0 min-w-0 text-ink-muted">
                  {item.lastUsedAt ? (
                    <time
                      dateTime={item.lastUsedAt}
                      title={fullWhen(item.lastUsedAt)}
                    >
                      {relativeWhen(item.lastUsedAt)}
                    </time>
                  ) : (
                    t("edgeAccess.neverUsed")
                  )}
                </dd>
              </dl>
            </li>
          ))}
        </DividedList>
      )}
    </div>
  );
}

function EdgeAccessDialog({
  item,
  prefill,
  onClose,
  onSaved,
}: {
  item?: EdgeAccess;
  prefill?: EdgeAccessMatch;
  onClose: () => void;
  onSaved: (item: EdgeAccess) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const { t: tCommon } = useTranslation("common");
  const id = useId();
  const replacing = Boolean(item);
  const [draft, setDraft] = useState(() => draftFor(item, prefill));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formID = `${id}-form`;

  function change(patch: Partial<EdgeAccessDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError("");
  }

  function validate(): string {
    if (!draft.label.trim()) return t("edgeAccess.errors.label");
    if (!draft.host.trim()) return t("edgeAccess.errors.hostRequired");
    if (/\s|\//.test(draft.host.trim())) return t("edgeAccess.errors.host");
    if (draft.pathPrefix.trim() && !draft.pathPrefix.trim().startsWith("/"))
      return t("edgeAccess.errors.path");
    if (!draft.clientId.trim()) return t("edgeAccess.errors.clientId");
    if (!draft.clientSecret.trim()) return t("edgeAccess.errors.clientSecret");
    return "";
  }

  async function submit(event: FormEvent<HTMLElement>) {
    event.preventDefault();
    if (busy) return;
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    const match: EdgeAccessMatch = {
      host: draft.host.trim(),
      ...(draft.pathPrefix.trim()
        ? { pathPrefix: draft.pathPrefix.trim() }
        : {}),
    };
    const input: EdgeAccessInput = {
      label: draft.label.trim(),
      provider: "cloudflare_access",
      match,
      ...(draft.team.trim() ? { team: draft.team.trim() } : {}),
      ...(draft.audience.trim() ? { audience: draft.audience.trim() } : {}),
      clientId: draft.clientId.trim(),
      clientSecret: draft.clientSecret,
    };
    setBusy(true);
    setError("");
    try {
      const saved = replacing
        ? await replaceEdgeAccessCredential(item!.id, input)
        : await createEdgeAccessCredential(input);
      onSaved(saved);
    } catch (cause) {
      setError(serverErrorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      busy={busy}
      description={t(
        replacing
          ? "edgeAccess.replaceDescription"
          : "edgeAccess.addDescription",
      )}
      footer={
        <ButtonRow align="end">
          <Button disabled={busy} onClick={onClose} size="sm" variant="ghost">
            {tCommon("actions.cancel")}
          </Button>
          <Button
            busy={busy}
            form={formID}
            size="sm"
            type="submit"
            variant="primary"
          >
            {busy
              ? t("edgeAccess.saving")
              : t(replacing ? "edgeAccess.saveReplacement" : "edgeAccess.save")}
          </Button>
        </ButtonRow>
      }
      onClose={onClose}
      size="large"
      title={t(replacing ? "edgeAccess.replaceTitle" : "edgeAccess.addTitle")}
    >
      <FormLayout
        as="form"
        id={formID}
        onSubmit={(event) => void submit(event)}
      >
        <FormFieldGroup>
          <FieldLabel htmlFor={`${id}-label`}>
            {t("edgeAccess.fields.label")}
          </FieldLabel>
          <TextInput
            autoComplete="off"
            disabled={busy}
            id={`${id}-label`}
            maxLength={160}
            onChange={(event) => change({ label: event.target.value })}
            placeholder={t("edgeAccess.fields.labelPlaceholder")}
            tone="boxed"
            value={draft.label}
          />
        </FormFieldGroup>
        <div className="grid min-w-0 gap-3.5 sm:grid-cols-2">
          <FormFieldGroup>
            <FieldLabel htmlFor={`${id}-host`}>
              {t("edgeAccess.fields.host")}
            </FieldLabel>
            <TextInput
              autoCapitalize="none"
              autoComplete="off"
              disabled={busy}
              id={`${id}-host`}
              onChange={(event) => change({ host: event.target.value })}
              placeholder={t("edgeAccess.fields.hostPlaceholder")}
              spellCheck={false}
              tone="boxed"
              value={draft.host}
            />
            <FieldHint as="small">{t("edgeAccess.fields.hostHint")}</FieldHint>
          </FormFieldGroup>
          <FormFieldGroup>
            <FieldLabel htmlFor={`${id}-path`}>
              {t("edgeAccess.fields.pathPrefix")}
            </FieldLabel>
            <TextInput
              autoCapitalize="none"
              autoComplete="off"
              disabled={busy}
              id={`${id}-path`}
              onChange={(event) => change({ pathPrefix: event.target.value })}
              placeholder={t("edgeAccess.fields.pathPrefixPlaceholder")}
              spellCheck={false}
              tone="boxed"
              value={draft.pathPrefix}
            />
            <FieldHint as="small">
              {t("edgeAccess.fields.pathPrefixHint")}
            </FieldHint>
          </FormFieldGroup>
        </div>
        <div className="grid gap-3.5 border-t border-line pt-4">
          <SectionHeader level={3} title={t("edgeAccess.identityTitle")} />
          <div className="grid min-w-0 gap-3.5 sm:grid-cols-2">
            <FormFieldGroup>
              <FieldLabel htmlFor={`${id}-team`}>
                {t("edgeAccess.fields.team")}
              </FieldLabel>
              <TextInput
                autoCapitalize="none"
                autoComplete="off"
                disabled={busy}
                id={`${id}-team`}
                onChange={(event) => change({ team: event.target.value })}
                placeholder={t("edgeAccess.fields.teamPlaceholder")}
                spellCheck={false}
                tone="boxed"
                value={draft.team}
              />
            </FormFieldGroup>
            <FormFieldGroup>
              <FieldLabel htmlFor={`${id}-audience`}>
                {t("edgeAccess.fields.audience")}
              </FieldLabel>
              <TextInput
                autoCapitalize="none"
                autoComplete="off"
                disabled={busy}
                id={`${id}-audience`}
                onChange={(event) => change({ audience: event.target.value })}
                placeholder={t("edgeAccess.fields.audiencePlaceholder")}
                spellCheck={false}
                tone="boxed"
                value={draft.audience}
              />
            </FormFieldGroup>
          </div>
        </div>
        <div className="grid min-w-0 gap-3.5 sm:grid-cols-2">
          <FormFieldGroup>
            <FieldLabel htmlFor={`${id}-client-id`}>
              {t("edgeAccess.fields.clientId")}
            </FieldLabel>
            <TextInput
              autoComplete="new-password"
              disabled={busy}
              id={`${id}-client-id`}
              maxLength={8192}
              onChange={(event) => change({ clientId: event.target.value })}
              placeholder={t("edgeAccess.fields.clientIdPlaceholder")}
              tone="boxed"
              value={draft.clientId}
            />
          </FormFieldGroup>
          <FormFieldGroup>
            <FieldLabel htmlFor={`${id}-client-secret`}>
              {t("edgeAccess.fields.clientSecret")}
            </FieldLabel>
            <TextInput
              autoComplete="new-password"
              disabled={busy}
              id={`${id}-client-secret`}
              maxLength={8192}
              onChange={(event) => change({ clientSecret: event.target.value })}
              placeholder={t("edgeAccess.fields.clientSecretPlaceholder")}
              tone="boxed"
              type="password"
              value={draft.clientSecret}
            />
          </FormFieldGroup>
        </div>
        <FieldHint as="small">{t("edgeAccess.fields.secretHint")}</FieldHint>
        {error ? <Alert title={error} tone="error" /> : null}
      </FormLayout>
    </Dialog>
  );
}

export function EdgeAccessSection({
  onNotice,
}: {
  onNotice?: (message: string) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const [credentials, setCredentials] = useState<EdgeAccess[]>();
  const [loadError, setLoadError] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const [editor, setEditor] = useState<{
    item?: EdgeAccess;
    prefill?: EdgeAccessMatch;
  } | null>(() => {
    const prefill = takeEdgeAccessPrefill();
    return prefill ? { prefill } : null;
  });
  const [deleting, setDeleting] = useState<EdgeAccess>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    let active = true;
    setLoadError("");
    getEdgeAccessCredentials().then(
      (view) => {
        if (active) setCredentials(view.credentials);
      },
      (cause: unknown) => {
        if (active) {
          setCredentials(undefined);
          setLoadError(serverErrorText(cause));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [readVersion]);

  function saved(item: EdgeAccess) {
    const replacing = Boolean(editor?.item);
    setCredentials((current) =>
      replacing
        ? current?.map((entry) => (entry.id === item.id ? item : entry))
        : [item, ...(current ?? [])],
    );
    setEditor(null);
    onNotice?.(
      t(replacing ? "edgeAccess.replaced" : "edgeAccess.created", {
        name: item.label,
      }),
    );
  }

  async function remove() {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await deleteEdgeAccessCredential(deleting.id);
      setCredentials((current) =>
        current?.filter((item) => item.id !== deleting.id),
      );
      onNotice?.(t("edgeAccess.deleted", { name: deleting.label }));
      setDeleting(undefined);
    } catch (cause) {
      setDeleteError(serverErrorText(cause));
    } finally {
      setDeleteBusy(false);
    }
  }

  const { t: tCommon } = useTranslation("common");
  return (
    <ConnectorSection
      description={t("edgeAccess.intro")}
      name={t("edgeAccess.title")}
    >
      {loadError ? (
        <Alert
          actions={
            <Button
              onClick={() => setReadVersion((value) => value + 1)}
              size="sm"
            >
              {t("edgeAccess.retry")}
            </Button>
          }
          title={t("edgeAccess.loadFailed")}
          tone="error"
        >
          {loadError}
        </Alert>
      ) : credentials === undefined ? (
        <LoadingState label={t("edgeAccess.loading")} layout="block" />
      ) : (
        <EdgeAccessListView
          credentials={credentials}
          onAdd={() => setEditor({})}
          onDelete={(item) => {
            setDeleteError("");
            setDeleting(item);
          }}
          onReplace={(item) => setEditor({ item })}
        />
      )}
      {editor ? (
        <EdgeAccessDialog
          item={editor.item}
          prefill={editor.prefill}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      ) : null}
      {deleting ? (
        <Dialog
          busy={deleteBusy}
          description={t("edgeAccess.deleteDescription", {
            name: deleting.label,
          })}
          footer={
            <ButtonRow align="end">
              <Button
                disabled={deleteBusy}
                onClick={() => setDeleting(undefined)}
                size="sm"
                variant="ghost"
              >
                {tCommon("actions.cancel")}
              </Button>
              <Button
                busy={deleteBusy}
                onClick={() => void remove()}
                size="sm"
                variant="danger"
              >
                {t("edgeAccess.deleteConfirm")}
              </Button>
            </ButtonRow>
          }
          onClose={() => setDeleting(undefined)}
          title={t("edgeAccess.deleteTitle")}
        >
          <MutedText>{t("edgeAccess.deleteConsequence")}</MutedText>
          {deleteError ? <Alert title={deleteError} tone="error" /> : null}
        </Dialog>
      ) : null}
    </ConnectorSection>
  );
}
