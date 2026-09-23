import { useCallback, useEffect, useRef, useState } from "react";
import type { ProfileDefinition } from "@foundry/protocol";
import {
  defaultProfileDraft,
  draftForRuntime,
  draftFromProfile,
  newProfileKey,
  type ProfileDraft,
  type ProfileRuntime,
} from "./profile-draft";

export interface ProfilesState {
  /** The draft the editor renders: either an unsaved new profile or a copy. */
  draft: ProfileDraft;
  isNew: boolean;
  selectedProfile?: ProfileDefinition;
  selectionKey: string;
  /** Arms adoption of the next unseen profile id as the current selection. */
  expectCreatedProfile: () => void;
  acceptSavedProfile: (profile: ProfileDefinition) => void;
  selectProfile: (profileId: string) => void;
  startNewProfile: () => void;
  updateDraft: (patch: Partial<ProfileDraft>) => void;
  updateRuntime: (runtime: ProfileRuntime) => void;
}

interface DraftSlot {
  key: string;
  value: ProfileDraft;
}

function draftForSelection(
  slot: DraftSlot | undefined,
  selectionKey: string,
  profiles: ProfileDefinition[],
): ProfileDraft {
  if (slot?.key === selectionKey) {
    return slot.value;
  }
  if (selectionKey === newProfileKey) {
    return defaultProfileDraft();
  }

  return draftFromProfile(
    profiles.find((profile) => profile.id === selectionKey),
  );
}

/**
 * Owns which profile the editor is pointed at and the edits made to it.
 *
 * Drafts are keyed by selection so a changed selection re-derives from the
 * stored profile without an effect, which keeps a slow save from resurrecting
 * a stale form. Only list membership changes — a deletion, or the id the
 * server minted for a freshly saved profile — need reconciliation.
 */
export function useProfilesState(profiles: ProfileDefinition[]): ProfilesState {
  const [selectionKey, setSelectionKey] = useState<string>(newProfileKey);
  const [slot, setSlot] = useState<DraftSlot | undefined>(undefined);
  const knownIdsRef = useRef<string[]>([]);
  const adoptCreatedRef = useRef(false);
  const selectedRef = useRef(false);

  useEffect(() => {
    const ids = profiles.map((profile) => profile.id);
    const knownIds = knownIdsRef.current;
    const [firstId] = ids;
    knownIdsRef.current = ids;

    if (selectionKey === newProfileKey) {
      const createdId = ids.find((id) => !knownIds.includes(id));
      if (adoptCreatedRef.current && createdId) {
        adoptCreatedRef.current = false;
        selectedRef.current = true;
        setSelectionKey(createdId);
        setSlot(undefined);
        return;
      }
      if (!selectedRef.current && firstId) {
        selectedRef.current = true;
        setSelectionKey(firstId);
        setSlot(undefined);
      }
      return;
    }

    if (!ids.includes(selectionKey)) {
      setSelectionKey(firstId ?? newProfileKey);
      setSlot(undefined);
    }
  }, [profiles, selectionKey]);

  const updateDraft = useCallback(
    (patch: Partial<ProfileDraft>) => {
      setSlot((current) => ({
        key: selectionKey,
        value: {
          ...draftForSelection(current, selectionKey, profiles),
          ...patch,
        },
      }));
    },
    [profiles, selectionKey],
  );

  const updateRuntime = useCallback(
    (runtime: ProfileRuntime) => {
      setSlot((current) => ({
        key: selectionKey,
        value: draftForRuntime(
          draftForSelection(current, selectionKey, profiles),
          runtime,
        ),
      }));
    },
    [profiles, selectionKey],
  );

  const selectProfile = useCallback((profileId: string) => {
    selectedRef.current = true;
    adoptCreatedRef.current = false;
    setSelectionKey(profileId);
    setSlot(undefined);
  }, []);

  const startNewProfile = useCallback(() => {
    selectedRef.current = true;
    adoptCreatedRef.current = false;
    setSelectionKey(newProfileKey);
    setSlot({ key: newProfileKey, value: defaultProfileDraft() });
  }, []);

  const expectCreatedProfile = useCallback(() => {
    adoptCreatedRef.current = true;
  }, []);

  return {
    acceptSavedProfile: (profile) => {
      selectedRef.current = true;
      adoptCreatedRef.current = false;
      setSelectionKey(profile.id);
      setSlot({ key: profile.id, value: draftFromProfile(profile) });
    },
    draft: draftForSelection(slot, selectionKey, profiles),
    expectCreatedProfile,
    isNew: selectionKey === newProfileKey,
    selectProfile,
    selectedProfile:
      selectionKey === newProfileKey
        ? undefined
        : profiles.find((profile) => profile.id === selectionKey),
    selectionKey,
    startNewProfile,
    updateDraft,
    updateRuntime,
  };
}
