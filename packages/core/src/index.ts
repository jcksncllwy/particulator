export { createStage, webgpuAvailable } from "./stage";
export type { Stage, StageOptions, StageStats, EngineChoice, SceneInfo } from "./stage";
export type { Transition } from "./drivers";
export { activeBreakpoint, placeScene } from "./placement";
export { DEFAULTS, resolveEffect, merge, sparseEffect, parseColor } from "./config";
export type {
  Effect, EffectInput, DeepPartial, SceneConfig, SceneSource, Placement, Breakpoint, DriverConfig,
  MotionConfig, SteerParams, FieldConfig, LookConfig, InteractionConfig, WallsConfig, CrowdConfig,
} from "./config";
export type { EngineKind } from "./engines/types";
export type { DotCloud, DotterOptions } from "@particulator/dotter";
