import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { defineCommand } from "citty";
import {
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
        page.on("close", () => debugLog("page event: close"));
        page.on("error", (error) => debugLog("page event: error", error));
        page.on("pageerror", (error) => debugLog("page event: pageerror", error));
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) {
            debugLog(`page event: navigated -> ${frame.url()}`);
          }
        });
        page.on("requestfailed", (request) => {
          const detail = request.failure()?.errorText ?? "unknown";
          debugLog(`page event: requestfailed ${request.method()} ${request.url()} :: ${detail}`);
        });
        page.on("response", (response) => {
          if (response.status() >= 400) {
            debugLog(`page event: response ${response.status()} ${response.url()}`);
          }
        });
        page.on("console", (msg) => {
          const type = msg.type();
          if (type === "error" || type === "warn") {
            debugLog(`page console.${type}: ${msg.text()}`);
          }
        });
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
      }

      await withSpinner(SPINNER_LABELS.initiating, () => initiateImageCreation(page));
      const savedPaths: string[] = [];
      const basePath = outputPath ?? getDefaultOutputPath(timestamp);

      for (let i = 1; i <= count; i++) {
        if (count > 1) {
          showStep(`Generating image ${i} of ${count}...`);
        }

        const imagePath =
          count === 1 ? basePath : getMultiOutputPath(basePath, i, count);

        try {
          await withSpinner(SPINNER_LABELS.typing, () => typePrompt(page, prompt));

          const generationKeepAlive = setInterval(() => {}, 500);
          try {
            await withSpinner(SPINNER_LABELS.generating, async () => {
              await triggerGeneration(page);
              await Promise.race([
                waitForGeneration(page),
                new Promise<never>((_, reject) => {
                  setTimeout(() => {
                    reject(
                      new Error(
                        `Generation watchdog timeout after ${generationGuardTimeoutMs / 1000}s.`,
                      ),
                    );
                  }, generationGuardTimeoutMs);
                }),
              ]);
            });
            await withSpinner(SPINNER_LABELS.downloading, async () => {
              await hoverToRevealDownload(page);
              await downloadImage(page, imagePath);
            });
          } finally {
            clearInterval(generationKeepAlive);
          }

          savedPaths.push(imagePath);
        } catch (err) {
          debugLog(`image ${i} failed`, err);
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
