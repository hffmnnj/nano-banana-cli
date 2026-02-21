/**
 * Typed error classes for all Nano Banana failure modes.
 * All errors have actionable `message` and optional `hint` for recovery.
 */

/**
 * Base class for all Nano Banana errors.
 * Provides optional recovery hint.
 */
export class NanoBananaError extends Error {
  public readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "NanoBananaError";
    this.hint = hint;
  }
}

/**
 * Playwright or Chrome browser failed to launch.
 */
export class BrowserLaunchError extends NanoBananaError {
  constructor(message: string, hint = "Ensure Chrome or Chromium is installed and try again.") {
    super(message, hint);
    this.name = "BrowserLaunchError";
  }
}

/**
 * An authentication wall was detected before reaching Gemini.
 * This is recoverable via auth recovery flow.
 */
export class AuthRequiredError extends NanoBananaError {
  constructor(hint = "Run `nanban auth` to sign in first.") {
    super("Google authentication is required.", hint);
    this.name = "AuthRequiredError";
  }
}

/**
 * Image generation did not complete within the timeout period.
 */
export class GenerationTimeoutError extends NanoBananaError {
  constructor(timeoutSeconds: number, hint = "Try again. Gemini may be slow or overloaded.") {
    super(`Image generation timed out after ${timeoutSeconds}s.`, hint);
    this.name = "GenerationTimeoutError";
  }
}

/**
 * The image download failed or was not intercepted by Playwright.
 */
export class DownloadError extends NanoBananaError {
  constructor(message: string, hint = "Try running the command again.") {
    super(message, hint);
    this.name = "DownloadError";
  }
}

/**
 * A Playwright selector did not find the expected element.
 * Usually indicates Gemini's UI has changed.
 */
export class SelectorError extends NanoBananaError {
  constructor(
    selectorDescription: string,
    hint = "Gemini's UI may have changed. Check for updates to nanban.",
  ) {
    super(`Cannot find expected UI element: ${selectorDescription}`, hint);
    this.name = "SelectorError";
  }
}
