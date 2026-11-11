import { useTranslation } from "react-i18next";
import { FieldHint, TextInput } from "../../components/ui/field";
import {
  emptyModelPriceDraft,
  invalidModelPrices,
  type ModelPriceDraft,
  type ProfileDraft,
} from "./profile-draft";

const fields = [
  "inputPerMillion",
  "cacheReadPerMillion",
  "cacheWritePerMillion",
  "outputPerMillion",
] as const;

export function ModelPriceFields({
  busy,
  draft,
  onChange,
}: {
  busy: boolean;
  draft: ProfileDraft;
  onChange: (values: Record<string, ModelPriceDraft>) => void;
}) {
  const { t } = useTranslation("profiles");
  const invalid = new Set(invalidModelPrices(draft));
  if (draft.models.length === 0)
    return <FieldHint>{t("modelPrices.noModels")}</FieldHint>;

  const update = (
    model: string,
    field: (typeof fields)[number],
    value: string,
  ) => {
    const current = draft.modelPrices[model] ?? emptyModelPriceDraft();
    onChange({
      ...draft.modelPrices,
      [model]: { ...current, [field]: value },
    });
  };

  return (
    <div className="grid gap-2.5">
      <FieldHint className="mt-0">{t("modelPrices.intro")}</FieldHint>
      <div
        aria-hidden="true"
        className="hidden grid-cols-[minmax(140px,1.3fr)_repeat(4,minmax(88px,1fr))] gap-2 px-1 text-2xs font-semibold text-ink-faint min-[760px]:grid"
      >
        <span />
        {fields.map((field) => (
          <span key={field}>{t(`modelPrices.fields.${field}`)}</span>
        ))}
      </div>
      <ul className="grid">
        {draft.models.map((model) => {
          const price = draft.modelPrices[model] ?? emptyModelPriceDraft();
          const rowInvalid = invalid.has(model);
          return (
            <li
              className="grid grid-cols-2 gap-x-2 gap-y-2 border-t border-line-soft py-2.5 min-[760px]:grid-cols-[minmax(140px,1.3fr)_repeat(4,minmax(88px,1fr))] min-[760px]:items-center"
              key={model}
            >
              <span className="col-span-2 min-w-0 self-center font-mono text-xs text-ink wrap-anywhere min-[760px]:col-span-1">
                {model}
              </span>
              {fields.map((field) => (
                <label className="grid min-w-0 gap-1" key={field}>
                  <span className="text-2xs text-ink-faint min-[760px]:sr-only">
                    {t(`modelPrices.fields.${field}`)}
                  </span>
                  <TextInput
                    aria-invalid={rowInvalid || undefined}
                    aria-label={t(`modelPrices.inputLabels.${field}`, {
                      model,
                    })}
                    disabled={busy}
                    inputMode="decimal"
                    min="0"
                    onChange={(event) =>
                      update(model, field, event.currentTarget.value)
                    }
                    placeholder={t("modelPrices.placeholder")}
                    step="any"
                    tone="boxed"
                    type="number"
                    value={price[field]}
                  />
                </label>
              ))}
              {rowInvalid ? (
                <FieldHint
                  as="small"
                  className="col-span-full mt-0"
                  role="alert"
                  tone="error"
                >
                  {t("modelPrices.invalid")}
                </FieldHint>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
