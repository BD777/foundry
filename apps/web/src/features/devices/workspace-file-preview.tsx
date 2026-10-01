import type { WorkspaceFileRead } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { TerminalBlock } from "../../components/ui/terminal-block";

export function WorkspaceFilePreview({ file }: { file: WorkspaceFileRead }) {
  const { t } = useTranslation("workspaces");
  return (
    <Panel className="fdy-workspace-file-preview">
      <PanelHeader>
        <div>
          <h2>{file.path}</h2>
          <p>
            {file.truncated
              ? t("filePreview.truncated")
              : t("filePreview.readOnly")}
          </p>
        </div>
      </PanelHeader>
      <TerminalBlock
        lines={file.content.split("\n").map((line, index) => ({
          id: `${file.path}_${index}`,
          value: line || " ",
        }))}
      />
    </Panel>
  );
}
