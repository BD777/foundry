import { useEffect, useState, type FormEvent } from "react";
import { acceptInvite, getInvite, login, setupFirstOwner } from "../../api";
import type { AuthState, InvitePreview } from "../../api-types";
import { Alert } from "../../components/ui/alert";
import {
  FoundryShell,
  type FoundryThemeMode,
} from "../../components/ui/app-shell";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { Panel } from "../../components/ui/panel";
import { roleLabel } from "./account-format";
import { workspaceRoleLabel } from "../../lib/workspace-access";

export type AuthScreenKind = "login" | "setup" | "invite";

export interface AuthScreenProps {
  kind: AuthScreenKind;
  inviteToken?: string;
  theme: FoundryThemeMode;
  onAuthenticated: (state: AuthState) => void;
}

const copy: Record<
  AuthScreenKind,
  { title: string; body: string; submit: string }
> = {
  login: {
    title: "Sign in to Foundry",
    body: "Use the account an admin created or invited you to.",
    submit: "Sign in",
  },
  setup: {
    title: "Create the admin account",
    body: "No account exists yet. Enter the one-time setup code printed in the Foundry server log, then choose your login.",
    submit: "Create admin account",
  },
  invite: {
    title: "Join Foundry",
    body: "Choose a login to accept this invite.",
    submit: "Create account",
  },
};

export function AuthScreen({
  kind,
  inviteToken,
  theme,
  onAuthenticated,
}: AuthScreenProps) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<InvitePreview | undefined>();
  const [inviteError, setInviteError] = useState("");

  useEffect(() => {
    if (kind !== "invite" || !inviteToken) return;
    let cancelled = false;
    getInvite(inviteToken)
      .then((preview) => {
        if (!cancelled) setInvite(preview);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setInviteError(errorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [kind, inviteToken]);

  const creating = kind !== "login";
  const text = copy[kind];

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const account = { username, displayName, password };
      const state =
        kind === "setup"
          ? await setupFirstOwner({ ...account, setupCode })
          : kind === "invite"
            ? await acceptInvite(inviteToken ?? "", account)
            : await login(username, password);
      onAuthenticated(state);
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  }

  const inviteUnavailable =
    kind === "invite" && (!!inviteError || !inviteToken);

  return (
    <FoundryShell theme={theme}>
      <div className="fdy-auth-screen">
        <Panel className="fdy-auth-card">
          <header className="fdy-auth-header">
            <img
              alt=""
              height={40}
              src={`${import.meta.env.BASE_URL}foundry-icon.png`}
              width={40}
            />
            <h1>{text.title}</h1>
            <p>
              {kind === "invite" && invite
                ? `You are invited as ${roleLabel(invite.role).toLowerCase()}${invite.workspaceName && invite.workspaceRole ? ` and will join ${invite.workspaceName} as ${workspaceRoleLabel(invite.workspaceRole)}` : ""}. ${text.body}`
                : text.body}
            </p>
          </header>
          {inviteUnavailable ? (
            <Alert
              details={inviteError || undefined}
              tone="error"
              title="This invite cannot be used"
            >
              It may have expired, been revoked or already been used. Ask an
              admin for a new link.
            </Alert>
          ) : (
            <form
              className="fdy-auth-form"
              onSubmit={(event) => void submit(event)}
            >
              {kind === "setup" ? (
                <label className="fdy-auth-field">
                  <span>Setup code</span>
                  <TextInput
                    autoComplete="one-time-code"
                    autoFocus
                    onChange={(event) => setSetupCode(event.target.value)}
                    placeholder="XXXX-XXXX-XXXX"
                    required
                    tone="boxed"
                    value={setupCode}
                  />
                </label>
              ) : null}
              <label className="fdy-auth-field">
                <span>Username</span>
                <TextInput
                  autoComplete="username"
                  autoFocus={kind !== "setup"}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  tone="boxed"
                  value={username}
                />
                {creating ? (
                  <small>3–32 letters, digits, “.”, “_” or “-”.</small>
                ) : null}
              </label>
              {creating ? (
                <label className="fdy-auth-field">
                  <span>Display name (optional)</span>
                  <TextInput
                    autoComplete="name"
                    maxLength={64}
                    onChange={(event) => setDisplayName(event.target.value)}
                    tone="boxed"
                    value={displayName}
                  />
                </label>
              ) : null}
              <label className="fdy-auth-field">
                <span>Password</span>
                <TextInput
                  autoComplete={creating ? "new-password" : "current-password"}
                  minLength={creating ? 10 : undefined}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  tone="boxed"
                  type="password"
                  value={password}
                />
                {creating ? <small>At least 10 characters.</small> : null}
              </label>
              {error ? (
                <Alert tone="error" title="Could not continue">
                  {error}
                </Alert>
              ) : null}
              <Button disabled={busy} type="submit" variant="primary">
                {busy ? "Please wait…" : text.submit}
              </Button>
            </form>
          )}
        </Panel>
      </div>
    </FoundryShell>
  );
}

function errorText(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : "The Foundry server did not answer. Try again.";
}
