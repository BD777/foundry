import { useState } from "react";
import { createDevicePairingToken, workerServerURL } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Panel } from "../../components/ui/panel";
import { TerminalBlock } from "../../components/ui/terminal-block";

function expiryLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * Issues a one-time pairing token and shows the command that pairs a worker
 * on another machine. The token is shown once; only its hash is stored.
 */
export function AddDevicePanel({ onClose }: { onClose: () => void }) {
  const [pairing, setPairing] = useState<{
    token: string;
    expiresAt: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const command = pairing
    ? `pnpm --filter @foundry/worker foundry-worker -- setup --server ${workerServerURL()} --workspace /absolute/path/to/workspace --token ${pairing.token}`
    : "";

  async function issue(): Promise<void> {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      setPairing(await createDevicePairingToken());
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "The Foundry server did not answer. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Panel className="fdy-add-device">
      <div className="fdy-add-device-head">
        <div>
          <strong>Add a device</strong>
          <p>
            Run the command on the machine that should execute work, from a
            Foundry checkout. The device will belong to your account.
          </p>
        </div>
        <Button onClick={onClose} size="sm" variant="ghost">
          Close
        </Button>
      </div>
      {pairing ? (
        <>
          <TerminalBlock
            lines={[{ id: "setup", prompt: "$", value: command }]}
          />
          <p className="fdy-add-device-note">
            Replace the workspace path. The token works once and expires at{" "}
            {expiryLabel(pairing.expiresAt)}.
          </p>
          <div className="fdy-add-device-actions">
            <Button onClick={() => void copy()}>
              {copied ? "Copied" : "Copy command"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => void issue()}
              variant="ghost"
            >
              New token
            </Button>
          </div>
        </>
      ) : (
        <div className="fdy-add-device-actions">
          <Button
            disabled={busy}
            onClick={() => void issue()}
            variant="primary"
          >
            {busy ? "Creating…" : "Create pairing command"}
          </Button>
        </div>
      )}
      {error ? (
        <Alert tone="error" title="Could not create a pairing token">
          {error}
        </Alert>
      ) : null}
    </Panel>
  );
}
