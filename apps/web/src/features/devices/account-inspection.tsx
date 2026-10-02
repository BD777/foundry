import { useEffect, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { Button } from "../../components/ui/button";
import { SelectMenu } from "../../components/ui/select-menu";
import { Badge } from "../../components/ui/badge";
import {
  checkInspection,
  resetInspectionSource,
  selectInspectionSource,
  useDeviceAccountInspection,
} from "./account-inspection-store";

export function AccountInspection({
  deviceId,
  runtime,
  online,
  onChecked,
}: {
  deviceId: string;
  runtime: "claude" | "codex";
  online: boolean;
  /** A new read also refreshed the device's agents on the server. */
  onChecked: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const snapshot = useDeviceAccountInspection(deviceId, runtime, online);
  // Reads restored from an earlier mount are not new; only later ones are.
  const seenChecks = useRef(snapshot.accepted);
  useEffect(() => {
    if (snapshot.accepted === seenChecks.current) return;
    seenChecks.current = snapshot.accepted;
    void onChecked();
  }, [onChecked, snapshot.accepted]);

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
      ? t("inspection.recheckLocal")
      : t("inspection.checkLocal")
    : t("inspection.checkAccount");
  const busyLabel = claude
    ? t("inspection.checkingLocal")
    : t("inspection.checking");

  return (
    <section
      className="fdy-account-inspection"
      aria-label={t("inspection.sectionLabel", { runtime })}
      aria-busy={loading}
    >
      <header className="fdy-account-check-header">
        <strong>{t("inspection.title")}</strong>
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
      {!online ? <p role="status">{t("inspection.offline")}</p> : null}
      {error ? (
        <div className="fdy-account-check-error" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={checkCurrent}>
            {t("inspection.retry")}
          </Button>
        </div>
      ) : null}
      {result ? (
        <div className="fdy-account-result" aria-live="polite">
          <div className="fdy-account-verdict">
            <Badge tone={result.status === "verified" ? "online" : "neutral"}>
              {t(`inspection.status.${result.status}`)}
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
                    ? t("inspection.windowDays", {
                        days: usage.windowMinutes / 1440,
                      })
                    : t("inspection.windowHours", {
                        hours: usage.windowMinutes / 60,
                      })
                  : t("inspection.usageWindow")}
              </span>
              <strong>
                {t("inspection.used", { percent: usage.usedPercent })}
              </strong>
              {usage.usedPercent >= 100 ? (
                <small>{t("inspection.limitReached")}</small>
              ) : null}
              <progress
                aria-label={t("inspection.usageLabel")}
                max={100}
                value={usage.usedPercent}
              />
              {usage.resetsAt ? (
                <small>
                  {t("inspection.resets", {
                    time: new Date(usage.resetsAt * 1000).toLocaleString(
                      i18n.language,
                    ),
                  })}
                </small>
              ) : null}
            </div>
          ))}
          {sourceMissing ? (
            <p className="fdy-account-source-missing" role="status">
              <Trans
                ns="profiles"
                i18nKey={
                  result.status === "unavailable"
                    ? "inspection.sourceGoneUnavailable"
                    : "inspection.sourceGoneStale"
                }
                values={{ source: viewedSource }}
                components={{ code: <code /> }}
              />
            </p>
          ) : null}
          {sources.length > 1 ? (
            <label className="fdy-profile-field">
              <span>{t("inspection.inspectAnother")}</span>
              <SelectMenu
                ariaLabel={t("inspection.inspectLabel")}
                disabled={loading}
                value={viewedSource}
                options={sources.map((source) => ({
                  value: source,
                  label: source,
                  meta:
                    source === executionSource
                      ? t("inspection.usedByFoundry")
                      : t("inspection.otherApp"),
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
              {t("inspection.backToFoundry")}
            </Button>
          ) : null}
          <small className="fdy-account-source">
            <Trans
              ns="profiles"
              i18nKey="inspection.foundryUses"
              values={{ source: executionSource }}
              components={{ code: <code /> }}
            />
            {result.source !== executionSource
              ? t("inspection.viewingOther")
              : ""}
            <br />
            {t("inspection.lastChecked", {
              time: new Date(result.checkedAt).toLocaleTimeString(
                i18n.language,
              ),
            })}
          </small>
        </div>
      ) : sourceMissing ? (
        <div className="fdy-account-fallback" aria-live="polite">
          <div className="fdy-account-verdict">
            <Badge tone="neutral">
              {t("inspection.configurationUnavailable")}
            </Badge>
          </div>
          <p role="status">
            <Trans
              ns="profiles"
              i18nKey="inspection.fallback"
              values={{ source: viewedSource }}
              components={{ code: <code /> }}
            />
          </p>
          {executionSource ? (
            <Button
              size="sm"
              variant="secondary"
              className="fdy-account-inline-action"
              onClick={backToExecution}
            >
              {t("inspection.backToFoundry")}
            </Button>
          ) : null}
          <small className="fdy-account-source">
            <Trans
              ns="profiles"
              i18nKey="inspection.foundryUses"
              values={{ source: executionSource }}
              components={{ code: <code /> }}
            />
          </small>
        </div>
      ) : online && loading ? (
        <p role="status">{t("inspection.asking")}</p>
      ) : null}
    </section>
  );
}
