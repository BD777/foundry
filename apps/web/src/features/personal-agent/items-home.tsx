import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PersonalAgentItem,
  SessionLink,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { getSessionLink, isNotFoundForCaller } from "../../api";
import { AppLink } from "../../components/ui/app-link";
import { Button } from "../../components/ui/button";
import { SelectMenu } from "../../components/ui/select-menu";
import { chatHref, workspaceHref } from "../../lib/in-app-navigation";
import { workspaceLabel } from "./items-marks";

const linkClass =
  "text-ink underline decoration-line underline-offset-2 hover:text-brand";

/** The workspaces an item may live in: the person's own, never an assistant's home. */
export function homeChoices(workspaces: WorkspaceProjection[]) {
  return workspaces.filter(
    (workspace) => !workspace.archivedAt && workspace.kind !== "personal_agent",
  );
}

/**
 * Where an item lives: its home (a link, or the assistant's inbox), the
 * other workspaces it touches and the chat that follows it. The home changes
 * here while the item is open; `onChangeHome` "" moves it to the inbox.
 */
export function ItemHome({
  item,
  workspaces,
  pending,
  onChangeHome,
}: {
  item: PersonalAgentItem;
  workspaces: WorkspaceProjection[];
  pending: boolean;
  /** Saves the new home; resolves true once it is saved. */
  onChangeHome: (workspaceId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation("personalAgent");
  const [choosing, setChoosing] = useState(false);
  const home = item.homeWorkspaceId ?? "";
  const changeable = item.status === "open" && !item.archivedAt;
  const touches = item.touches ?? [];
  const choose = async (workspaceId: string) => {
    if (workspaceId === home || (await onChangeHome(workspaceId)))
      setChoosing(false);
  };
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-sm">
      <dt className="text-ink-muted">{t("items.home.home")}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {choosing ? (
          <>
            <SelectMenu
              ariaLabel={t("items.home.choose")}
              busy={pending}
              className="w-64 max-w-full"
              disabled={pending}
              onChange={(workspaceId) => void choose(workspaceId)}
              options={[
                { value: "", label: t("items.home.inbox") },
                ...homeChoices(workspaces).map((workspace) => ({
                  value: workspace.id,
                  label: workspace.name,
                })),
              ]}
              value={home}
            />
            <Button
              disabled={pending}
              onClick={() => setChoosing(false)}
              size="sm"
              variant="ghost"
            >
              {t("items.home.cancel")}
            </Button>
          </>
        ) : (
          <>
            <WorkspaceName workspaceId={home} workspaces={workspaces} />
            {changeable ? (
              <Button
                onClick={() => setChoosing(true)}
                size="sm"
                variant="ghost"
              >
                {t("items.home.change")}
              </Button>
            ) : null}
          </>
        )}
      </dd>
      {touches.length ? (
        <>
          <dt className="text-ink-muted">{t("items.home.touches")}</dt>
          <dd className="min-w-0 wrap-anywhere">
            {touches.map((workspaceId, index) => (
              <Fragment key={workspaceId}>
                {index ? ", " : null}
                <WorkspaceName
                  workspaceId={workspaceId}
                  workspaces={workspaces}
                />
              </Fragment>
            ))}
          </dd>
        </>
      ) : null}
      {item.holderSessionId ? (
        <>
          <dt className="text-ink-muted">{t("items.home.holder")}</dt>
          <dd className="min-w-0 wrap-anywhere">
            <HolderLink sessionId={item.holderSessionId} />
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/** A workspace by name, linked to its page while the person can see it. */
function WorkspaceName({
  workspaceId,
  workspaces,
}: {
  workspaceId: string;
  workspaces: WorkspaceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const label = workspaceLabel(workspaceId, workspaces, t);
  const known = workspaces.some((workspace) => workspace.id === workspaceId);
  if (!workspaceId || !known)
    return <span className="text-ink-muted">{label}</span>;
  return (
    <AppLink className={linkClass} href={workspaceHref(workspaceId)}>
      {label}
    </AppLink>
  );
}

/** The holder as its chat's title, linked to the chat in its workspace. */
function HolderLink({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("personalAgent");
  const link = useSessionLink(sessionId);
  if (link === undefined)
    return (
      <span className="text-ink-faint">{t("items.home.holderLoading")}</span>
    );
  if (link === null)
    return (
      <span className="text-ink-muted">{t("items.home.holderHidden")}</span>
    );
  return (
    <AppLink className={linkClass} href={chatHref(link.id, link.workspaceId)}>
      {link.title.trim() || t("items.actor.session")}
    </AppLink>
  );
}

/**
 * The server's name for one session: undefined while it is read, null when
 * the person may not view it (or it is gone). Another failure leaves a link
 * without a title, so the chat stays reachable.
 */
function useSessionLink(sessionId: string): SessionLink | null | undefined {
  const [state, setState] = useState<{
    id: string;
    link: SessionLink | null;
  }>();
  useEffect(() => {
    let cancelled = false;
    getSessionLink(sessionId).then(
      (link) => {
        if (!cancelled) setState({ id: sessionId, link });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          id: sessionId,
          link: isNotFoundForCaller(error)
            ? null
            : { id: sessionId, workspaceId: "", title: "" },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  return state?.id === sessionId ? state.link : undefined;
}
