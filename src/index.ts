import { defineCommand, runMain } from "citty";
import generate from "./commands/generate";
import auth from "./commands/auth";
import { registerCleanupHandlers } from "./utils/cleanup";

const main = defineCommand({
  meta: {
    name: "nanban",
    version: "0.1.0",
    description: "Generate images from Google Gemini via the terminal",
  },
  subCommands: {
    generate,
    auth,
  },
});

registerCleanupHandlers();
runMain(main);
