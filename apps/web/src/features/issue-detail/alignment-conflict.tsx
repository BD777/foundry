import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";

const prefix = "alignment_conflict:";

/** The files a failed alignment left in conflict, or none for other errors. */
export function alignmentConflicts(error: string): string[] {
  const at = error.indexOf(prefix);
  return at < 0
    ? []
    : error
        .slice(at + prefix.length)
        .split(";")
        .map((file) => file.trim())
        .filter(Boolean);
}

/**
 * Aligning with the Workspace conflicted. The Issue's execution resolves the
 * conflict in the candidate; the result is then checked and accepted again.
 */
export function AlignmentConflict({
  files,
  busy,
  onResolve,
}: {
  files: string[];
  busy: boolean;
  onResolve: () => void;
}) {
  const { t } = useTranslation("issueDetail");
  return (
    <Alert tone="warning" title={t("alignment.title")}>
      <p>{t("alignment.body")}</p>
      <ul>
        {files.map((file) => (
          <li key={file}>
            <code>{file}</code>
          </li>
        ))}
      </ul>
      <Button disabled={busy} onClick={onResolve}>
        {t("alignment.resolve")}
      </Button>
      <p>{t("alignment.after")}</p>
    </Alert>
  );
}
