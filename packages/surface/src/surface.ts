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
  dataFields: Array<{ name: string; text: string; selector: string }>;
};

export interface Surface {
  navigate(url: string, timeoutMs?: number): Promise<void>;
  observe(): Promise<SurfaceObservation>;
  click(target: ControlTarget, timeoutMs?: number): Promise<void>;
  fill(target: ControlTarget, value: string, timeoutMs?: number): Promise<void>;
  extractText(target: ControlTarget, timeoutMs?: number): Promise<string>;
  isVisible(target: ControlTarget, timeoutMs?: number): Promise<boolean>;
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
