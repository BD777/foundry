import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProfileAuthorization } from "@foundry/protocol";
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
            Open authorization page
          </a>
        </Button>
      ) : null}
      {authorization.code ? (
        <p>
          Enter code <code>{authorization.code}</code> on the authorization
          page.
        </p>
      ) : null}
      {needsPastedCode && waiting ? (
        <TextInput
          aria-label="Authorization code or callback URL"
          onChange={(event) =>
            setAuthorizationResult(event.currentTarget.value)
          }
          placeholder="Paste the authorization code or callback URL"
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
          {needsPastedCode ? "Complete authorization" : "Check authorization"}
        </Button>
      ) : null}
      {authorization.message ? (
        <p data-status={authorization.status}>{authorization.message}</p>
      ) : null}
    </div>
  );
}
