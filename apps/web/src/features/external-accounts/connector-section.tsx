import type { ReactNode } from "react";
import { SectionPanel } from "../../components/ui/section-panel";
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
    <SectionPanel aria-label={name} role="region">
      <SectionHeader actions={actions} description={description} title={name} />
      {holding}
      {children}
    </SectionPanel>
  );
}
