import { readdir, rename, stat } from "fs/promises";
import { dirname, join } from "path";
import type { ElementHandle, Page } from "puppeteer";
import { isAuthRequired } from "./auth-detector";
import { ensureDir } from "../utils/paths";
import { DownloadError, GenerationTimeoutError, SelectorError } from "../utils/errors";

const GEMINI_URL = "https://gemini.google.com/app";
const NAV_TIMEOUT = 30_000;
const SHORT_WAIT_TIMEOUT = 2_000;
const GENERATION_TIMEOUT = 300_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function isVisible(handle: ElementHandle<Element>): Promise<boolean> {
  const box = await handle.boundingBox();
  return box !== null && box.width > 0 && box.height > 0;
}

async function queryVisible(
  page: Page,
  selector: string,
  timeout = SHORT_WAIT_TIMEOUT,
): Promise<ElementHandle<Element> | null> {
  try {
    await page.waitForSelector(selector, { visible: true, timeout });
    const handle = await page.$(selector);
    if (!handle) return null;
    return await isVisible(handle) ? handle : null;
  } catch {
    return null;
  }
}

async function clickFirstVisible(
  page: Page,
  selectors: string[],
  clickTimeout: number,
): Promise<boolean> {
  for (const selector of selectors) {
    const candidate = await queryVisible(page, selector);
    if (!candidate) continue;

    const disabled = await candidate.evaluate((el) => {
      const button = el as HTMLButtonElement;
      return button.disabled || el.getAttribute("aria-disabled") === "true";
    });
    if (disabled) continue;

    try {
      await withTimeout(candidate.click(), clickTimeout, `Click ${selector}`);
      return true;
    } catch {
      // Continue to next selector.
    }
  }

  return false;
}

export async function navigateToGemini(page: Page): Promise<void> {
  await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await sleep(2_000);

  if (await isAuthRequired(page)) return;

  const ready =
    await queryVisible(page, '[aria-label="New chat"]', NAV_TIMEOUT) ||
    await queryVisible(page, '[aria-label="Gemini"]', NAV_TIMEOUT);

  if (!ready) {
    throw new SelectorError("Gemini app shell");
  }
}

export async function initiateImageCreation(page: Page): Promise<void> {
  const active = await queryVisible(page, '[aria-label*="Deselect Create image" i]');
  if (active) return;

  const selectors = [
    'button[aria-label*="Create image" i]',
    '[role="button"][aria-label*="Create image" i]',
    'a[aria-label*="Create image" i]',
    '[aria-label*="Create image" i]',
  ];

  const clicked = await clickFirstVisible(page, selectors, 10_000);
  if (!clicked) throw new SelectorError("Gemini image creation entry point");
  await sleep(1_000);
}

export async function typePrompt(page: Page, prompt: string): Promise<void> {
  const selectors = [
    'div[role="textbox"][aria-label="Enter a prompt for Gemini"]',
    'div[role="textbox"]',
    '.ql-editor[role="textbox"]',
    '.ql-editor',
  ];

  let input: ElementHandle<Element> | null = null;
  for (const selector of selectors) {
    input = await queryVisible(page, selector);
    if (input) break;
  }

  if (!input) {
    throw new SelectorError("Gemini prompt input field");
  }

  await input.click();
  await sleep(200);

  try {
    await input.evaluate((el, value) => {
      const node = el as HTMLElement;
      node.focus();

      if (node.isContentEditable) {
        node.textContent = "";
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.textContent = value;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      } else if ("value" in node) {
        const inputNode = node as HTMLInputElement | HTMLTextAreaElement;
        inputNode.value = value;
        inputNode.dispatchEvent(new Event("input", { bubbles: true }));
        inputNode.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, prompt);
  } catch {
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.type(prompt);
  }

  await sleep(200);
}

export async function triggerGeneration(page: Page): Promise<void> {
  const selectors = [
    'button[aria-label*="Send" i]',
    'button[aria-label*="Generate" i]',
    'button[aria-label*="Submit" i]',
    'button[type="submit"]',
  ];

  const clicked = await clickFirstVisible(page, selectors, 10_000);
  if (!clicked) {
    await page.keyboard.press("Enter");
  }

  await sleep(500);
}

export async function waitForGeneration(page: Page): Promise<void> {
  if (!/\/app\/.+/.test(page.url())) {
    try {
      await page.waitForFunction(() => /\/app\/.+/.test(window.location.pathname), {
        timeout: 30_000,
      });
    } catch {
      // Continue even if URL already settled or delayed.
    }
  }

  try {
    await page.waitForSelector('img[alt*="AI generated" i]', {
      visible: true,
      timeout: GENERATION_TIMEOUT,
    });
  } catch {
    throw new GenerationTimeoutError(GENERATION_TIMEOUT / 1000);
  }
}

async function findGeneratedImage(page: Page): Promise<ElementHandle<Element> | null> {
  const selectors = ['img[alt*="AI generated" i]', 'img[alt*="generated" i]'];

  for (const selector of selectors) {
    const image = await queryVisible(page, selector);
    if (image) return image;
  }

  return null;
}

async function hoverGeneratedImage(page: Page): Promise<void> {
  const image = await findGeneratedImage(page);
  if (!image) return;

  const box = await image.boundingBox();
  if (!box) return;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(400);
}

export async function hoverToRevealDownload(page: Page): Promise<void> {
  await hoverGeneratedImage(page);
}

async function clickDownloadFullSize(page: Page): Promise<void> {
  const selectors = [
    '[data-test-id="download-generated-image-button"]',
    '[aria-label="Download full-sized image"]',
    '[aria-label*="Download full-sized" i]',
  ];

  // Try visible-click first after hover.
  for (const selector of selectors) {
    const button = await queryVisible(page, selector, 3_000);
    if (!button) continue;

    try {
      await withTimeout(button.click(), 10_000, `Click ${selector}`);
      return;
    } catch {
      // Try other selectors, then JS fallback below.
    }
  }

  // Fallback for on-hover controls that Puppeteer may still treat as hidden.
  const clicked = await page.evaluate((selectorList) => {
    for (const selector of selectorList) {
      const node = document.querySelector(selector) as HTMLElement | null;
      if (!node) continue;
      node.click();
      return true;
    }
    return false;
  }, selectors);

  if (!clicked) {
    throw new SelectorError("Download full-sized image button");
  }
}

async function waitForDownloadedFile(
  dirPath: string,
  beforeSet: Set<string>,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const files = await readdir(dirPath).catch(() => [] as string[]);
    const created = files.filter((name) => !beforeSet.has(name));

    const finalized = created.filter((name) => !name.endsWith(".crdownload") && !name.endsWith(".tmp"));
    if (finalized.length > 0) {
      const candidates = await Promise.all(
        finalized.map(async (name) => ({
          name,
          mtimeMs: (await stat(join(dirPath, name))).mtimeMs,
        })),
      );

      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return candidates[0]!.name;
    }

    await sleep(250);
  }

  throw new DownloadError("Timed out waiting for browser download to complete.");
}

export async function downloadImage(page: Page, outputPath: string): Promise<string> {
  await hoverGeneratedImage(page);

  const outputDir = dirname(outputPath);
  await ensureDir(outputDir);

  const beforeFiles = new Set(await readdir(outputDir).catch(() => [] as string[]));

  // Route browser download into the target directory.
  const cdp = await page.target().createCDPSession();
  try {
    await cdp.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: outputDir,
    });
  } catch {
    // Continue; some environments may not support this command.
  }

  await clickDownloadFullSize(page);

  const downloadedName = await waitForDownloadedFile(outputDir, beforeFiles, 30_000);
  const downloadedPath = join(outputDir, downloadedName);

  if (downloadedPath !== outputPath) {
    await rename(downloadedPath, outputPath);
  }

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
  await typePrompt(page, prompt);
  await triggerGeneration(page);
  await waitForGeneration(page);
  await hoverToRevealDownload(page);
  const savedPath = await downloadImage(page, outputPath);
  return { outputPath: savedPath };
}
