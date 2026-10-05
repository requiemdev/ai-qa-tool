/**
 * @file setup.ts
 * Global setup hook for Playwright browser tests.
 * Performs a preflight navigation check to verify target server reachability
 * and detect unexpected authentication redirects before running browser suites.
 */

import { chromium, type FullConfig } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Global setup function executed by Playwright prior to running tests.
 * Navigates to the designated test target URL to perform connectivity and
 * authentication preflight checks, capturing screenshots and traces if blocked.
 *
 * @param config - Full Playwright test configuration containing metadata and project options.
 * @throws {Error} If navigation fails, returns HTTP 400+, or redirects to an auth wall.
 */
export default async function setup(config: FullConfig): Promise<void> {
  const url: unknown = config.metadata.url;
  const artifacts: unknown = config.metadata.artifacts;
  if (typeof url !== "string" || typeof artifacts !== "string") {
    throw new Error("Invalid runner metadata.");
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const storageState = config.projects[0]?.use.storageState;
    const project = config.projects[0]?.use;
    const context = await browser.newContext({
      ...(storageState ? { storageState } : {}),
      ...(project?.viewport ? { viewport: project.viewport } : {}),
      ...(project?.reducedMotion
        ? { reducedMotion: project.reducedMotion }
        : {}),
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      if (!response || response.status() >= 400) {
        throw new Error(
          `Navigation unavailable (HTTP ${response?.status() ?? "unknown"}).`,
        );
      }
      const original = new URL(url);
      const final = new URL(page.url());
      if (
        final.origin !== original.origin ||
        (final.pathname !== original.pathname &&
          /(^|\/)(?:login|signin|sign-in|auth)(\/|$)/i.test(final.pathname))
      ) {
        throw new Error(
          `Authentication redirect to ${final.origin}${final.pathname}; supply prepared --storage-state.`,
        );
      }
      await context.tracing.stop();
    } catch (error) {
      await page
        .screenshot({ path: join(artifacts, "preflight.png") })
        .catch(() => {});
      await context.tracing
        .stop({ path: join(artifacts, "preflight-trace.zip") })
        .catch(() => {});
      throw error;
    }
    await context.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(join(artifacts, "blocked.json"), message, { mode: 0o600 });
    throw new Error(`Browser preflight blocked: ${message}`);
  } finally {
    await browser?.close();
  }
}

