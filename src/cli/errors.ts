import { log, cancel } from "@clack/prompts";

/**
 * Display an error message with an optional recovery hint.
 * Direct and actionable — no emoji, no cute language.
 *
 * @param message - The error description
 * @param hint - Optional hint for recovery (e.g., "Try running `nanban auth` first")
 */
export function showError(message: string, hint?: string): void {
  log.error(message);
  if (hint) {
    log.info(`Hint: ${hint}`);
  }
}

/**
 * Display a cancellation message and close the Clack bar.
 * Brief and clean — no personality.
 */
export function showCancelled(): void {
  cancel("Cancelled.");
}

/**
 * Display an error and exit with non-zero code.
 * Use for fatal errors that should terminate the process.
 *
 * @param message - The error description
 * @param hint - Optional recovery hint
 * @param exitCode - Exit code (defaults to 1)
 */
export function exitWithError(message: string, hint?: string, exitCode = 1): never {
  showError(message, hint);
  process.exit(exitCode);
}
