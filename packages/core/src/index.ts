export { createStage, webgpuAvailable } from "./stage";
export type { Stage, StageOptions, StageStats, EngineChoice } from "./stage";
export { DEFAULTS, resolveEffect, merge } from "./config";
export type {
  Effect, EffectInput, DeepPartial, SceneConfig, SceneSource, Placement, Breakpoint, DriverConfig,
  MotionConfig, SteerParams, FieldConfig, LookConfig, InteractionConfig,
} from "./config";
export type { EngineKind } from "./engines/types";
export type { DotCloud, DotterOptions } from "@particulator/dotter";
