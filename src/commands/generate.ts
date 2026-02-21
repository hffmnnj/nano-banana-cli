import { defineCommand } from "citty";
import {
  getOrCreatePage,
  launchBrowser,
  type BrowserSession,
} from "../browser/session-manager";
import { isAuthRequired } from "../browser/auth-detector";
import {
  pollForAuth,
  resumeAfterAuth,
  switchToVisible,
} from "../browser/auth-recovery";
import {
  downloadImage,
  hoverToRevealDownload,
  initiateImageCreation,
  navigateToGemini,
  selectProModel,
  triggerGeneration,
  typePrompt,
  waitForGeneration,
} from "../browser/gemini-automation";
import { getDefaultOutputPath, getMultiOutputPath } from "../utils/paths";
import { showIntro, showOutro, showStep, showInfo } from "../cli/ui";
import { withSpinner, SPINNER_LABELS } from "../cli/progress";
import { showError, exitWithError } from "../cli/errors";
import { NanoBananaError } from "../utils/errors";
import { registerSession, unregisterSession } from "../utils/cleanup";

export default defineCommand({
  meta: {
    name: "generate",
    description: "Generate an image from a text prompt using Google Gemini",
  },
  args: {
    prompt: {
      type: "positional",
      description: "The image generation prompt",
      required: true,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output file path (default: ./nban-{timestamp}.png)",
    },
    count: {
      type: "string",
      alias: "n",
      description: "Number of images to generate (default: 1)",
      default: "1",
    },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "Show detailed automation logs",
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const prompt = args.prompt;
    const count = parseInt(args.count ?? "1", 10);
    const outputPath = args.output ?? null;
    const verbose = args.verbose ?? false;

    if (!prompt || prompt.trim().length === 0) {
      exitWithError("Prompt is required.");
    }

    if (isNaN(count) || count < 1) {
      exitWithError("--count must be a positive integer.");
    }

    showIntro();

    const timestamp = Date.now();
    let session: BrowserSession | null = null;

    try {
      session = await withSpinner(SPINNER_LABELS.launchingBrowser, () =>
        launchBrowser({ headless: true, verbose }),
      );
      registerSession(session);

      let page = await getOrCreatePage(session);

      await withSpinner(SPINNER_LABELS.navigating, () =>
        navigateToGemini(page),
      );

      if (await isAuthRequired(page)) {
        const currentUrl = page.url();
        showInfo("Authentication required. Opening browser for sign-in...");
        unregisterSession(session);
        session = await switchToVisible(session, currentUrl);
        registerSession(session);
        page = await getOrCreatePage(session);
        await withSpinner(SPINNER_LABELS.auth, () => pollForAuth(page));
        unregisterSession(session);
        session = await resumeAfterAuth(
          session,
          "https://gemini.google.com/app",
        );
        registerSession(session);
        page = await getOrCreatePage(session);
      }

      await withSpinner(SPINNER_LABELS.initiating, () =>
        initiateImageCreation(page),
      );
      await withSpinner(SPINNER_LABELS.selectingModel, () =>
        selectProModel(page),
      );

      const savedPaths: string[] = [];
      const basePath = outputPath ?? getDefaultOutputPath(timestamp);

      for (let i = 1; i <= count; i++) {
        if (count > 1) {
          showStep(`Generating image ${i} of ${count}...`);
        }

        const imagePath =
          count === 1 ? basePath : getMultiOutputPath(basePath, i, count);

        try {
          await withSpinner(SPINNER_LABELS.typing, () =>
            typePrompt(page, prompt),
          );
          await withSpinner(SPINNER_LABELS.generating, async () => {
            await triggerGeneration(page);
            await waitForGeneration(page);
          });
          await withSpinner(SPINNER_LABELS.downloading, async () => {
            await hoverToRevealDownload(page);
            await downloadImage(page, imagePath);
          });
          savedPaths.push(imagePath);
        } catch (err) {
          showError(
            `Image ${i} failed: ${err instanceof Error ? err.message : String(err)}`,
            count > 1 ? "Continuing with remaining images..." : undefined,
          );
          if (count === 1) throw err;
        }
      }

      if (savedPaths.length === 0) {
        exitWithError(
          "All image generation attempts failed.",
          "Check your connection and try again.",
        );
      }

      if (savedPaths.length === 1) {
        showOutro(savedPaths[0]!);
      } else {
        for (const p of savedPaths) {
          showInfo(`Saved: ${p}`);
        }
        showOutro(`${savedPaths.length} images saved`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred.";
      const hint = err instanceof NanoBananaError
        ? err.hint
        : "Run `nanban auth` if you need to sign in first.";
      showError(message, hint);
      process.exit(1);
    } finally {
      if (session) {
        unregisterSession(session);
        await session.close();
      }
    }
  },
});
