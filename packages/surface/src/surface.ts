import type { ControlTarget } from "../../contracts/src/index.js";

export type ObservedControl = {
  tag: string;
  role: string | null;
  name: string;
  type: string | null;
};

export type SurfaceObservation = {
  url: string;
  title: string;
  visibleText: string;
  controls: ObservedControl[];
};

export interface Surface {
  navigate(url: string): Promise<void>;
  observe(): Promise<SurfaceObservation>;
  click(target: ControlTarget): Promise<void>;
  fill(target: ControlTarget, value: string): Promise<void>;
  extractText(target: ControlTarget): Promise<string>;
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}

export class TargetResolutionError extends Error {
  constructor(
    message: string,
    readonly target: ControlTarget,
    readonly attempts: Array<{ strategy: string; value: string; matches: number }>
  ) {
    super(message);
    this.name = "TargetResolutionError";
  }
}
