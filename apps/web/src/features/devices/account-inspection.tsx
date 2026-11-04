import { AccountUsageWindows } from "../../components/account-usage-windows";
import { useEffect, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { Button } from "../../components/ui/button";
import { SelectMenu } from "../../components/ui/select-menu";
import { Badge } from "../../components/ui/badge";
import { AccountFieldLabel } from "./account-field";
import {
  checkInspection,
  resetInspectionSource,
  selectInspectionSource,
  useDeviceAccountInspection,
} from "./account-inspection-store";

export function AccountInspection({
  deviceId,
  identity,
  runtime,
  online,
  onChecked,
}: {
  deviceId: string;
  identity?: string;
  runtime: "claude" | "codex";
  online: boolean;
  /** A new read also refreshed the device's agents on the server. */
  onChecked: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const snapshot = useDeviceAccountInspection(
    deviceId,
    runtime,
    online,
    identity,
  );
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
    checkInspection(deviceId, runtime, viewedSource || undefined, identity);
  }
  function backToExecution() {
    if (!executionSource) return;
    if (snapshot.results[executionSource])
      resetInspectionSource(deviceId, runtime, executionSource, identity);
    else selectInspectionSource(deviceId, runtime, executionSource, identity);
  }

  const checkLabel = t("inspection.checkAccount");
  const busyLabel = t("inspection.checking");

  return (
    <section
      className="fdy-account-inspection grid min-w-0 content-start gap-3.5 [&_p]:text-xs [&_p]:leading-[1.7] [&_p]:text-ink-muted"
      aria-label={t("inspection.sectionLabel", { runtime })}
      aria-busy={loading}
    >
      <header className="flex flex-wrap items-center justify-between gap-2.5 text-xs">
        <strong>{t("inspection.title")}</strong>
        <Button
          size="sm"
          variant="secondary"
          busy={loading}
          disabled={!online}
          aria-label={checkLabel}
          onClick={checkCurrent}
        >
          {loading ? busyLabel : checkLabel}
        </Button>
      </header>
      {!online ? <p role="status">{t("inspection.offline")}</p> : null}
      {error ? (
        <div
          className="flex flex-wrap items-center gap-2.5 text-xs text-warning-text"
          role="alert"
        >
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={checkCurrent}>
            {t("inspection.retry")}
          </Button>
        </div>
      ) : null}
      {result ? (
        <div className="grid gap-3.5" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <Badge tone={result.status === "verified" ? "online" : "neutral"}>
              {t(`inspection.status.${result.status}`)}
            </Badge>
            <span>
              {result.accountLabel}
              {result.plan ? ` · ${result.plan}` : ""}
            </span>
          </div>
          <p>{result.message}</p>
          <AccountUsageWindows windows={result.usage} />
          {sourceMissing ? (
            <p role="status">
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
            <AccountFieldLabel>
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
                  selectInspectionSource(deviceId, runtime, source, identity)
                }
              />
            </AccountFieldLabel>
          ) : null}
          {sourceMissing && executionSource ? (
            <Button
              size="sm"
              variant="secondary"
              className="justify-self-start"
              onClick={backToExecution}
            >
              {t("inspection.backToFoundry")}
            </Button>
          ) : null}
          <small className="text-2xs leading-[1.7] text-ink-muted wrap-anywhere">
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
        <div className="grid gap-3.5" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
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
              className="justify-self-start"
              onClick={backToExecution}
            >
              {t("inspection.backToFoundry")}
            </Button>
          ) : null}
          <small className="text-2xs leading-[1.7] text-ink-muted wrap-anywhere">
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
