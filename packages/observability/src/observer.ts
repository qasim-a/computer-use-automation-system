import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Surface } from "../../surface/src/index.js";

export type RunEvent = {
  timestamp: string;
  runId: string;
  phase: "discovery" | "replay" | "handoff";
  type: string;
  stepId?: string;
  details?: unknown;
};

export interface RunObserver {
  record(event: Omit<RunEvent, "timestamp">): Promise<void>;
  captureFailure(surface: Surface, runId: string, stepId?: string): Promise<string | undefined>;
}

export class NoopRunObserver implements RunObserver {
  async record(_event: Omit<RunEvent, "timestamp">): Promise<void> {}
  async captureFailure(_surface: Surface, _runId: string, _stepId?: string): Promise<undefined> { return undefined; }
}

export class MemoryRunObserver implements RunObserver {
  readonly events: RunEvent[] = [];

  constructor(private readonly redactor = new Redactor()) {}

  async record(event: Omit<RunEvent, "timestamp">): Promise<void> {
    this.events.push(this.redactor.redact({ timestamp: new Date().toISOString(), ...event }) as RunEvent);
  }

  async captureFailure(_surface: Surface, _runId: string, _stepId?: string): Promise<undefined> { return undefined; }
}

export class FileRunObserver implements RunObserver {
  private readonly logPath: string;
  private initialized = false;

  constructor(
    private readonly directory: string,
    private readonly redactor = new Redactor(),
    filename = "events.jsonl"
  ) {
    this.logPath = resolve(directory, filename);
  }

  async record(event: Omit<RunEvent, "timestamp">): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true });
    const safe = this.redactor.redact({ timestamp: new Date().toISOString(), ...event });
    const line = `${JSON.stringify(safe)}\n`;
    if (this.initialized) await appendFile(this.logPath, line, "utf8");
    else {
      await writeFile(this.logPath, line, "utf8");
      this.initialized = true;
    }
  }

  async captureFailure(surface: Surface, runId: string, stepId?: string): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const safeStep = (stepId ?? "unknown_step").replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = resolve(this.directory, `${runId}-${safeStep}-failure.png`);
    await surface.screenshot(path, { maskSensitive: true });
    return path;
  }
}

export class Redactor {
  private readonly values: string[];
  private readonly sensitiveKey = /(^|_)(api_?key|apiKey|authorization|cookie|password|secret|token|member_?id|memberId)($|_)/i;

  constructor(values: readonly unknown[] = []) {
    this.values = values.map(String).filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  }

  redact(value: unknown, key?: string): unknown {
    if (key && this.sensitiveKey.test(key)) return "[REDACTED]";
    if (typeof value === "string") {
      return this.values.reduce((safe, sensitive) => safe.replaceAll(sensitive, "[REDACTED]"), value);
    }
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, this.redact(child, childKey)]));
    }
    return value;
  }
}
