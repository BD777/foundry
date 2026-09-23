import type { WorkspaceFileRead } from "@foundry/protocol";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { TerminalBlock } from "../../components/ui/terminal-block";

export function WorkspaceFilePreview({ file }: { file: WorkspaceFileRead }) {
  return (
    <Panel className="fdy-workspace-file-preview">
      <PanelHeader>
        <div>
          <h2>{file.path}</h2>
          <p>
            {file.truncated
              ? "Truncated read-only preview"
              : "Read-only workspace configuration"}
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
