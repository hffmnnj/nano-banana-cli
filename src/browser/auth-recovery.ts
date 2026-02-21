import { relaunchBrowser, type BrowserSession } from "./session-manager";

/**
 * Switch from headless to visible browser mode for user auth.
 */
export async function switchToVisible(
  currentSession: BrowserSession,
  currentUrl: string,
): Promise<BrowserSession> {
  return relaunchBrowser(currentSession, { headless: false }, currentUrl);
}

/**
 * Wait for the user to close the browser window.
 */
export async function waitForWindowClose(session: BrowserSession): Promise<void> {
  return new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => {}, 1_000);

    session.browser.once("disconnected", () => {
      clearInterval(keepAlive);
      resolve();
    });
  });
}

/**
 * Relaunch headless browser after auth is done.
 */
export async function resumeAfterAuth(
  visibleSession: BrowserSession,
  navigateTo?: string,
): Promise<BrowserSession> {
  return relaunchBrowser(visibleSession, { headless: true }, navigateTo);
}
