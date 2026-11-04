import { Alert } from "../../components/ui/alert";
import { ToastFeedback } from "../../components/ui/toast";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import {
  suggestedDeviceLabels,
  type DeviceFact,
  type DeviceLabel,
  type DevicePlacement,
  type DeviceProjection,
} from "@bd777/foundry-protocol";
import { listDevicePlacements, setDeviceLabels } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { HelpHint } from "../../components/ui/help-hint";
import { SectionHeader } from "../../components/ui/page-header";
import { cn } from "../../lib/cn";
import { Skeleton } from "../../components/ui/loading";
import { DeviceSection, deviceActionsClass } from "./device-section";

const columnClass = "grid min-w-0 content-start gap-2.5";
const columnHeadingClass = "m-0 text-sm font-semibold text-ink";
const mutedClass = "m-0 text-sm leading-[1.6] text-ink-muted";

interface Row {
  id: number;
  key: string;
  value: string;
}

const keyPattern = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function normalize(row: Row): DeviceLabel {
  const key = row.key.trim().toLowerCase();
  const value = row.value.trim().replace(/\s+/g, " ").toLowerCase();
  return value ? { key, value } : { key };
}

/** The rows a save sends: blank rows left out. */
function labelsOf(rows: Row[]): DeviceLabel[] {
  return rows.filter((row) => row.key.trim()).map(normalize);
}

function valid(rows: Row[]): boolean {
  return labelsOf(rows).every(
    (label) =>
      keyPattern.test(label.key) &&
      (label.value ?? "").length <= 60 &&
      !(label.value ?? "").includes(":"),
  );
}

function labelText(label: DeviceLabel): string {
  return label.value ? `${label.key}: ${label.value}` : label.key;
}

function sameLabel(a: DeviceLabel, b: DeviceLabel): boolean {
  return a.key === b.key && (a.value ?? "") === (b.value ?? "");
}

let nextRowId = 0;
function rowsOf(labels: DeviceLabel[]): Row[] {
  return labels.map((label) => ({
    id: nextRowId++,
    key: label.key,
    value: label.value ?? "",
  }));
}

/**
 * What a computer has, for the assistant's placement of new projects:
 * the owner's notes (labels, editable) beside what Foundry detected
 * (read-only), and how often the computer is on.
 */
export function DeviceLabels({ device }: { device: DeviceProjection }) {
  const { t } = useTranslation("devices");
  const [placement, setPlacement] = useState<DevicePlacement>();
  const [rows, setRows] = useState<Row[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">(
    "success",
  );

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    listDevicePlacements()
      .then((placements) => {
        if (cancelled) return;
        const found = placements.find(
          (item) => item.deviceId === device.id,
        ) ?? {
          deviceId: device.id,
          labels: [],
          facts: [],
        };
        setPlacement(found);
        setRows(rowsOf(found.labels));
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [device.id, attempt]);

  if (loadError)
    return (
      <DeviceSection aria-live="polite">
        <SectionHeader title={t("labels.title")} />
        <Alert tone="error" size="compact" title={t("labels.loadFailed")} />
        <Button size="sm" onClick={() => setAttempt((count) => count + 1)}>
          {t("labels.retry")}
        </Button>
      </DeviceSection>
    );
  if (!placement)
    return (
      <DeviceSection>
        <SectionHeader title={t("labels.title")} />
        <Skeleton label={t("labels.loading")} rows={2} />
      </DeviceSection>
    );

  const current = labelsOf(rows);
  const dirty =
    current.length !== placement.labels.length ||
    current.some((label, index) => !sameLabel(label, placement.labels[index]!));
  const ok = valid(rows);
  const suggestions = suggestedDeviceLabels.filter(
    (suggestion) => !current.some((label) => sameLabel(label, suggestion)),
  );

  function update(id: number, patch: Partial<Row>) {
    setMessage("");
    setMessageTone("success");
    setRows((items) =>
      items.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  async function save() {
    setBusy(true);
    setMessage("");
    setMessageTone("success");
    try {
      const saved = await setDeviceLabels(device.id, labelsOf(rows));
      setPlacement(saved);
      setRows(rowsOf(saved.labels));
      setMessage(t("labels.saved"));
    } catch (cause) {
      setMessageTone("error");
      setMessage(
        cause instanceof Error && cause.message
          ? cause.message
          : t("labels.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <DeviceSection aria-labelledby="fdy-device-labels-heading">
      <SectionHeader
        title={t("labels.title")}
        titleId="fdy-device-labels-heading"
        description={t("labels.intro")}
        help={
          <HelpHint label={t("labels.helpLabel")}>{t("labels.help")}</HelpHint>
        }
      />
      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-x-8 gap-y-5">
        <div
          className={columnClass}
          role="group"
          aria-labelledby="fdy-device-labels-yours"
        >
          <h3 className={columnHeadingClass} id="fdy-device-labels-yours">
            {t("labels.yours")}
          </h3>
          {rows.length ? (
            <ul className="m-0 grid gap-2 p-0">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2"
                >
                  <TextInput
                    tone="boxed"
                    aria-label={t("labels.keyLabel")}
                    placeholder={t("labels.keyPlaceholder")}
                    value={row.key}
                    onChange={(event) =>
                      update(row.id, { key: event.currentTarget.value })
                    }
                  />
                  <TextInput
                    tone="boxed"
                    aria-label={t("labels.valueLabel")}
                    placeholder={t("labels.valuePlaceholder")}
                    value={row.value}
                    onChange={(event) =>
                      update(row.id, { value: event.currentTarget.value })
                    }
                  />
                  <Button
                    aria-label={t("labels.remove", {
                      label: labelText(normalize(row)) || "…",
                    })}
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      setMessage("");
                      setMessageTone("success");
                      setRows((items) =>
                        items.filter((item) => item.id !== row.id),
                      );
                    }}
                  >
                    <X aria-hidden="true" size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={mutedClass}>{t("labels.empty")}</p>
          )}
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setRows((items) => [
                  ...items,
                  { id: nextRowId++, key: "", value: "" },
                ])
              }
            >
              <Plus aria-hidden="true" size={14} />
              {t("labels.add")}
            </Button>
          </div>
          {suggestions.length ? (
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label={t("labels.suggested")}
            >
              <span className={cn(mutedClass, "mr-1")}>
                {t("labels.suggested")}
              </span>
              {suggestions.map((suggestion) => (
                <Button
                  key={labelText(suggestion)}
                  aria-label={t("labels.suggest", {
                    label: labelText(suggestion),
                  })}
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setMessage("");
                    setMessageTone("success");
                    setRows((items) => [...items, ...rowsOf([suggestion])]);
                  }}
                >
                  {labelText(suggestion)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        <div
          className={columnClass}
          role="group"
          aria-labelledby="fdy-device-labels-detected"
        >
          <h3 className={columnHeadingClass} id="fdy-device-labels-detected">
            {t("labels.detected")}
          </h3>
          <DetectedFacts placement={placement} />
        </div>
      </div>
      <div className={deviceActionsClass}>
        <Button
          disabled={busy || !dirty || !ok}
          size="sm"
          variant="primary"
          onClick={save}
        >
          {t("labels.save")}
        </Button>
        {!ok ? (
          <Alert tone="error" size="compact" title={t("labels.invalid")} />
        ) : null}
        {message ? <ToastFeedback tone={messageTone} title={message} /> : null}
      </div>
    </DeviceSection>
  );
}

function DetectedFacts({ placement }: { placement: DevicePlacement }) {
  const { t } = useTranslation("devices");
  const share = placement.onlineShare;
  function factText(fact: DeviceFact): string {
    const detail = fact.detail || fact.value || "";
    switch (fact.key) {
      case "os":
        return t("labels.facts.os", { detail });
      case "arch":
        return t("labels.facts.arch", { value: fact.value ?? "" });
      case "toolchain":
        return t("labels.facts.toolchain", { detail });
      case "gpu":
        return t("labels.facts.gpu", { detail });
      case "reaches":
        return t("labels.facts.reaches", { detail });
      case "always-on":
        return t("labels.facts.always-on");
    }
    return labelText(fact);
  }
  const percent = share ? Math.round(share.ratio * 100) : 0;
  return (
    <>
      {placement.facts.length ? (
        <ul className="m-0 grid gap-2 p-0">
          {placement.facts.map((fact) => (
            <li
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
              key={`${fact.key}:${fact.value ?? ""}`}
            >
              <Badge dot={false} tone="slate">
                {factText(fact)}
              </Badge>
              <small className="text-xs wrap-anywhere text-ink-muted">
                {labelText(fact)}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className={mutedClass}>{t("labels.nothingDetected")}</p>
      )}
      <p className={mutedClass}>
        {!share
          ? t("labels.onlineNone")
          : share.observedHours >= 48
            ? t("labels.online", {
                percent,
                days: Math.round(share.observedHours / 24),
              })
            : t("labels.onlineHours", {
                percent,
                hours: Math.max(1, Math.round(share.observedHours)),
              })}
      </p>
    </>
  );
}
