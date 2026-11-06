"use client";

import { useState } from "react";
import type { EffectInput, Stage } from "particulator";
import { ParticleStage } from "particulator/react";
import effect from "../../effect.json";
import { TuningPanel } from "./TuningPanel";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

type Props = {
  /** Fractional section index from the scroll container. */
  progress: number;
  isMobile: boolean;
};

/** Full-screen particle layer, driven by the site's own scroll container. Desktop only, like the original. */
export function ParticleCanvas({ progress, isMobile }: Props) {
  const [stage, setStage] = useState<Stage | null>(null);
  if (isMobile) return null;
  return (
    <>
      <ParticleStage
        effect={effect as EffectInput}
        baseUrl={typeof window === "undefined" ? undefined : `${window.location.origin}${BASE_PATH}/`}
        progress={progress}
        onStage={setStage}
      />
      <TuningPanel stage={stage} />
    </>
  );
}
