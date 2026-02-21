import { defineCommand } from "citty";
import { pollForAuth } from "../browser/auth-recovery";
import { getOrCreatePage, launchBrowser } from "../browser/session-manager";
import { showIntro, showOutro, showInfo } from "../cli/ui";
import { withSpinner, SPINNER_LABELS } from "../cli/progress";
import { showError } from "../cli/errors";
import { registerSession, unregisterSession } from "../utils/cleanup";

export default defineCommand({
  meta: {
    name: "auth",
    description:
      "Open a browser to sign in to Google and save your session for future image generation",
  },
  args: {},
  async run(): Promise<void> {
    showIntro();
    showInfo("Opening browser for Google sign-in...");
    showInfo("Sign in, then return to this terminal.");

    const session = await withSpinner(SPINNER_LABELS.launchingBrowser, () =>
      launchBrowser({ headless: false }),
    );
    registerSession(session);

    try {
      const page = await getOrCreatePage(session);

      await page.goto("https://gemini.google.com/app", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      await withSpinner(SPINNER_LABELS.auth, () => pollForAuth(page));

      showOutro("Session saved. You're ready to generate.");
    } catch (err) {
      showError(
        err instanceof Error ? err.message : "Authentication failed.",
        "Try running `nanban auth` again.",
      );
      process.exit(1);
    } finally {
      unregisterSession(session);
      await session.close();
    }
  },
});
