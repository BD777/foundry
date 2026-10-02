import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Material,
  MaterialSelector,
  ReferenceMedia,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import {
  getMaterial,
  readPreviewMaterial,
  downloadMaterial,
} from "./evidence-api";
import "./evidence-preview.css";

export function EvidencePreview({
  issueId,
  materialId,
  selector,
  label,
}: {
  issueId: string;
  materialId: string;
  selector?: MaterialSelector;
  label?: string;
}) {
  const { t } = useTranslation("issueDetail");
  const [opened, setOpened] = useState(false);
  const [material, setMaterial] = useState<Material>();
  const [text, setText] = useState<string>();
  const [image, setImage] = useState<string>();
  const [pdf, setPdf] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!opened) return;
    setError("");
    setText(undefined);
    setImage(undefined);
    setPdf(undefined);
    let disposed = false;
    let url: string | undefined;
    void (async () => {
      const m = await getMaterial(issueId, materialId);
      if (disposed) return;
      setMaterial(m);
      const blob = await readPreviewMaterial(issueId, m);
      if (disposed) return;
      if (m.mimeType.startsWith("image/")) {
        url = URL.createObjectURL(blob);
        setImage(url);
      } else if (m.mimeType === "application/pdf") {
        // The browser's own PDF viewer, on bytes already checked against the
        // sealed digest; the protected URL itself never reaches the frame.
        url = URL.createObjectURL(blob);
        setPdf(url);
      } else {
        const content = await blob.text();
        if (disposed) return;
        setText(
          selector?.kind === "text_lines"
            ? content
                .split("\n")
                .slice(selector.start - 1, selector.end)
                .map((line, i) => `${selector.start + i}: ${line}`)
                .join("\n")
            : content,
        );
      }
    })().catch((e) => {
      if (!disposed) setError(String(e));
    });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [opened, issueId, materialId, selector]);
  return (
    <details onToggle={(e) => setOpened(e.currentTarget.open)}>
      <summary>{label ?? material?.name ?? materialId}</summary>
      {selector?.kind === "text_lines" ? (
        <p>
          {t("preview.lines", { start: selector.start, end: selector.end })}
        </p>
      ) : null}
      {image ? (
        <img
          src={image}
          alt={label ?? material?.name ?? t("preview.sealedAlt")}
          className="fdy-evidence-preview-image"
        />
      ) : null}
      {pdf ? (
        <div className="fdy-evidence-preview-pdf">
          <iframe
            className="fdy-evidence-preview-pdf-frame"
            src={pdf}
            title={t("preview.pdfTitle", {
              name: label ?? material?.name ?? materialId,
            })}
          />
          <Button
            variant="secondary"
            onClick={() => window.open(pdf, "_blank", "noopener")}
          >
            {t("preview.openPdf")}
          </Button>
        </div>
      ) : null}
      {/* React text rendering deliberately never executes Markdown/HTML/SVG. */}
      {text !== undefined ? (
        <pre className="fdy-evidence-preview-text">{text}</pre>
      ) : null}
      {material ? (
        <Button
          variant="ghost"
          onClick={() =>
            void downloadMaterial(issueId, material).catch((e) =>
              setError(String(e)),
            )
          }
        >
          {t("preview.download")}
        </Button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <details>
        <summary>{t("preview.technical")}</summary>
        <code>{materialId}</code>
        {selector ? <pre>{JSON.stringify(selector)}</pre> : null}
      </details>
    </details>
  );
}

export function ReferencePreviews({
  issueId,
  media,
}: {
  issueId: string;
  media: ReferenceMedia[];
}) {
  const { t } = useTranslation("issueDetail");
  return (
    <>
      {media.map((ref, i) => (
        <EvidencePreview
          key={`${ref.materialId}-${i}`}
          issueId={issueId}
          materialId={ref.materialId}
          selector={ref.selector}
          label={t("preview.reference", {
            role: t(`preview.role.${ref.role}`),
            caption: ref.caption,
          })}
        />
      ))}
    </>
  );
}
