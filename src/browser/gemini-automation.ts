import { mkdir } from "fs/promises";
import { dirname } from "path";
import type { Locator, Page } from "playwright";
import { isAuthRequired } from "./auth-detector";
import { GenerationTimeoutError, SelectorError } from "../utils/errors";

const GEMINI_URL = "https://gemini.google.com/app";

// Navigation timeout (ms)
const NAV_TIMEOUT = 30_000;
// UI action timeout (ms)
const ACTION_TIMEOUT = 10_000;
const SHORT_WAIT_TIMEOUT = 2_000;
const GENERATION_TIMEOUT = 120_000;

interface LocatorStrategy {
  description: string;
  createLocator: (page: Page) => Locator;
}

async function clickFirstVisible(
  page: Page,
  strategies: LocatorStrategy[],
  clickTimeout: number,
): Promise<boolean> {
  for (const strategy of strategies) {
    const candidate = strategy.createLocator(page).first();

    try {
      await candidate.waitFor({ state: "visible", timeout: SHORT_WAIT_TIMEOUT });
      await candidate.click({ timeout: clickTimeout });
      return true;
    } catch {
      // Continue to next selector strategy when current one is unavailable.
    }
  }

  return false;
}

/**
 * Navigate to the Gemini app and wait for it to load.
 * @param page - Playwright Page instance
 */
export async function navigateToGemini(page: Page): Promise<void> {
  await page.goto(GEMINI_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });

  // Gemini bootstraps dynamically; brief hydration wait prevents early selector misses.
  await page.waitForTimeout(2_000);

  if (await isAuthRequired(page)) {
    return;
  }

  // Aria-label based anchors for app shell readiness.
  await page.locator('[aria-label="New chat"], [aria-label="Gemini"]').first().waitFor({
    state: "visible",
    timeout: NAV_TIMEOUT,
  });
}

/**
 * Click the image creation entry point in Gemini.
 * @param page - Playwright Page instance
 */
export async function initiateImageCreation(page: Page): Promise<void> {
  const imageEntryStrategies: LocatorStrategy[] = [
    {
      // Sidebar image mode button; stable aria-label in current Gemini layouts.
      description: "aria-label Image button",
      createLocator: (currentPage) => currentPage.locator('[aria-label="Image"]'),
    },
    {
      // Alternate aria-label used on some account/region variants.
      description: "aria-label Create Image button",
      createLocator: (currentPage) => currentPage.locator('[aria-label="Create Image"]'),
    },
    {
      // Role-based fallback when exact labels vary but button semantics remain stable.
      description: "button role with Image text",
      createLocator: (currentPage) => currentPage.getByRole("button", { name: /image/i }),
    },
    {
      // Link fallback for sidebar variants rendered as anchors.
      description: "link role with Image text",
      createLocator: (currentPage) => currentPage.getByRole("link", { name: /image/i }),
    },
    {
      // Last-resort aria partial match for anchor implementations.
      description: "aria-label contains Image link",
      createLocator: (currentPage) => currentPage.locator('a[aria-label*="Image"]'),
    },
  ];

  const clickedImageEntry = await clickFirstVisible(page, imageEntryStrategies, ACTION_TIMEOUT);

  if (!clickedImageEntry) {
    throw new SelectorError("Gemini image creation entry point");
  }

  // Allow Gemini panel transition after mode switch.
  await page.waitForTimeout(1_000);
}

/**
 * Open model selector and switch to Pro / Imagen 3 when available.
 * @param page - Playwright Page instance
 */
export async function selectProModel(page: Page): Promise<void> {
  const openModelMenuStrategies: LocatorStrategy[] = [
    {
      // Preferred: model picker controls often expose aria-label containing "model".
      description: "aria-label contains model",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="model" i]'),
    },
    {
      // Role-based fallback for model controls named with current model value.
      description: "button role with model in accessible name",
      createLocator: (currentPage) => currentPage.getByRole("button", { name: /model|imagen|pro/i }),
    },
  ];

  const openedModelMenu = await clickFirstVisible(page, openModelMenuStrategies, ACTION_TIMEOUT);

  if (!openedModelMenu) {
    return;
  }

  await page.waitForTimeout(500);

  const proOptionStrategies: LocatorStrategy[] = [
    {
      // Preferred: direct Pro option exposed via aria-label.
      description: "aria-label contains Pro",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="Pro" i]'),
    },
    {
      // Preferred: model option explicitly named Imagen 3.
      description: "aria-label contains Imagen 3",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="Imagen 3"]'),
    },
    {
      // Role fallback for menu item variants in Material menus.
      description: "menuitem role with Imagen 3 or Pro text",
      createLocator: (currentPage) =>
        currentPage.getByRole("menuitem", { name: /imagen\s*3|pro/i }),
    },
    {
      // Button fallback for model cards rendered as buttons.
      description: "button role with Imagen 3 or Pro text",
      createLocator: (currentPage) => currentPage.getByRole("button", { name: /imagen\s*3|pro/i }),
    },
  ];

  await clickFirstVisible(page, proOptionStrategies, ACTION_TIMEOUT);
  await page.waitForTimeout(500);
}

/**
 * Type the generation prompt into Gemini's prompt input.
 * @param page - Playwright Page instance
 * @param prompt - User prompt text
 */
export async function typePrompt(page: Page, prompt: string): Promise<void> {
  const inputStrategies: LocatorStrategy[] = [
    {
      description: "aria-label contains prompt",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="prompt" i]'),
    },
    {
      description: "Enter a prompt aria-label",
      createLocator: (currentPage) => currentPage.locator('[aria-label="Enter a prompt"]'),
    },
    {
      description: "aria-label contains Describe",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="Describe" i]'),
    },
    {
      description: "placeholder contains prompt",
      createLocator: (currentPage) => currentPage.locator('[placeholder*="prompt" i]'),
    },
    {
      description: "labeled textarea",
      createLocator: (currentPage) => currentPage.locator("textarea[aria-label]"),
    },
    {
      description: "textbox role",
      createLocator: (currentPage) => currentPage.getByRole("textbox"),
    },
  ];

  let inputLocator: Locator | null = null;

  for (const strategy of inputStrategies) {
    const candidate = strategy.createLocator(page).first();

    try {
      await candidate.waitFor({ state: "visible", timeout: SHORT_WAIT_TIMEOUT });
      inputLocator = candidate;
      break;
    } catch {
      // Continue to next selector strategy when current one is unavailable.
    }
  }

  if (!inputLocator) {
    throw new SelectorError("Gemini prompt input field");
  }

  await inputLocator.click({ timeout: ACTION_TIMEOUT });
  await page.waitForTimeout(300);
  await inputLocator.fill("");
  await page.keyboard.type(prompt, { delay: 30 });
  await page.waitForTimeout(200);
}

/**
 * Submit the prompt to start image generation.
 * @param page - Playwright Page instance
 */
export async function triggerGeneration(page: Page): Promise<void> {
  const submitStrategies: LocatorStrategy[] = [
    {
      description: "Send button by aria-label",
      createLocator: (currentPage) => currentPage.locator('button[aria-label*="Send" i]'),
    },
    {
      description: "Generate button by aria-label",
      createLocator: (currentPage) => currentPage.locator('button[aria-label*="Generate" i]'),
    },
    {
      description: "Submit button by aria-label",
      createLocator: (currentPage) => currentPage.locator('button[aria-label*="Submit" i]'),
    },
    {
      description: "submit type button",
      createLocator: (currentPage) => currentPage.locator('button[type="submit"]'),
    },
    {
      description: "role-based send/generate button",
      createLocator: (currentPage) =>
        currentPage.getByRole("button", { name: /send|generate|submit/i }),
    },
  ];

  const clickedSubmit = await clickFirstVisible(page, submitStrategies, ACTION_TIMEOUT);

  if (!clickedSubmit) {
    await page.keyboard.press("Enter");
  }

  await page.waitForTimeout(500);
}

/**
 * Wait until Gemini finishes image generation and a generated image is visible.
 * @param page - Playwright Page instance
 * @param timeoutMs - Maximum wait time in milliseconds
 */
export async function waitForGeneration(
  page: Page,
  timeoutMs: number = GENERATION_TIMEOUT,
): Promise<void> {
  const loadingStrategies: LocatorStrategy[] = [
    {
      description: "aria-label contains generating",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="Generating" i]'),
    },
    {
      description: "aria-label contains loading",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="Loading" i]'),
    },
    {
      description: "progressbar role",
      createLocator: (currentPage) => currentPage.getByRole("progressbar"),
    },
    {
      description: "aria-busy true",
      createLocator: (currentPage) => currentPage.locator('[aria-busy="true"]'),
    },
  ];

  // Best-effort wait for loading state to clear before polling for the final image.
  for (const strategy of loadingStrategies) {
    const candidate = strategy.createLocator(page).first();

    try {
      if (await candidate.isVisible()) {
        await candidate.waitFor({
          state: "hidden",
          timeout: Math.min(15_000, timeoutMs),
        });
        break;
      }
    } catch {
      // Loading indicator strategy may not exist in every Gemini variant.
    }
  }

  const imageStrategies: LocatorStrategy[] = [
    {
      description: "aria-label Generated image",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="Generated image" i]'),
    },
    {
      description: "aria-label Image result",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="Image result" i]'),
    },
    {
      description: "img with generated alt text",
      createLocator: (currentPage) => currentPage.locator('img[alt*="generated" i]'),
    },
    {
      // Last-resort fallback: class selector for known response container variants.
      description: "response container image fallback",
      createLocator: (currentPage) => currentPage.locator(".response-container img"),
    },
    {
      description: "base64 image source fallback",
      createLocator: (currentPage) => currentPage.locator('img[src*="data:image"]'),
    },
    {
      description: "any visible image with src fallback",
      createLocator: (currentPage) => currentPage.locator('img[src]:not([src=""])'),
    },
  ];

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const strategy of imageStrategies) {
      const candidate = strategy.createLocator(page).first();

      try {
        if (await candidate.isVisible()) {
          return;
        }
      } catch {
        // Continue polling until timeout.
      }
    }

    await page.waitForTimeout(500);
  }

  throw new GenerationTimeoutError(Math.floor(timeoutMs / 1000));
}

/**
 * Hover the generated image to reveal Gemini's download controls.
 * @param page - Playwright Page instance
 */
export async function hoverToRevealDownload(page: Page): Promise<void> {
  const imgStrategies: LocatorStrategy[] = [
    {
      description: "aria-label Generated image",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="Generated image" i]').first(),
    },
    {
      description: "aria-label Image result",
      createLocator: (currentPage) => currentPage.locator('[aria-label*="Image result" i]').first(),
    },
    {
      description: "img with generated alt text",
      createLocator: (currentPage) => currentPage.locator('img[alt*="generated" i]').first(),
    },
    {
      description: "last image with src fallback",
      createLocator: (currentPage) => currentPage.locator('img[src]:not([src=""])').last(),
    },
  ];

  let imageEl: Locator | null = null;

  for (const strategy of imgStrategies) {
    const candidate = strategy.createLocator(page);

    try {
      await candidate.waitFor({ state: "visible", timeout: SHORT_WAIT_TIMEOUT });
      imageEl = candidate;
      break;
    } catch {
      // Try next strategy.
    }
  }

  if (!imageEl) {
    throw new SelectorError("generated image element");
  }

  await imageEl.hover({ timeout: ACTION_TIMEOUT });
  await page.waitForTimeout(800);

  const downloadButton = page
    .locator(
      '[aria-label*="Download full size" i], [aria-label*="Download" i], button:has-text("Download")',
    )
    .first();

  try {
    await downloadButton.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    // Download selector variants are handled by the download step's own strategy set.
  }
}

export async function downloadImage(page: Page, outputPath: string): Promise<string> {
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });

  const downloadBtnStrategies: LocatorStrategy[] = [
    {
      description: "aria-label Download full size",
      createLocator: (p) => p.locator('[aria-label*="Download full size" i]'),
    },
    {
      description: "aria-label contains Download",
      createLocator: (p) => p.locator('[aria-label*="Download" i]').first(),
    },
    {
      description: "button with Download text",
      createLocator: (p) => p.getByRole("button", { name: /download/i }).first(),
    },
    {
      description: "link with Download text",
      createLocator: (p) => p.getByRole("link", { name: /download/i }).first(),
    },
  ];

  const clicked = await clickFirstVisible(page, downloadBtnStrategies, ACTION_TIMEOUT);

  if (!clicked) {
    throw new SelectorError("Download full size button");
  }

  const download = await downloadPromise;
  await mkdir(dirname(outputPath), { recursive: true });
  await download.saveAs(outputPath);

  return outputPath;
}

export interface GenerationResult {
  outputPath: string;
}

export async function runGenerationFlow(
  page: Page,
  prompt: string,
  outputPath: string,
): Promise<GenerationResult> {
  await navigateToGemini(page);
  await initiateImageCreation(page);
  await selectProModel(page);
  await typePrompt(page, prompt);
  await triggerGeneration(page);
  await waitForGeneration(page);
  await hoverToRevealDownload(page);
  const savedPath = await downloadImage(page, outputPath);

  return { outputPath: savedPath };
}
