import { useEffect, useState } from "react";
import type {
  Material,
  MaterialSelector,
  ReferenceMedia,
} from "@foundry/protocol";
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
  const [opened, setOpened] = useState(false);
  const [material, setMaterial] = useState<Material>();
  const [text, setText] = useState<string>();
  const [image, setImage] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!opened) return;
    setError("");
    setText(undefined);
    setImage(undefined);
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
          第 {selector.start}–{selector.end} 行
        </p>
      ) : null}
      {image ? (
        <img
          src={image}
          alt={label ?? material?.name ?? "Sealed evidence"}
          className="fdy-evidence-preview-image"
        />
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
          下载原始材料
        </Button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <details>
        <summary>材料技术信息</summary>
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
  return (
    <>
      {media.map((ref, i) => (
        <EvidencePreview
          key={`${ref.materialId}-${i}`}
          issueId={issueId}
          materialId={ref.materialId}
          selector={ref.selector}
          label={`参考${{ target: "目标", example: "示例", counterexample: "反例", context: "背景" }[ref.role]}：${ref.caption}`}
        />
      ))}
    </>
  );
}
