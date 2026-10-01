import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { Panel, SectionLabel } from "../../components/ui/panel";
import { InfoRow } from "../../components/ui/info-row";
import { SelectMenu } from "../../components/ui/select-menu";
import {
  environmentLabel,
  repositoryState,
  type EnvironmentRepository,
} from "./environment-model";

const PAGE_SIZE = 20;
export function RepositoryList({
  repositories,
  environmentStatus,
}: {
  repositories: EnvironmentRepository[];
  environmentStatus: string;
}) {
  const { t } = useTranslation("issueDetail");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const filtered = useMemo(
    () =>
      repositories.filter((repo) => {
        const state = repositoryState(repo, environmentStatus);
        return (
          repo.path.toLowerCase().includes(query.trim().toLowerCase()) &&
          (filter === "all" ||
            (filter === "unavailable"
              ? state.unavailable
              : state.candidate === "ready"))
        );
      }),
    [repositories, environmentStatus, query, filter],
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1),
  );
  const start = currentPage * PAGE_SIZE;
  return (
    <section
      className="fdy-environment-repositories"
      aria-label={t("repositories.label")}
    >
      <SectionLabel>{t("repositories.title")}</SectionLabel>
      <TextInput
        aria-label={t("repositories.search")}
        placeholder={t("repositories.searchPlaceholder")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setPage(0);
        }}
      />
      <SelectMenu
        ariaLabel={t("repositories.filter")}
        value={filter}
        onChange={(value) => {
          setFilter(value);
          setPage(0);
        }}
        options={[
          { value: "all", label: t("repositories.all") },
          { value: "unavailable", label: t("repositories.unavailable") },
          { value: "prepared", label: t("repositories.prepared") },
        ]}
      />
      <p>
        {filtered.length
          ? t("repositories.range", {
              from: start + 1,
              to: Math.min(start + PAGE_SIZE, filtered.length),
              total: filtered.length,
            })
          : t("repositories.none")}
      </p>
      {filtered.slice(start, start + PAGE_SIZE).map((repo) => {
        const state = repositoryState(repo, environmentStatus);
        return (
          <Panel
            variant="flat"
            className="fdy-issue-execution-panel"
            key={repo.path}
          >
            <code className="fdy-repository-path">{repo.path}</code>
            <InfoRow
              label={t("repositories.sourceAvailability")}
              density="compact"
              variant="keyValue"
            >
              <Badge tone={state.unavailable ? "warn" : "neutral"}>
                {environmentLabel(state.availability)}
              </Badge>
            </InfoRow>
            <InfoRow
              label={t("repositories.candidate")}
              density="compact"
              variant="keyValue"
            >
              {environmentLabel(state.candidate)}
            </InfoRow>
            {repo.kind ? (
              <InfoRow
                label={t("repositories.type")}
                density="compact"
                variant="keyValue"
              >
                {repo.kind}
              </InfoRow>
            ) : null}
            {repo.error ? <p>{repo.error}</p> : null}
          </Panel>
        );
      })}
      <div className="fdy-environment-pagination">
        <Button
          size="sm"
          variant="secondary"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          {t("repositories.previous")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={start + PAGE_SIZE >= filtered.length}
          onClick={() => setPage(currentPage + 1)}
        >
          {t("repositories.next")}
        </Button>
      </div>
    </section>
  );
}
