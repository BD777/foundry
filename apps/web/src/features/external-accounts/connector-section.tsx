import type { ReactNode } from "react";
import { Panel } from "../../components/ui/panel";
import { SectionHeader } from "../../components/ui/page-header";

/**
 * One connector's card: its name, what it does here and its actions in one
 * header, where its credentials are kept, then its rows.
 */
export function ConnectorSection({
  name,
  description,
  actions,
  holding,
  children,
}: {
  name: string;
  description?: ReactNode;
  actions?: ReactNode;
  holding?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Panel aria-label={name} className="fdy-xacc-section" role="region">
      <SectionHeader actions={actions} description={description} title={name} />
      {holding}
      {children}
    </Panel>
  );
}
