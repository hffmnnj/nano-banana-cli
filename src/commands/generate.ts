import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { defineCommand } from "citty";
import type { Page } from "puppeteer";
import {
  createPage,
  getOrCreatePage,
  launchBrowser,
  type BrowserSession,
} from "../browser/session-manager";
import { isAuthRequired } from "../browser/auth-detector";
import {
  waitForWindowClose,
  resumeAfterAuth,
  switchToVisible,
} from "../browser/auth-recovery";
import {
  downloadImage,
  hoverToRevealDownload,
  initiateImageCreation,
  navigateToGemini,
  startNewChat,
  triggerGeneration,
  typePrompt,
  waitForGeneration,
} from "../browser/gemini-automation";
import { ensureDir, getDefaultOutputPath, getMultiOutputPath } from "../utils/paths";
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
    headed: {
      type: "boolean",
      description: "Run browser in headed (visible) mode for debugging",
      default: false,
    },
    debug: {
      type: "boolean",
      alias: "d",
      description: "Write debug logs and keep browser open on headed failures",
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const prompt = args.prompt;
    const count = parseInt(args.count ?? "1", 10);
    const outputPath = args.output ?? null;
    const verbose = args.verbose ?? false;
    const headed = args.headed ?? false;
    const debug = args.debug ?? false;

    if (!prompt || prompt.trim().length === 0) {
      exitWithError("Prompt is required.");
    }

    if (isNaN(count) || count < 1) {
      exitWithError("--count must be a positive integer.");
    }

    showIntro();

    const timestamp = Date.now();
    const debugDir = join(homedir(), ".nban", "debug");
    const debugLogPath = join(debugDir, `nanban-debug-${timestamp}.log`);
    const generationGuardTimeoutMs = 360_000;
    let session: BrowserSession | null = null;
    let keepBrowserOpenForDebug = false;

    const formatError = (err: unknown): string => {
      if (!(err instanceof Error)) return String(err);
      return err.stack ? `${err.name}: ${err.message}\n${err.stack}` : `${err.name}: ${err.message}`;
    };

    const debugLog = (message: string, err?: unknown): void => {
      if (!debug) return;
      const line = `[${new Date().toISOString()}] ${message}${err ? `\n${formatError(err)}` : ""}\n`;
      appendFileSync(debugLogPath, line, { encoding: "utf8" });
    };

    const waitForGenerationWithWatchdog = async (pageForGeneration: Page): Promise<void> => {
      let watchdog: ReturnType<typeof setTimeout> | null = null;

      try {
        await Promise.race([
          waitForGeneration(pageForGeneration),
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(() => {
              reject(
                new Error(
                  `Generation watchdog timeout after ${generationGuardTimeoutMs / 1000}s.`,
                ),
              );
            }, generationGuardTimeoutMs);
          }),
        ]);
      } finally {
        if (watchdog) {
          clearTimeout(watchdog);
        }
      }
    };

    const attachDebugPageHooks = (debugPage: Page, label: string): void => {
      if (!debug) return;

      debugPage.on("close", () => debugLog(`page[${label}] event: close`));
      debugPage.on("error", (error) => debugLog(`page[${label}] event: error`, error));
      debugPage.on("pageerror", (error) => debugLog(`page[${label}] event: pageerror`, error));
      debugPage.on("framenavigated", (frame) => {
        if (frame === debugPage.mainFrame()) {
          debugLog(`page[${label}] event: navigated -> ${frame.url()}`);
        }
      });
      debugPage.on("requestfailed", (request) => {
        const detail = request.failure()?.errorText ?? "unknown";
        debugLog(`page[${label}] requestfailed ${request.method()} ${request.url()} :: ${detail}`);
      });
      debugPage.on("response", (response) => {
        if (response.status() >= 400) {
          debugLog(`page[${label}] response ${response.status()} ${response.url()}`);
        }
      });
      debugPage.on("console", (msg) => {
        const type = msg.type();
        if (type === "error" || type === "warn") {
          debugLog(`page[${label}] console.${type}: ${msg.text()}`);
        }
      });
    };

    try {
      if (debug) {
        await ensureDir(debugDir);
        showInfo(`Debug log: ${debugLogPath}`);
        showInfo(`Debug traces will be written under: ${debugDir}`);
        debugLog(`debug enabled pid=${process.pid} headed=${headed} verbose=${verbose} count=${count}`);
      }

      session = await withSpinner(SPINNER_LABELS.launchingBrowser, () =>
        launchBrowser({ headless: !headed, verbose }),
      );
      registerSession(session);

      let page = await getOrCreatePage(session);

      if (debug) {
        session.browser.on("disconnected", () => debugLog("browser event: disconnected"));
        attachDebugPageHooks(page, "primary");
      }

      await withSpinner(SPINNER_LABELS.navigating, () => navigateToGemini(page));

      if (await isAuthRequired(page)) {
        const currentUrl = page.url();
        showInfo("Authentication required. Opening browser for sign-in...");
        showInfo("Sign in, then close the browser window when done.");
        unregisterSession(session);
        session = await switchToVisible(session, currentUrl);
        registerSession(session);
        await withSpinner(SPINNER_LABELS.auth, () => waitForWindowClose(session!));
        unregisterSession(session);
        session = await resumeAfterAuth(session, "https://gemini.google.com/app");
        registerSession(session);
        page = await getOrCreatePage(session);

        if (debug) {
          session.browser.on("disconnected", () => debugLog("browser event: disconnected"));
          attachDebugPageHooks(page, "primary-post-auth");
        }
      }

      const savedPaths: string[] = [];
      const basePath = outputPath ?? getDefaultOutputPath(timestamp);

      const startSingleImageGeneration = async (
        workerPage: Page,
        workerLabel: string,
      ): Promise<void> => {
        debugLog(`[${workerLabel}] start generation`);
        await navigateToGemini(workerPage);
        await startNewChat(workerPage);
        await initiateImageCreation(workerPage);
        await typePrompt(workerPage, prompt);
        await triggerGeneration(workerPage);
        debugLog(`[${workerLabel}] generation triggered`);
      };

      const finishSingleImageDownload = async (
        workerPage: Page,
        imagePath: string,
        workerLabel: string,
      ): Promise<string> => {
        const generationKeepAlive = setInterval(() => {}, 500);
        try {
          await waitForGenerationWithWatchdog(workerPage);
          await hoverToRevealDownload(workerPage);
          await downloadImage(workerPage, imagePath);
        } finally {
          clearInterval(generationKeepAlive);
        }

        debugLog(`[${workerLabel}] saved -> ${imagePath}`);
        return imagePath;
      };

      if (count === 1) {
        const imagePath = basePath;
        await withSpinner(SPINNER_LABELS.initiating, async () => {
          await startNewChat(page);
          await initiateImageCreation(page);
        });
        await withSpinner(SPINNER_LABELS.typing, () => typePrompt(page, prompt));
        await withSpinner(SPINNER_LABELS.generating, async () => {
          await triggerGeneration(page);
        });
        await withSpinner(SPINNER_LABELS.downloading, () =>
          finishSingleImageDownload(page, imagePath, "worker-1")
        );
        savedPaths.push(imagePath);
      } else {
        showStep(`Starting ${count} image generations across browser tabs...`);

        const workerPages: Page[] = [page];
        for (let i = 2; i <= count; i++) {
          const workerPage = await createPage(session);
          workerPages.push(workerPage);
          attachDebugPageHooks(workerPage, `worker-${i}`);
        }

        const imagePaths = workerPages.map((_, index) =>
          getMultiOutputPath(basePath, index + 1, count)
        );

        const generationStarted: boolean[] = workerPages.map(() => false);

        for (let i = 0; i < workerPages.length; i++) {
          const workerPage = workerPages[i]!;
          const workerLabel = `worker-${i + 1}`;

          if (headed) {
            await workerPage.bringToFront().catch(() => undefined);
          }

          showStep(`Starting generation for image ${i + 1} of ${count}...`);

          try {
            await withSpinner(SPINNER_LABELS.typing, () =>
              startSingleImageGeneration(workerPage, workerLabel)
            );
            generationStarted[i] = true;
          } catch (err) {
            debugLog(`${workerLabel} failed before generation`, err);
            showError(
              `Image ${i + 1} failed before generation: ${err instanceof Error ? err.message : String(err)}`,
              "Continuing with remaining images...",
            );
          }
        }

        for (let i = 0; i < workerPages.length; i++) {
          if (!generationStarted[i]) continue;

          const workerPage = workerPages[i]!;
          const workerLabel = `worker-${i + 1}`;
          const imagePath = imagePaths[i]!;

          if (headed) {
            await workerPage.bringToFront().catch(() => undefined);
          }

          showStep(`Waiting for image ${i + 1} and downloading...`);

          try {
            const savedPath = await withSpinner(SPINNER_LABELS.downloading, () =>
              finishSingleImageDownload(workerPage, imagePath, workerLabel)
            );
            savedPaths.push(savedPath);
          } catch (err) {
            debugLog(`${workerLabel} failed while waiting/downloading`, err);
            showError(
              `Image ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
              "Continuing with remaining images...",
            );
          }
        }

        if (!debug) {
          await Promise.all(
            workerPages.slice(1).map(async (workerPage) => {
              try {
                await workerPage.close();
              } catch {
                // Ignore close errors from already-closed pages.
              }
            }),
          );
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

      debugLog("command failed", err);
      showError(message, hint);

      if (debug && headed && session) {
        keepBrowserOpenForDebug = true;
        showInfo("Headed debug mode: browser left open for inspection.");
        showInfo("Close the browser window when finished debugging.");
      }

      process.exitCode = 1;
    } finally {
      if (session) {
        unregisterSession(session);

        if (keepBrowserOpenForDebug && session.browser.connected) {
          const browser = session.browser;
          await new Promise<void>((resolve) => {
            browser.once("disconnected", () => resolve());
          });
        } else {
          await session.close();
        }
      }

      if (debug) {
        showInfo(`Debug log saved: ${debugLogPath}`);
      }
    }
  },
});
