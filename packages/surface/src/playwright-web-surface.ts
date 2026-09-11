import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type { ControlTarget } from "../../contracts/src/index.js";
import { TargetResolutionError, type Surface, type SurfaceObservation } from "./surface.js";

export type WebSurfaceOptions = {
  headless?: boolean;
  actionTimeoutMs?: number;
};

export class PlaywrightWebSurface implements Surface {
  private readonly actionTimeoutMs: number;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    actionTimeoutMs: number
  ) {
    this.actionTimeoutMs = actionTimeoutMs;
  }

  static async launch(options: WebSurfaceOptions = {}): Promise<PlaywrightWebSurface> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const actionTimeoutMs = options.actionTimeoutMs ?? 10_000;
    page.setDefaultTimeout(actionTimeoutMs);
    return new PlaywrightWebSurface(browser, context, page, actionTimeoutMs);
  }

  async navigate(url: string, timeoutMs = this.actionTimeoutMs): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  }

  async observe(): Promise<SurfaceObservation> {
    const controls = await this.page.locator("a, button, input, select, textarea, [role]").evaluateAll((elements) =>
      elements.filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }).map((element) => {
        const htmlElement = element as HTMLElement;
        const input = element as HTMLInputElement;
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          name: element.getAttribute("aria-label") ?? htmlElement.innerText?.trim() ?? input.name ?? "",
          type: element.getAttribute("type")
        };
      })
    );
    const dataFields = await this.page.locator("[data-field]").evaluateAll((elements) => elements.map((element) => {
      const name = element.getAttribute("data-field") ?? "";
      return { name, text: element.textContent?.trim() ?? "", selector: `[data-field="${CSS.escape(name)}"]` };
    }));
    return {
      url: this.page.url(),
      title: await this.page.title(),
      visibleText: (await this.page.locator("body").innerText()).trim(),
      controls,
      dataFields
    };
  }

  async click(target: ControlTarget, timeoutMs = this.actionTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const locator = await this.resolve(target, timeoutMs);
    await locator.click({ timeout: remaining(deadline) });
  }

  async fill(target: ControlTarget, value: string, timeoutMs = this.actionTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const locator = await this.resolve(target, timeoutMs);
    await locator.fill(value, { timeout: remaining(deadline) });
  }

  async extractText(target: ControlTarget, timeoutMs = this.actionTimeoutMs): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const locator = await this.resolve(target, timeoutMs);
    return (await locator.innerText({ timeout: remaining(deadline) })).trim();
  }

  async isVisible(target: ControlTarget, timeoutMs = this.actionTimeoutMs): Promise<boolean> {
    try {
      await this.resolve(target, timeoutMs);
      return true;
    } catch (error) {
      if (error instanceof TargetResolutionError) return false;
      throw error;
    }
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true });
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  private candidate(target: ControlTarget, index: number): Locator {
    const locator = target.locators[index]!;
    switch (locator.strategy) {
      case "role":
        return this.page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], { name: locator.value, exact: locator.exact });
      case "label":
        return this.page.getByLabel(locator.value, { exact: locator.exact });
      case "text":
        return this.page.getByText(locator.value, { exact: locator.exact });
      case "css":
        return this.page.locator(locator.value);
    }
  }

  private async resolve(target: ControlTarget, timeoutMs: number): Promise<Locator> {
    const deadline = Date.now() + timeoutMs;
    let attempts: Array<{ strategy: string; value: string; matches: number }> = [];
    do {
      attempts = [];
      for (const [index, definition] of target.locators.entries()) {
        const locator = this.candidate(target, index);
        const matches = await locator.count();
        attempts.push({ strategy: definition.strategy, value: definition.value, matches });
        const cardinalityMatches = matches === 1 || (!target.requireUnique && matches > 0);
        if (cardinalityMatches && await locator.first().isVisible()) return locator.first();
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(50, remaining)));
    } while (Date.now() < deadline);
    throw new TargetResolutionError(`Could not uniquely resolve ${target.description}`, target, attempts);
  }
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}
