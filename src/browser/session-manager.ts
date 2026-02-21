import puppeteer, { type Browser, type Page } from "puppeteer";
import { ensureDir, getProfilePath } from "../utils/paths";
import { detectChannel } from "./chrome-detector";

export interface BrowserOptions {
  headless: boolean;
  channel?: string;
  verbose?: boolean;
}

export interface BrowserSession {
  browser: Browser;
  close: () => Promise<void>;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function applyPageDefaults(page: Page): Promise<void> {
  await page.setViewport(DEFAULT_VIEWPORT);
  await page.setUserAgent(DEFAULT_USER_AGENT);
}

/**
 * Launch a Puppeteer browser with a persistent profile.
 */
export async function launchBrowser(options: BrowserOptions): Promise<BrowserSession> {
  const profilePath = getProfilePath();
  await ensureDir(profilePath);

  const channel = options.channel !== undefined
    ? options.channel
    : await detectChannel();

  if (options.verbose) {
    console.log(`[nanban] Browser channel: ${channel ?? "chromium (bundled)"}`);
  }

  const browser = await puppeteer.launch({
    headless: options.headless,
    channel: channel as "chrome" | undefined,
    userDataDir: profilePath,
    defaultViewport: DEFAULT_VIEWPORT,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  for (const existingPage of await browser.pages()) {
    await applyPageDefaults(existingPage);
  }

  return {
    browser,
    close: async (): Promise<void> => {
      try {
        await browser.close();
      } catch {
        // Browser may already be closed.
      }
    },
  };
}

/**
 * Create a new page in the browser with default viewport/user-agent.
 */
export async function createPage(session: BrowserSession): Promise<Page> {
  const page = await session.browser.newPage();
  await applyPageDefaults(page);
  return page;
}

/**
 * Get or create a page in the browser.
 */
export async function getOrCreatePage(session: BrowserSession): Promise<Page> {
  const pages = await session.browser.pages();
  const page = pages.length > 0 ? pages[0]! : await createPage(session);
  await applyPageDefaults(page);
  return page;
}

/**
 * Close the current browser session and relaunch with new options.
 */
export async function relaunchBrowser(
  currentSession: BrowserSession,
  options: BrowserOptions,
  navigateTo?: string,
): Promise<BrowserSession> {
  await currentSession.close();

  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  const newSession = await launchBrowser(options);

  if (navigateTo) {
    const page = await getOrCreatePage(newSession);
    await page.goto(navigateTo, { waitUntil: "domcontentloaded", timeout: 0 });
  }

  return newSession;
}
