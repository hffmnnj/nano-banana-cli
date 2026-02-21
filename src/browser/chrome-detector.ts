import puppeteer from "puppeteer";

/**
 * Detect if system Chrome is available.
 * Returns "chrome" when Puppeteer can launch that channel.
 */
export async function detectChannel(): Promise<"chrome" | undefined> {
  try {
    const browser = await puppeteer.launch({ channel: "chrome", headless: true });
    await browser.close();
    return "chrome";
  } catch {
    return undefined;
  }
}
