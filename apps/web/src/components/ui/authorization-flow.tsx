import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ProfileAuthorization } from "@bd777/foundry-protocol";
import { Button } from "./button";
import { TextInput } from "./field";

export interface AuthorizationFlowProps {
  className?: string;
  authorization: ProfileAuthorization;
  busy?: boolean;
  onComplete: (authorizationResult: string) => void;
}

/**
 * The browser half of a native agent CLI login. The daemon on the target
 * device owns the actual `claude auth login` / `codex login --device-auth`
 * process; this only relays what the CLI printed and, for Claude, the code the
 * user pastes back. Nothing here ever holds a token.
 */
export function AuthorizationFlow({
  className,
  authorization,
  busy = false,
  onComplete,
}: AuthorizationFlowProps) {
  const { t } = useTranslation("ui");
  const [authorizationResult, setAuthorizationResult] = useState("");
  const needsPastedCode = authorization.runtime === "claude";
  const waiting = authorization.status === "waiting_for_user";

  useEffect(() => {
    setAuthorizationResult("");
  }, [authorization.id]);

  return (
    <div
      className={["fdy-authorization-flow", className]
        .filter(Boolean)
        .join(" ")}
    >
      {authorization.url ? (
        <Button asChild size="sm" variant="secondary">
          <a href={authorization.url} rel="noreferrer" target="_blank">
            <ExternalLink size={14} />
            {t("authorization.openPage")}
          </a>
        </Button>
      ) : null}
      {authorization.code ? (
        <p>
          <Trans
            ns="ui"
            i18nKey="authorization.enterCode"
            values={{ code: authorization.code }}
            components={{ code: <code /> }}
          />
        </p>
      ) : null}
      {needsPastedCode && waiting ? (
        <TextInput
          aria-label={t("authorization.resultLabel")}
          onChange={(event) =>
            setAuthorizationResult(event.currentTarget.value)
          }
          placeholder={t("authorization.resultPlaceholder")}
          value={authorizationResult}
        />
      ) : null}
      {waiting ? (
        <Button
          disabled={busy || (needsPastedCode && !authorizationResult.trim())}
          onClick={() => onComplete(authorizationResult)}
          size="sm"
          variant="primary"
        >
          {needsPastedCode
            ? t("authorization.complete")
            : t("authorization.check")}
        </Button>
      ) : null}
      {authorization.message ? (
        <p data-status={authorization.status}>{authorization.message}</p>
      ) : null}
    </div>
  );
}
