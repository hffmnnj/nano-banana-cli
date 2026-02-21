import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "auth",
    description: "Authenticate with Google to enable image generation",
  },
  async run() {
    console.log("[stub] Auth flow will be implemented in Wave 4");
  },
});
