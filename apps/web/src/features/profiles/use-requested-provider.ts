import { useEffect, useRef } from "react";
import type { ProfileDefinition } from "@bd777/foundry-protocol";
import { readPageQuery, replacePageQuery } from "../../lib/page-query";

/**
 * A link to one provider (?provider=<id>, e.g. from a device's promoted
 * provider) opens its editor once the list has it. The URL is read once.
 */
export function useRequestedProvider(
  connections: ProfileDefinition[],
  openProvider: (profileId: string) => void,
) {
  const requested = useRef(readPageQuery("provider"));
  useEffect(() => {
    const profileId = requested.current;
    if (!profileId || !connections.some((row) => row.id === profileId)) return;
    requested.current = "";
    replacePageQuery({ provider: "" });
    openProvider(profileId);
  });
}
