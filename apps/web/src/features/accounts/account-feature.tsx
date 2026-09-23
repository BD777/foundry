import { useState, type FormEvent } from "react";
import { changeMyPassword, updateMyDisplayName } from "../../api";
import type { AccountUser } from "../../api-types";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { PageSurface } from "../../components/ui/page-surface";
import { Panel } from "../../components/ui/panel";
import { roleLabel } from "./account-format";

export type AccountFeatureEvent =
  | { type: "account.updated"; user: AccountUser }
  | { type: "account.signOutRequested" };

export interface AccountFeatureProps {
  user: AccountUser;
  onEvent: (event: AccountFeatureEvent) => void;
}

type Feedback = { tone: "success" | "error"; text: string } | undefined;

export function AccountFeature({ user, onEvent }: AccountFeatureProps) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameFeedback, setNameFeedback] = useState<Feedback>();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState<Feedback>();

  async function saveName(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setNameBusy(true);
    setNameFeedback(undefined);
    try {
      const updated = await updateMyDisplayName(displayName);
      onEvent({ type: "account.updated", user: updated });
      setNameFeedback({ tone: "success", text: "Display name saved." });
    } catch (reason) {
      setNameFeedback({ tone: "error", text: messageOf(reason) });
    } finally {
      setNameBusy(false);
    }
  }

  async function savePassword(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setPasswordBusy(true);
    setPasswordFeedback(undefined);
    try {
      await changeMyPassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordFeedback({
        tone: "success",
        text: "Password changed. Other devices were signed out.",
      });
    } catch (reason) {
      setPasswordFeedback({ tone: "error", text: messageOf(reason) });
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <PageSurface variant="accounts">
      <div className="fdy-account-intro">
        <strong>Account</strong>
        <p>
          Signed in as <b>{user.username}</b>{" "}
          <Badge tone={user.role === "admin" ? "brass" : "neutral"}>
            {roleLabel(user.role)}
          </Badge>
        </p>
      </div>

      <Panel className="fdy-account-section">
        <form
          className="fdy-account-form"
          onSubmit={(event) => void saveName(event)}
        >
          <label className="fdy-auth-field">
            <span>Display name</span>
            <TextInput
              maxLength={64}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              tone="boxed"
              value={displayName}
            />
            <small>
              Shown on Issues, contracts and Accept decisions you make.
            </small>
          </label>
          {nameFeedback ? (
            <Alert tone={nameFeedback.tone} title={nameFeedback.text} />
          ) : null}
          <div className="fdy-account-actions">
            <Button
              disabled={nameBusy || displayName.trim() === user.displayName}
              type="submit"
              variant="primary"
            >
              {nameBusy ? "Saving…" : "Save name"}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel className="fdy-account-section">
        <form
          className="fdy-account-form"
          onSubmit={(event) => void savePassword(event)}
        >
          <label className="fdy-auth-field">
            <span>Current password</span>
            <TextInput
              autoComplete="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              tone="boxed"
              type="password"
              value={currentPassword}
            />
          </label>
          <label className="fdy-auth-field">
            <span>New password</span>
            <TextInput
              autoComplete="new-password"
              minLength={10}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              tone="boxed"
              type="password"
              value={newPassword}
            />
            <small>
              At least 10 characters. Changing it signs out your other devices.
            </small>
          </label>
          {passwordFeedback ? (
            <Alert tone={passwordFeedback.tone} title={passwordFeedback.text} />
          ) : null}
          <div className="fdy-account-actions">
            <Button disabled={passwordBusy} type="submit" variant="primary">
              {passwordBusy ? "Changing…" : "Change password"}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel className="fdy-account-section fdy-account-signout">
        <div>
          <strong>Sign out</strong>
          <p>Ends the session in this browser.</p>
        </div>
        <Button onClick={() => onEvent({ type: "account.signOutRequested" })}>
          Sign out
        </Button>
      </Panel>
    </PageSurface>
  );
}

function messageOf(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : "The Foundry server did not answer. Try again.";
}
