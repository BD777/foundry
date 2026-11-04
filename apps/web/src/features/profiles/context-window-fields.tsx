import { RefreshCw } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import {
  parseContextWindow,
  resolveContextWindow,
} from "@bd777/foundry-protocol";
import { formatTokenCount } from "../../components/conversation/turn-usage";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { FieldHint, TextInput } from "../../components/ui/field";

export interface ContextWindowFieldsProps {
  busy: boolean;
  /** The person's window per model as typed; blank is automatic. */
  values: Record<string, string>;
  models: string[];
  /** Windows the endpoint's catalog reported; undefined until read. */
  catalogWindows?: Record<string, number>;
  /** Reads the catalog's windows; absent when no device can ask. */
  onReadCatalog?: () => void;
  onChange: (values: Record<string, string>) => void;
}

/**
 * One row per model: the window it runs with when left blank (endpoint
 * catalog, official model, or the 1M default) and the person's own.
 */
export function ContextWindowFields({
  busy,
  values,
  models,
  catalogWindows,
  onReadCatalog,
  onChange,
}: ContextWindowFieldsProps) {
  const { t } = useTranslation("profiles");
  const baseId = useId();
  if (models.length === 0)
    return <FieldHint>{t("contextWindows.noModels")}</FieldHint>;
  return (
    <div className="grid gap-2.5">
      <FieldHint className="mt-0">{t("contextWindows.intro")}</FieldHint>
      {catalogWindows === undefined ? (
        <Alert
          size="compact"
          title={
            onReadCatalog
              ? t("contextWindows.catalogUnread")
              : t("contextWindows.catalogUnavailable")
          }
          actions={
            onReadCatalog ? (
              <Button
                disabled={busy}
                onClick={onReadCatalog}
                size="sm"
                variant="secondary"
              >
                <RefreshCw size={14} />
                {t("contextWindows.readCatalog")}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <ul className="grid">
        {models.map((model, index) => {
          const automatic = resolveContextWindow(model, {
            endpoint: catalogWindows?.[model],
          });
          const text = values[model] ?? "";
          const invalid =
            !!text.trim() && parseContextWindow(text) === undefined;
          const inputId = `${baseId}-${index}`;
          const hintId = `${inputId}-hint`;
          return (
            <li
              className="fdy-context-window-row grid grid-cols-[minmax(0,1fr)_minmax(120px,160px)] items-center gap-x-3 gap-y-0.5 border-t border-line-soft py-2 max-[560px]:grid-cols-[minmax(0,1fr)]"
              key={model}
            >
              <label
                className="min-w-0 font-mono text-xs text-ink wrap-anywhere"
                htmlFor={inputId}
              >
                {model}
              </label>
              <FieldHint as="span" id={hintId}>
                {t("contextWindows.automatic", {
                  tokens: formatTokenCount(automatic.tokens),
                  source: t(`contextWindows.source.${automatic.source}`),
                })}
              </FieldHint>
              <TextInput
                aria-describedby={hintId}
                aria-invalid={invalid || undefined}
                aria-label={t("contextWindows.inputLabel", { model })}
                autoComplete="off"
                className="col-start-2 row-span-2 row-start-1 max-[560px]:col-start-1 max-[560px]:row-auto"
                id={inputId}
                onChange={(event) =>
                  onChange({ ...values, [model]: event.currentTarget.value })
                }
                placeholder={t("contextWindows.placeholder")}
                tone="boxed"
                value={text}
              />
              {invalid ? (
                <FieldHint
                  as="small"
                  tone="error"
                  role="alert"
                  className="fdy-context-window-error col-span-full text-2xs"
                >
                  {t("contextWindows.invalid")}
                </FieldHint>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
