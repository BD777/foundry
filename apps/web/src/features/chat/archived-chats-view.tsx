import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../../components/ui/empty-state";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox, TextInput } from "../../components/ui/field";
import { navigateToChat } from "../../lib/in-app-navigation";
import { useChatDocumentTitle } from "./use-chat-document-title";
import { useChatLayout } from "./use-chat-layout";
import type { ArchivedChat } from "./chat-archive-banner";

export function ArchivedChatsView({
  workspaceId,
  chats,
  busy,
  error,
  readOnly,
  onUnarchive,
  onRetry,
}: {
  workspaceId: string;
  chats: ArchivedChat[];
  busy: boolean;
  error: string;
  readOnly: boolean;
  onUnarchive: (ids: string[]) => Promise<unknown>;
  onRetry: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation("chat");
  useChatDocumentTitle(t("archive.title"), false, false);
  const layout = useChatLayout(workspaceId, true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visible = chats.filter((chat) =>
    `${chat.title} ${chat.preview ?? ""}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const selectedIds = chats
    .filter((chat) => selected.has(chat.id))
    .map((chat) => chat.id);
  const groups = useMemo(
    () => [
      ...layout.layout.groups.map((group) => ({
        id: group.id,
        name: group.name,
      })),
      { id: "", name: t("list.ungrouped") },
    ],
    [layout.layout.groups, t],
  );
  const restore = async (ids: string[]) => {
    try {
      await onUnarchive(ids);
      setSelected((old) => new Set([...old].filter((id) => !ids.includes(id))));
    } catch {
      /* The controller presents the error. */
    }
  };
  return (
    <section className="fdy-chat-archived-view">
      <div className="fdy-chat-archive-toolbar">
        <h2>{t("archive.title")}</h2>
        <Button variant="ghost" onClick={() => navigateToChat("")}>
          {t("list.title")}
        </Button>
      </div>
      <TextInput
        aria-label={t("archive.filter")}
        placeholder={t("archive.filter")}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <div className="fdy-chat-archive-toolbar">
        <Button
          disabled={busy || readOnly || !selectedIds.length}
          onClick={() => void restore(selectedIds)}
        >
          {t("archive.unarchiveCount", { count: selectedIds.length })}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void onRetry()}>
          {t("archive.recheck")}
        </Button>
      </div>
      {error ? (
        <Alert tone="error" title={t("archive.failed")}>
          {error}
        </Alert>
      ) : null}
      {!chats.length ? (
        <EmptyState
          role="status"
          title={t("archive.emptyTitle")}
          body={t("archive.empty")}
        />
      ) : !visible.length ? (
        <EmptyState
          role="status"
          title={t("list.noMatches")}
          body={t("archive.filterHint")}
        />
      ) : null}
      {groups.map((group) => {
        const rows = visible.filter((chat) => {
          const placed =
            layout.layout.positions.find(
              (position) => position.chatId === chat.id,
            )?.groupId ?? "";
          return (
            (groups.some((item) => item.id === placed) ? placed : "") ===
            group.id
          );
        });
        return rows.length ? (
          <section key={group.id} aria-label={group.name}>
            <h3>{group.name}</h3>
            {rows.map((chat) => (
              <div className="fdy-chat-archived-row" key={chat.id}>
                <Checkbox
                  aria-label={t("archive.select", { title: chat.title })}
                  checked={selected.has(chat.id)}
                  disabled={readOnly || busy}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelected((old) => {
                      const next = new Set(old);
                      if (checked) next.add(chat.id);
                      else next.delete(chat.id);
                      return next;
                    });
                  }}
                />
                <div className="fdy-chat-archived-copy">
                  <Button
                    className="fdy-chat-archived-title"
                    variant="link"
                    onClick={() => navigateToChat(chat.id)}
                  >
                    {chat.title}
                  </Button>
                  <span>
                    {chat.provider} ·{" "}
                    {chat.nativeArchive?.[0]?.deviceLabel ||
                      chat.deviceId ||
                      chat.nativeArchive?.[0]?.deviceId ||
                      ""}{" "}
                    ·{" "}
                    {chat.archivedAt
                      ? new Date(chat.archivedAt).toLocaleString(
                          i18n.resolvedLanguage || i18n.language,
                        )
                      : ""}{" "}
                    ·{" "}
                    {t("archive.byActor", {
                      actor:
                        chat.archivedByLabel ||
                        (chat.archivedBySession
                          ? t("archive.agentActor")
                          : t("archive.unknownActor")),
                    })}
                  </span>
                  {chat.nativeArchive?.map((target) => (
                    <span key={`${target.deviceId}:${target.nativeSessionId}`}>
                      {target.provider}: {t(`archive.native.${target.state}`)}
                    </span>
                  ))}
                </div>
                <Button
                  size="sm"
                  disabled={busy || readOnly}
                  onClick={() => void restore([chat.id])}
                >
                  {t("archive.unarchive")}
                </Button>
              </div>
            ))}
          </section>
        ) : null;
      })}
    </section>
  );
}
