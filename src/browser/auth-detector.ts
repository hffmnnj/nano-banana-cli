import type { Page } from "playwright";

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
  'button:has-text("Sign in")',
  'button:has-text("Sign in with Google")',
] as const;

async function hasVisibleAuthElement(page: Page): Promise<boolean> {
  for (const selector of AUTH_DOM_SELECTORS) {
    try {
      const visible = await page.locator(selector).first().isVisible({ timeout: 1_000 });
      if (visible) {
        return true;
      }
    } catch {
      // Ignore selector/timeout errors and continue checking.
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
    // Page may have been closed or navigated away — treat as no auth required.
    return false;
  }
}

export async function isOnGeminiApp(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    return url.startsWith(GEMINI_APP_URL);
  } catch {
    // Page may have been closed or navigated away — treat as not on Gemini.
    return false;
  }
}
