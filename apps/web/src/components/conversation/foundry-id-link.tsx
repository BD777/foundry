import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getSessionLink } from "../../api";
import { foundryIdKind } from "../../lib/foundry-ids";
import { foundryIdHref } from "../../lib/in-app-navigation";
import { AppLink } from "../ui/app-link";

// Session titles named for hover, shared by every link to the same session.
const sessionTitles = new Map<string, Promise<string>>();

function sessionTitle(id: string): Promise<string> {
  let title = sessionTitles.get(id);
  if (!title) {
    title = getSessionLink(id).then(
      (link) => link.title.trim(),
      () => {
        sessionTitles.delete(id);
        return "";
      },
    );
    sessionTitles.set(id, title);
  }
  return title;
}

/**
 * A Foundry id named in a message, linked to its page (a chat opens in its
 * own workspace). A session's title is read only when the link is pointed
 * at or focused, never while rendering.
 */
export function FoundryIdLink({
  children,
  id,
}: {
  children: ReactNode;
  id: string;
}) {
  const { t } = useTranslation("conversation");
  const [title, setTitle] = useState<string>();
  const href = foundryIdHref(id);
  if (!href) return <>{children}</>;
  const nameSession = () => {
    if (title !== undefined || foundryIdKind(id) !== "session") return;
    setTitle("");
    void sessionTitle(id).then((named) => {
      if (named) setTitle(t("message.linkedChat", { title: named }));
    });
  };
  return (
    <AppLink
      className="fdy-foundry-id-link"
      data-foundry-id={id}
      href={href}
      onFocus={nameSession}
      onPointerEnter={nameSession}
      title={title || undefined}
    >
      {children}
    </AppLink>
  );
}
