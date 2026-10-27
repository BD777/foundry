import { RefreshCw } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import {
  parseContextWindow,
  resolveContextWindow,
} from "@bd777/foundry-protocol";
import { formatTokenCount } from "../../components/conversation/turn-usage";
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
    return (
      <p className="fdy-context-windows-note">{t("contextWindows.noModels")}</p>
    );
  return (
    <div className="fdy-context-windows">
      <p className="fdy-context-windows-note">{t("contextWindows.intro")}</p>
      {catalogWindows === undefined ? (
        <div className="fdy-context-windows-catalog">
          <span>
            {onReadCatalog
              ? t("contextWindows.catalogUnread")
              : t("contextWindows.catalogUnavailable")}
          </span>
          {onReadCatalog ? (
            <Button
              disabled={busy}
              onClick={onReadCatalog}
              size="sm"
              variant="ghost"
            >
              <RefreshCw size={14} />
              {t("contextWindows.readCatalog")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ul className="fdy-context-windows-list">
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
            <li className="fdy-context-window-row" key={model}>
              <label className="fdy-context-window-model" htmlFor={inputId}>
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
                className="fdy-context-window-input"
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
                  className="fdy-context-window-error"
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
