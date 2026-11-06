"use client";

import { useEffect, useRef, useState } from "react";
import type { EffectInput } from "./config";
import { createStage, type Stage, type StageOptions } from "./stage";

export type ParticleStageProps = Omit<StageOptions, "effect" | "container"> & {
  effect: EffectInput;
  /** Scroll-style progress for the "api" driver; omit to let the effect's driver run. */
  progress?: number;
  /** Receives the Stage once created (for goTo, update, stats...). */
  onStage?: (stage: Stage | null) => void;
};

/**
 * Mounts a full-viewport particle stage. The effect is read once on mount;
 * use stage.update() (via onStage) for live edits.
 */
export function ParticleStage({ effect, progress, onStage, ...opts }: ParticleStageProps) {
  const [stage, setStage] = useState<Stage | null>(null);
  const initial = useRef({ effect, opts });

  useEffect(() => {
    const s = createStage({ ...initial.current.opts, effect: initial.current.effect });
    setStage(s);
    onStage?.(s);
    return () => { s.destroy(); setStage(null); onStage?.(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (stage && progress !== undefined) stage.progress = progress;
  }, [stage, progress]);

  return null;
}
