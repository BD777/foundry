import type { AccountUser } from "../../api-types";
import { Badge } from "../../components/ui/badge";
import { FieldHint, TextInput } from "../../components/ui/field";
import { Spinner } from "../../components/ui/loading";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { SelectMenu } from "../../components/ui/select-menu";
import type { UsageStatsDimension } from "@bd777/foundry-protocol";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  type UsageDimension,
  type UsageGranularity,
  type UsageRangePreset,
  usageDimensions,
} from "./usage-model";

const rangeOptions: UsageRangePreset[] = [
  "today",
  "sevenDays",
  "thirtyDays",
  "custom",
];

interface UsageFiltersProps {
  customFrom: string;
  customInvalid: boolean;
  customTo: string;
  dimension: UsageDimension;
  granularity: UsageGranularity;
  hasData: boolean;
  hourlyAvailable: boolean;
  isAdmin: boolean;
  loading: boolean;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  onDimensionChange: (value: UsageDimension) => void;
  onGranularityChange: (value: UsageGranularity) => void;
  onRangeChange: (value: UsageRangePreset) => void;
  onUserChange: (value: string) => void;
  rangePreset: UsageRangePreset;
  selectedUserId: string;
  today: string;
  users: readonly AccountUser[];
  usersLoading: boolean;
}

export function UsageFilters({
  customFrom,
  customInvalid,
  customTo,
  dimension,
  granularity,
  hasData,
  hourlyAvailable,
  isAdmin,
  loading,
  onCustomFromChange,
  onCustomToChange,
  onDimensionChange,
  onGranularityChange,
  onRangeChange,
  onUserChange,
  rangePreset,
  selectedUserId,
  today,
  users,
  usersLoading,
}: UsageFiltersProps) {
  const { t } = useTranslation(["usage", "common"]);
  const scopeLabel = isAdmin ? t("page.adminScope") : t("page.selfScope");

  return (
    <section
      aria-label={t("filters.label")}
      className="grid min-w-0 gap-3 border-y border-line py-3.5"
    >
      <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-3">
        <FilterField label={t("filters.range")}>
          <SegmentedControl
            aria-label={t("filters.range")}
            onValueChange={onRangeChange}
            options={rangeOptions.map((value) => ({
              label: t(`ranges.${value}`),
              value,
            }))}
            size="sm"
            value={rangePreset}
          />
        </FilterField>
        <FilterField label={t("filters.granularity")}>
          <SegmentedControl
            aria-label={t("filters.granularity")}
            onValueChange={onGranularityChange}
            options={[
              {
                disabled: !hourlyAvailable,
                label: t("granularities.hour"),
                value: "hour",
              },
              { label: t("granularities.day"), value: "day" },
            ]}
            size="sm"
            value={granularity}
          />
        </FilterField>
        <FilterField label={t("filters.groupBy")}>
          <SelectMenu
            ariaLabel={t("filters.groupBy")}
            className="min-w-36"
            onChange={(value) =>
              onDimensionChange(value as UsageStatsDimension)
            }
            options={usageDimensions.map((value) => ({
              label: t(`dimensions.${value}`),
              value,
            }))}
            value={dimension}
          />
        </FilterField>
        {isAdmin ? (
          <FilterField label={t("filters.user")}>
            <SelectMenu
              ariaLabel={t("filters.user")}
              className="min-w-44"
              disabled={usersLoading}
              onChange={onUserChange}
              options={[
                { label: t("filters.allUsers"), value: "" },
                ...users.map((user) => ({
                  detail: user.disabledAt ? user.username : undefined,
                  label: user.displayName,
                  meta: user.username,
                  value: user.id,
                })),
              ]}
              placeholder={
                usersLoading ? t("filters.loadingUsers") : t("filters.user")
              }
              value={selectedUserId}
            />
          </FilterField>
        ) : (
          <Badge className="mb-1" tone="neutral">
            {scopeLabel}
          </Badge>
        )}
        {loading ? (
          <Spinner
            className="mb-1.5"
            label={hasData ? t("states.refreshing") : t("states.loading")}
          />
        ) : null}
      </div>

      {rangePreset === "custom" ? (
        <div className="flex min-w-0 flex-wrap items-end gap-3">
          <DateField
            label={t("filters.customFrom")}
            max={customTo}
            onChange={onCustomFromChange}
            value={customFrom}
          />
          <DateField
            label={t("filters.customTo")}
            max={today}
            onChange={onCustomToChange}
            value={customTo}
          />
        </div>
      ) : null}
      {customInvalid ? (
        <FieldHint tone="error">{t("filters.customInvalid")}</FieldHint>
      ) : null}
      {!hourlyAvailable && rangePreset !== "custom" ? (
        <FieldHint>{t("filters.hourRange")}</FieldHint>
      ) : null}
      {isAdmin ? (
        <Badge className="w-max" tone="neutral">
          {scopeLabel}
        </Badge>
      ) : null}
    </section>
  );
}

function FilterField({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="text-2xs leading-none font-semibold text-ink-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

function DateField({
  label,
  max,
  onChange,
  value,
}: {
  label: string;
  max: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="grid min-w-36 gap-1.5">
      <span className="text-2xs leading-none font-semibold text-ink-muted">
        {label}
      </span>
      <TextInput
        max={max}
        onChange={(event) => onChange(event.currentTarget.value)}
        tone="boxed"
        type="date"
        value={value}
      />
    </label>
  );
}
