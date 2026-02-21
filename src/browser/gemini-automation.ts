import { readdir, rename, rm, stat } from "fs/promises";
import { dirname, join } from "path";
import type { ElementHandle, Page } from "puppeteer";
import { isAuthRequired } from "./auth-detector";
import { ensureDir } from "../utils/paths";
import { DownloadError, GenerationTimeoutError, SelectorError } from "../utils/errors";

const GEMINI_URL = "https://gemini.google.com/app";
const NAV_TIMEOUT = 30_000;
const SHORT_WAIT_TIMEOUT = 2_000;
const GENERATION_TIMEOUT = 300_000;

type ModelLabel = "fast" | "thinking" | "pro";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
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

export async function startNewChat(page: Page): Promise<void> {
  const newChat = await queryVisible(page, '[aria-label="New chat"]', 5_000);
  if (!newChat) return;

  try {
    await newChat.click();
    await sleep(600);
  } catch {
    // Ignore and continue if already on a fresh chat.
  }
}

async function getCurrentModelChip(page: Page): Promise<ModelLabel | null> {
  return page.evaluate(() => {
    const modelMap: Record<string, "fast" | "thinking" | "pro"> = {
      fast: "fast",
      thinking: "thinking",
      pro: "pro",
    };

    const isVisible = (el: HTMLElement): boolean => {
      const styles = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return styles.display !== "none"
        && styles.visibility !== "hidden"
        && Number.parseFloat(styles.opacity || "1") > 0
        && rect.width > 0
        && rect.height > 0;
    };

    const norm = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

    const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true")
      .filter((el) => isVisible(el))
      .map((el) => {
        const text = norm((el.innerText || "").split("\n")[0] || "");
        const rect = el.getBoundingClientRect();
        return { el, text, rect };
      })
      .filter(({ text, rect }) => text in modelMap && rect.width <= 220 && rect.height <= 80)
      // Prefer the model chip in the lower composer area, not top navigation badges.
      .sort((a, b) => b.rect.y - a.rect.y);

    if (candidates.length === 0) return null;
    const selected = candidates[0]!.text;
    return modelMap[selected] ?? null;
  });
}

async function clickModelChip(page: Page, label: ModelLabel): Promise<boolean> {
  return page.evaluate((target) => {
    const isVisible = (el: HTMLElement): boolean => {
      const styles = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return styles.display !== "none"
        && styles.visibility !== "hidden"
        && Number.parseFloat(styles.opacity || "1") > 0
        && rect.width > 0
        && rect.height > 0;
    };

    const norm = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

    const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true")
      .filter((el) => isVisible(el))
      .map((el) => ({
        el,
        text: norm((el.innerText || "").split("\n")[0] || ""),
        rect: el.getBoundingClientRect(),
      }))
      .filter(({ text, rect }) => text === target && rect.width <= 220 && rect.height <= 80)
      .sort((a, b) => b.rect.y - a.rect.y);

    if (candidates.length === 0) return false;
    candidates[0]!.el.click();
    return true;
  }, label);
}

async function clickModelOptionInOpenMenu(page: Page, label: ModelLabel): Promise<boolean> {
  return page.evaluate((target) => {
    const isVisible = (el: HTMLElement): boolean => {
      const styles = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return styles.display !== "none"
        && styles.visibility !== "hidden"
        && Number.parseFloat(styles.opacity || "1") > 0
        && rect.width > 0
        && rect.height > 0;
    };

    const norm = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

    const containers = Array.from(document.querySelectorAll("div, section, [role='menu'], [role='listbox'], [role='dialog'], ul"))
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .filter((el) => isVisible(el))
      .filter((el) => {
        const text = norm(el.innerText || "");
        return text.includes("fast") && text.includes("thinking") && text.includes("pro");
      })
      .sort((a, b) => {
        const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
        const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
        return areaA - areaB;
      });

    const findOptionIn = (root: ParentNode): HTMLElement | null => {
      const nodes = Array.from(root.querySelectorAll("button, [role='menuitem'], [role='option'], [role='button'], li, div"))
        .filter((el): el is HTMLElement => el instanceof HTMLElement)
        .filter((el) => isVisible(el));

      for (const node of nodes) {
        const firstLine = norm((node.innerText || "").split("\n")[0] || "");
        if (firstLine !== target) continue;
        if (node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled")) continue;
        return node;
      }

      return null;
    };

    for (const container of containers) {
      const option = findOptionIn(container);
      if (option) {
        option.click();
        return true;
      }
    }

    return false;
  }, label);
}

export async function ensureProModel(page: Page): Promise<void> {
  const current = await getCurrentModelChip(page);

  // Only force-switch when Gemini defaults to Fast.
  if (current !== "fast") return;

  const opened = await clickModelChip(page, "fast");
  if (!opened) {
    throw new SelectorError("Fast model chip");
  }

  await sleep(300);

  const switched = await clickModelOptionInOpenMenu(page, "pro");
  if (!switched) {
    throw new SelectorError("Pro model option");
  }

  await sleep(400);
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

async function findLatestGeneratedImage(page: Page): Promise<ElementHandle<Element> | null> {
  const preferred = await page.$$('img[alt*="AI generated" i]');
  const candidates = preferred.length > 0 ? preferred : await page.$$('img[alt*="generated" i]');

  let best: { handle: ElementHandle<Element>; y: number; x: number } | null = null;

  for (const image of candidates) {
    const box = await image.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) continue;

    if (!best || box.y > best.y || (box.y === best.y && box.x > best.x)) {
      best = { handle: image, y: box.y, x: box.x };
    }
  }

  return best?.handle ?? null;
}

async function hoverGeneratedImage(page: Page): Promise<ElementHandle<Element> | null> {
  const image = await findLatestGeneratedImage(page);
  if (!image) return null;

  const box = await image.boundingBox();
  if (!box) return null;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(400);
  return image;
}

export async function hoverToRevealDownload(page: Page): Promise<void> {
  await hoverGeneratedImage(page);
}

async function clickDownloadFullSize(
  page: Page,
  targetImage: ElementHandle<Element>,
): Promise<void> {
  const selectors = [
    '[data-test-id="download-generated-image-button"]',
    '[aria-label="Download full-sized image"]',
    '[aria-label*="Download full-sized" i]',
  ];

  const clickedNearImage = await targetImage.evaluate((imageNode, selectorList) => {
    const isVisible = (el: HTMLElement): boolean => {
      const styles = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return styles.display !== "none"
        && styles.visibility !== "hidden"
        && Number.parseFloat(styles.opacity || "1") > 0
        && rect.width > 0
        && rect.height > 0;
    };

    let root: HTMLElement | null = imageNode.parentElement;
    while (root) {
      for (const selector of selectorList) {
        const btn = root.querySelector(selector);
        if (btn instanceof HTMLElement && isVisible(btn)) {
          btn.click();
          return true;
        }
      }
      root = root.parentElement;
    }

    return false;
  }, selectors);

  if (clickedNearImage) {
    return;
  }

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
  const image = await hoverGeneratedImage(page);
  if (!image) {
    throw new SelectorError("Generated image element");
  }

  const outputDir = dirname(outputPath);
  await ensureDir(outputDir);

  const tempDownloadDir = join(
    outputDir,
    `.nban-download-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await ensureDir(tempDownloadDir);

  const beforeFiles = new Set(await readdir(tempDownloadDir).catch(() => [] as string[]));

  // Route browser download into the target directory.
  const cdp = await page.target().createCDPSession();
  try {
    await cdp.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: tempDownloadDir,
    });
  } catch {
    // Continue; some environments may not support this command.
  }

  await clickDownloadFullSize(page, image);

  const downloadedName = await waitForDownloadedFile(tempDownloadDir, beforeFiles, 30_000);
  const downloadedPath = join(tempDownloadDir, downloadedName);

  try {
    if (downloadedPath !== outputPath) {
      await rename(downloadedPath, outputPath);
    }
  } finally {
    await rm(tempDownloadDir, { recursive: true, force: true });
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
