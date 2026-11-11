import { useTranslation } from "react-i18next";
import {
  RecordsBody,
  RecordsCell,
  RecordsHead,
  RecordsHeaderCell,
  RecordsRow,
  RecordsTable,
} from "../../components/ui/records-table";
import { formatTimeToFirstToken } from "../../lib/format";
import type { UsageBreakdownRow, UsageDimension } from "./usage-model";
import {
  currency,
  decimalNumber,
  dimensionLabel,
  wholeNumber,
} from "./usage-format";

export function UsageBreakdownTable({
  deviceLabels,
  dimension,
  dimensionName,
  locale,
  rows,
  truncated,
  userLabels,
  workspaceLabels,
}: {
  deviceLabels: ReadonlyMap<string, string>;
  dimension: UsageDimension;
  dimensionName: string;
  locale: string;
  rows: readonly UsageBreakdownRow[];
  truncated: boolean;
  userLabels: ReadonlyMap<string, string>;
  workspaceLabels: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation("usage");
  const label = (key: string) =>
    dimensionLabel(key, dimension, {
      deviceLabels,
      t,
      userLabels,
      workspaceLabels,
    });
  return (
    <div className="grid min-w-0 gap-2">
      <RecordsTable scrollLabel={t("table.scrollLabel")}>
        <caption className="sr-only">
          {t("table.description", { dimension: dimensionName })}
        </caption>
        <RecordsHead>
          <RecordsRow>
            <RecordsHeaderCell>{t("table.dimension")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.turns")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.requests")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.inputTokens")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.outputTokens")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.cost")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.medianSpeed")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.ttftP50")}</RecordsHeaderCell>
          </RecordsRow>
        </RecordsHead>
        <RecordsBody>
          {rows.map((row) => (
            <RecordsRow key={row.key}>
              <RecordsCell>
                <span className="font-medium text-ink">{label(row.key)}</span>
              </RecordsCell>
              <RecordsCell>{wholeNumber(row.turns, locale)}</RecordsCell>
              <RecordsCell>{wholeNumber(row.requests, locale)}</RecordsCell>
              <RecordsCell>{wholeNumber(row.inputTokens, locale)}</RecordsCell>
              <RecordsCell>{wholeNumber(row.outputTokens, locale)}</RecordsCell>
              <RecordsCell>{currency(row.costUsd, locale)}</RecordsCell>
              <RecordsCell>
                {row.medianTokensPerSecond === undefined
                  ? "—"
                  : decimalNumber(row.medianTokensPerSecond, locale, 1)}
              </RecordsCell>
              <RecordsCell>
                {row.ttftP50Ms === undefined
                  ? "—"
                  : (formatTimeToFirstToken(row.ttftP50Ms) ?? "—")}
              </RecordsCell>
            </RecordsRow>
          ))}
        </RecordsBody>
      </RecordsTable>
      {truncated ? (
        <p className="m-0 text-xs text-ink-muted">
          {t("table.truncated", { limit: 500 })}
        </p>
      ) : null}
    </div>
  );
}
