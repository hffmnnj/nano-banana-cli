import { showCancelled } from "../cli/errors";
import type { BrowserSession } from "../browser/session-manager";

let activeSessions: BrowserSession[] = [];

/**
 * Register a browser session for cleanup on process exit.
 * Sessions registered here will be closed if the process receives
 * SIGINT or SIGTERM before normal cleanup completes.
 */
export function registerSession(session: BrowserSession): void {
  activeSessions.push(session);
}

/**
 * Unregister a browser session (when it closes normally).
 * Call this before manually closing a session to avoid double-close.
 */
export function unregisterSession(session: BrowserSession): void {
  activeSessions = activeSessions.filter((s) => s !== session);
}

/**
 * Clean up all active browser sessions.
 * Uses Promise.allSettled so one failure doesn't block others.
 * Safe to call multiple times — clears the list on each call.
 */
async function cleanup(): Promise<void> {
  const sessions = [...activeSessions];
  activeSessions = [];

  await Promise.allSettled(
    // Best-effort close — ignore individual failures so remaining sessions still close.
    sessions.map((s) => s.close().catch(() => undefined)),
  );
}

let cleanupRegistered = false;

/**
 * Register SIGINT and SIGTERM handlers for graceful cancellation.
 * Call this once at CLI startup. Idempotent — safe to call multiple times.
 *
 * On signal:
 * 1. Displays cancellation message via Clack
 * 2. Closes all registered browser sessions
 * 3. Exits with code 130 (standard SIGINT exit code)
 */
export function registerCleanupHandlers(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const handleSignal = async (): Promise<void> => {
    showCancelled();
    await cleanup();
    process.exit(130);
  };

  process.on("SIGINT", () => {
    void handleSignal();
  });
  process.on("SIGTERM", () => {
    void handleSignal();
  });
}
