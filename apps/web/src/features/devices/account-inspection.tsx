import type { NativeAccountInspection } from "@foundry/protocol";
import { Button } from "../../components/ui/button";
import { SelectMenu } from "../../components/ui/select-menu";
import { Badge } from "../../components/ui/badge";
import {
  checkInspection,
  resetInspectionSource,
  selectInspectionSource,
  useDeviceAccountInspection,
} from "./account-inspection-store";

const STATUS_BADGE: Record<NativeAccountInspection["status"], string> = {
  verified: "Verified online",
  local_login: "Local login · unverified online",
  not_signed_in: "No login in this configuration",
  unavailable: "Check unavailable",
};

export function AccountInspection({
  deviceId,
  runtime,
  online,
}: {
  deviceId: string;
  runtime: "claude" | "codex";
  online: boolean;
}) {
  const snapshot = useDeviceAccountInspection(deviceId, runtime, online);

  // Identity for the configuration IN VIEW comes from that configuration's own
  // read (a response echoes the source set as it existed when checked), with
  // the store's last-accepted identity as fallback only — never from sorting
  // cached reads by checkedAt, which ties across same-second responses.
  const viewedSource = snapshot.selectedSource || snapshot.executionSource;
  const viewedResult = viewedSource
    ? snapshot.results[viewedSource]
    : undefined;
  const sources = viewedResult?.sources ?? snapshot.sources;
  const executionSource =
    viewedResult?.executionSource ?? snapshot.executionSource;
  const result = viewedResult;
  const sourceMissing =
    !!viewedSource && sources.length > 0 && !sources.includes(viewedSource);
  const errorKey = snapshot.selectedSource ?? "";
  const error = snapshot.errors[errorKey] ?? snapshot.errors[viewedSource];
  const loadingTarget = snapshot.loadingSource;
  const loading =
    loadingTarget !== undefined &&
    (loadingTarget === viewedSource ||
      (!snapshot.selectedSource && loadingTarget === ""));

  function checkCurrent() {
    checkInspection(deviceId, runtime, viewedSource || undefined);
  }
  function backToExecution() {
    if (!executionSource) return;
    if (snapshot.results[executionSource])
      resetInspectionSource(deviceId, runtime, executionSource);
    else selectInspectionSource(deviceId, runtime, executionSource);
  }

  const claude = runtime === "claude";
  const checkLabel = claude
    ? result
      ? "Re-check local login"
      : "Check local login"
    : "Check account & usage";
  const busyLabel = claude ? "Checking local login…" : "Checking…";

  return (
    <section
      className="fdy-account-inspection"
      aria-label={`${runtime} account verification`}
      aria-busy={loading}
    >
      <header className="fdy-account-check-header">
        <strong>Account status</strong>
        <Button
          size="sm"
          variant="secondary"
          disabled={!online || loading}
          aria-label={checkLabel}
          onClick={checkCurrent}
        >
          {loading ? busyLabel : checkLabel}
        </Button>
      </header>
      {!online ? (
        <p role="status">
          Connect this device to check its native account configuration.
        </p>
      ) : null}
      {error ? (
        <div className="fdy-account-check-error" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={checkCurrent}>
            Retry
          </Button>
        </div>
      ) : null}
      {result ? (
        <div className="fdy-account-result" aria-live="polite">
          <div className="fdy-account-verdict">
            <Badge tone={result.status === "verified" ? "online" : "neutral"}>
              {STATUS_BADGE[result.status]}
            </Badge>
            <span>
              {result.accountLabel}
              {result.plan ? ` · ${result.plan}` : ""}
            </span>
          </div>
          <p>{result.message}</p>
          {result.usage.map((usage, index) => (
            <div className="fdy-account-usage" key={index}>
              <span>
                {usage.windowMinutes
                  ? usage.windowMinutes >= 1440
                    ? `${usage.windowMinutes / 1440}-day window`
                    : `${usage.windowMinutes / 60}h window`
                  : "Usage window"}
              </span>
              <strong>{usage.usedPercent}% used</strong>
              {usage.usedPercent >= 100 ? (
                <small>
                  Limit reached · Login is valid, but this window has no
                  remaining allowance.
                </small>
              ) : null}
              <progress
                aria-label="Account usage"
                max={100}
                value={usage.usedPercent}
              />
              {usage.resetsAt ? (
                <small>
                  Resets {new Date(usage.resetsAt * 1000).toLocaleString()}
                </small>
              ) : null}
            </div>
          ))}
          {sourceMissing ? (
            <p className="fdy-account-source-missing" role="status">
              <code>{viewedSource}</code> is no longer present on this device.
              {result.status === "unavailable"
                ? " It cannot be checked from here."
                : " The read below is the last stored result, not a fresh online check."}
            </p>
          ) : null}
          {sources.length > 1 ? (
            <label className="fdy-profile-field">
              <span>Inspect another local configuration</span>
              <SelectMenu
                ariaLabel="Account configuration to inspect"
                disabled={loading}
                value={viewedSource}
                options={sources.map((source) => ({
                  value: source,
                  label: source,
                  meta:
                    source === executionSource
                      ? "Used by Foundry"
                      : "Other app · inspection only",
                }))}
                onChange={(source) =>
                  selectInspectionSource(deviceId, runtime, source)
                }
              />
            </label>
          ) : null}
          {sourceMissing && executionSource ? (
            <Button
              size="sm"
              variant="secondary"
              className="fdy-account-inline-action"
              onClick={backToExecution}
            >
              Back to Foundry’s configuration
            </Button>
          ) : null}
          <small className="fdy-account-source">
            Foundry uses: <code>{executionSource}</code>
            {result.source !== executionSource
              ? " · Viewing another configuration does not change the execution account."
              : ""}
            <br />
            Last checked {new Date(result.checkedAt).toLocaleTimeString()} ·
            Credentials stay on this device.
          </small>
        </div>
      ) : sourceMissing ? (
        <div className="fdy-account-fallback" aria-live="polite">
          <div className="fdy-account-verdict">
            <Badge tone="neutral">Configuration unavailable</Badge>
          </div>
          <p role="status">
            <code>{viewedSource}</code> is no longer present on this device. The
            configuration Foundry actually uses is still shown below.
          </p>
          {executionSource ? (
            <Button
              size="sm"
              variant="secondary"
              className="fdy-account-inline-action"
              onClick={backToExecution}
            >
              Back to Foundry’s configuration
            </Button>
          ) : null}
          <small className="fdy-account-source">
            Foundry uses: <code>{executionSource}</code>
          </small>
        </div>
      ) : online && loading ? (
        <p role="status">Asking the native agent; no model request is sent.</p>
      ) : null}
    </section>
  );
}
