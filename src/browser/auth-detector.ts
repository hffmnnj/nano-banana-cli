import type { ElementHandle, Page } from "puppeteer";

const GEMINI_APP_URL = "https://gemini.google.com/app";
const AUTH_URL_PATTERNS = [
  "accounts.google.com",
  "gemini.google.com/signin",
  "gemini.google.com/auth",
  "accounts.google.com/v3/signin",
];

const AUTH_DOM_SELECTORS = [
  'input[type="email"][name="identifier"]',
  '[aria-label*="Sign in" i]',
  '[aria-label*="authentication" i]',
  '[aria-label*="Google Account" i]',
  '[data-identifier]',
] as const;

async function isVisible(handle: ElementHandle<Element>): Promise<boolean> {
  const box = await handle.boundingBox();
  return box !== null && box.width > 0 && box.height > 0;
}

async function hasVisibleAuthElement(page: Page): Promise<boolean> {
  for (const selector of AUTH_DOM_SELECTORS) {
    try {
      const handle = await page.$(selector);
      if (handle && await isVisible(handle)) {
        return true;
      }
    } catch {
      // Continue checking fallback selectors.
    }
  }

  return false;
}

export async function isAuthRequired(page: Page): Promise<boolean> {
  try {
    const url = page.url();

    for (const pattern of AUTH_URL_PATTERNS) {
      if (url.includes(pattern)) {
        return true;
      }
    }

    if (url.startsWith(GEMINI_APP_URL)) {
      return false;
    }

    return await hasVisibleAuthElement(page);
  } catch {
    return false;
  }
}

export async function isOnGeminiApp(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (!url.startsWith(GEMINI_APP_URL)) return false;

    const signIn = await page.$('input[type="email"], [aria-label*="Sign in" i]');
    if (signIn && await isVisible(signIn)) return false;

    const appShell = await page.$('[aria-label="New chat"], textarea, [contenteditable="true"]');
    return appShell ? await isVisible(appShell) : false;
  } catch {
    return false;
  }
}
