import { chromium, type BrowserContext, type Page } from "playwright";
import { ensureDir, getProfilePath } from "../utils/paths";
import { detectChannel } from "./chrome-detector";

export interface BrowserOptions {
  headless: boolean;
  channel?: string;
  verbose?: boolean;
}

export interface BrowserSession {
  context: BrowserContext;
  close: () => Promise<void>;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Launch a Playwright browser with a persistent profile.
 * Uses launchPersistentContext to persist cookies and local storage.
 */
export async function launchBrowser(options: BrowserOptions): Promise<BrowserSession> {
  const profilePath = getProfilePath();
  await ensureDir(profilePath);

  // Use explicit channel if provided, otherwise auto-detect Chrome availability
  const channel = options.channel !== undefined
    ? options.channel
    : await detectChannel();

  if (options.verbose) {
    console.log(`[nanban] Browser channel: ${channel ?? "chromium (bundled)"}`);
  }

  const context = await chromium.launchPersistentContext(profilePath, {
    headless: options.headless,
    channel,
    viewport: DEFAULT_VIEWPORT,
    userAgent: DEFAULT_USER_AGENT,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  return {
    context,
    close: async (): Promise<void> => {
      await context.close();
    },
  };
}

/**
 * Get or create a page in the browser context.
 * Returns the first existing page, or creates a new one.
 */
export async function getOrCreatePage(session: BrowserSession): Promise<Page> {
  const pages = session.context.pages();
  return pages.length > 0 ? pages[0]! : await session.context.newPage();
}
