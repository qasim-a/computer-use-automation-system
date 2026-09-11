import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type { ControlTarget } from "../../contracts/src/index.js";
import { TargetResolutionError, type Surface, type SurfaceObservation } from "./surface.js";

export type WebSurfaceOptions = {
  headless?: boolean;
  actionTimeoutMs?: number;
};

export class PlaywrightWebSurface implements Surface {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page
  ) {}

  static async launch(options: WebSurfaceOptions = {}): Promise<PlaywrightWebSurface> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(options.actionTimeoutMs ?? 10_000);
    return new PlaywrightWebSurface(browser, context, page);
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
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
    return {
      url: this.page.url(),
      title: await this.page.title(),
      visibleText: (await this.page.locator("body").innerText()).trim(),
      controls
    };
  }

  async click(target: ControlTarget): Promise<void> {
    await (await this.resolve(target)).click();
  }

  async fill(target: ControlTarget, value: string): Promise<void> {
    await (await this.resolve(target)).fill(value);
  }

  async extractText(target: ControlTarget): Promise<string> {
    return (await (await this.resolve(target)).innerText()).trim();
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

  private async resolve(target: ControlTarget): Promise<Locator> {
    const attempts: Array<{ strategy: string; value: string; matches: number }> = [];
    for (const [index, definition] of target.locators.entries()) {
      const locator = this.candidate(target, index);
      const matches = await locator.count();
      attempts.push({ strategy: definition.strategy, value: definition.value, matches });
      if (matches === 1 || (!target.requireUnique && matches > 0)) return locator.first();
    }
    throw new TargetResolutionError(`Could not uniquely resolve ${target.description}`, target, attempts);
  }
}
