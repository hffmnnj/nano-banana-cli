import { chromium } from "playwright";

/**
 * Detect if the system Chrome browser is available.
 * Attempts a brief headless launch with channel "chrome" to verify availability.
 * Returns "chrome" if Chrome is installed, undefined to use bundled Chromium.
 */
export async function detectChannel(): Promise<"chrome" | undefined> {
  try {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    await browser.close();
    return "chrome";
  } catch {
    return undefined;
  }
}
