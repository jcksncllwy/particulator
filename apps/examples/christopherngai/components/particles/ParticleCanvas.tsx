"use client";

import { useState } from "react";
import type { EffectInput, Stage } from "particulator";
import { ParticleStage } from "particulator/react";
import effect from "../../effect.json";
import { TuningPanel } from "./TuningPanel";
import { Studio } from "./Studio";

// In dev the studio replaces the tuning panel; add ?studio=0 to get the panel back.
const DEV_STUDIO =
  process.env.NODE_ENV === "development" &&
  (typeof window === "undefined" || new URLSearchParams(window.location.search).get("studio") !== "0");

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
      {DEV_STUDIO ? stage && <Studio stage={stage} /> : <TuningPanel stage={stage} />}
    </>
  );
}
