import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "generate",
    description: "Generate an image from a prompt",
  },
  args: {
    prompt: {
      type: "positional",
      description: "The image generation prompt",
      required: true,
    },
  },
  async run({ args }) {
    console.log(`[stub] Generating image for: ${args.prompt}`);
  },
});
