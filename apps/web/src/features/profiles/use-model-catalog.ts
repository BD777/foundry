import { useRef, useState } from "react";
import type { CreateAgentProfileInput } from "../../api-types";
import { mergeDiscoveredModels } from "../../components/ui/model-combobox";
import type { ProfileDraft } from "./profile-draft";

export interface UseModelCatalogOptions {
  deviceId?: string;
  draft: ProfileDraft;
  /** Asks the device for the endpoint's catalog; anything else is not ours. */
  onLoad: (profile: CreateAgentProfileInput) => Promise<unknown>;
  updateDraft: (patch: Partial<ProfileDraft>) => void;
}

export interface ModelCatalog {
  /** True only while the catalog is being fetched. */
  busy: boolean;
  load: () => Promise<void>;
  /** What the last read had to say, shown under the picker. */
  note: string;
  /** Clears the last read, so a reopened editor does not inherit it. */
  reset: () => void;
}

/**
 * Reads a profile's model catalog from its endpoint. The outcome belongs to the
 * picker rather than the page: a refused read explains itself in place, leaves
 * the form saveable, and never touches the page's error line.
 */
export function useModelCatalog({
  deviceId,
  draft,
  onLoad,
  updateDraft,
}: UseModelCatalogOptions): ModelCatalog {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const latest = useRef({ draft, deviceId, updateDraft });
  latest.current = { draft, deviceId, updateDraft };
  const generation = useRef(0);
  const source = (value: ProfileDraft, device?: string) =>
    JSON.stringify([
      device,
      value.id,
      value.runtime,
      value.baseUrl,
      value.apiKey,
    ]);

  async function load(): Promise<void> {
    if (!deviceId || busy) return;
    const request = ++generation.current;
    const requestSource = source(draft, deviceId);
    const profile: CreateAgentProfileInput = {
      apiKey: draft.apiKey.trim() || undefined,
      baseUrl: draft.baseUrl.trim() || undefined,
      configScope: "device",
      connectionType:
        draft.authMode === "official"
          ? "local_login"
          : draft.runtime === "claude"
            ? "anthropic_compatible"
            : "openai_compatible",
      deviceId,
      id: draft.id,
      label: draft.label,
      model: draft.model.trim() || undefined,
      runtime: draft.runtime,
    };
    setBusy(true);
    setNote("Asking for the catalog…");
    try {
      const result = await onLoad(profile);
      if (request !== generation.current) return;
      if (
        requestSource !== source(latest.current.draft, latest.current.deviceId)
      ) {
        setNote("Connection changed. Refresh again for its current catalog.");
        return;
      }
      if (!Array.isArray(result)) {
        throw new Error("The device did not return a model list.");
      }
      // Discovery adds to the profile's list; it never replaces entries the
      // user added by hand or moves their default.
      const models = mergeDiscoveredModels(
        latest.current.draft.models,
        result.map((option) => option.id),
      );
      latest.current.updateDraft({ models });
      setNote(
        `${result.length} model${result.length === 1 ? "" : "s"} from the endpoint.`,
      );
    } catch (cause) {
      if (request !== generation.current) return;
      setNote(
        cause instanceof Error ? cause.message : "The catalog read failed.",
      );
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }

  return {
    busy,
    load,
    note,
    reset: () => {
      generation.current++;
      setBusy(false);
      setNote("");
    },
  };
}
