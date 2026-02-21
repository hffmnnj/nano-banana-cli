import { intro, outro, log, note as clackNote } from "@clack/prompts";
import pc from "picocolors";

/**
 * Display the Nano Banana intro header.
 * Call this at the start of every command.
 */
export function showIntro(): void {
  intro(pc.yellow("\uD83C\uDF4C Nano Banana"));
}

/**
 * Display the success outro with the saved file path.
 * Call this when image generation succeeds.
 * @param filePath - Path of the saved image file
 */
export function showOutro(filePath: string): void {
  log.success(`Saved: ${pc.dim(filePath)}`);
  outro("Peeled and delivered.");
}

/**
 * Display a connected-bar step label.
 * @param label - Step description
 */
export function showStep(label: string): void {
  log.step(label);
}

/**
 * Display an informational message.
 * @param message - Info content
 */
export function showInfo(message: string): void {
  log.info(message);
}

/**
 * Display a note box with optional title.
 * @param message - Note content
 * @param title - Optional note title
 */
export function showNote(message: string, title?: string): void {
  clackNote(message, title);
}

/**
 * Display a warning message.
 * @param message - Warning content
 */
export function showWarn(message: string): void {
  log.warn(message);
}
