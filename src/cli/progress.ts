import { spinner } from "@clack/prompts";

/**
 * Wrap an async operation with a Clack spinner.
 * Shows label during execution, stops with success message on completion.
 * Stops with error message if the operation throws.
 *
 * @param label - Spinner label shown during execution
 * @param asyncFn - Async operation to execute
 * @param successMessage - Optional message on success (defaults to label)
 * @returns The result of asyncFn
 */
export async function withSpinner<T>(
  label: string,
  asyncFn: () => Promise<T>,
  successMessage?: string,
): Promise<T> {
  const s = spinner();
  s.start(label);

  try {
    const result = await asyncFn();
    s.stop(successMessage ?? label);
    return result;
  } catch (err) {
    s.error(`${label} failed.`);
    throw err;
  }
}

/** Standard spinner labels for each automation step. */
export const SPINNER_LABELS = {
  launchingBrowser: "Launching browser...",
  navigating: "Navigating to Gemini...",
  initiating: "Starting image creation...",
  typing: "Entering prompt...",
  generating: "Generating... this may take a moment",
  downloading: "Downloading image...",
  auth: "Waiting for sign-in...",
} as const;
