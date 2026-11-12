import { useEffect, useState } from "react";
import type { ModelGuideResolution } from "@bd777/foundry-protocol";
import { resolveModelGuides, type ModelGuideTarget } from "../../api";

export function guideTargetKey(target: ModelGuideTarget): string {
  return [
    target.providerKind,
    target.providerId,
    target.runtime,
    target.model,
  ].join("\u0000");
}

/**
 * What guide each provider model has, in one batch read. Models without a
 * guide resolve with a suggested id; a failed read leaves everything unknown.
 */
export function useModelGuideLookup(targets: ModelGuideTarget[]): {
  loaded: boolean;
  resolutionOf: (target: ModelGuideTarget) => ModelGuideResolution | undefined;
} {
  const unique = [
    ...new Map(targets.map((target) => [guideTargetKey(target), target])),
  ].map(([, target]) => target);
  const key = JSON.stringify(unique);
  const [resolved, setResolved] = useState<{
    key: string;
    byTarget: Map<string, ModelGuideResolution>;
  }>();
  useEffect(() => {
    const wanted = JSON.parse(key) as ModelGuideTarget[];
    if (!wanted.length) return;
    let active = true;
    resolveModelGuides(wanted).then(
      (result) => {
        if (!active) return;
        setResolved({
          key,
          byTarget: new Map(
            wanted.map((target, index) => [
              guideTargetKey(target),
              result.resolutions[index]!,
            ]),
          ),
        });
      },
      () => {
        if (active) setResolved({ key, byTarget: new Map() });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);
  const current = resolved?.key === key ? resolved.byTarget : undefined;
  return {
    loaded: current !== undefined || unique.length === 0,
    resolutionOf: (target) => current?.get(guideTargetKey(target)),
  };
}
