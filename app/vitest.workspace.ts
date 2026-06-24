import { defineWorkspace } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineWorkspace([
  "vitest.config.ts",
  {
    plugins: [react()],
    test: {
      name: "web",
      environment: "jsdom",
      include: ["web/src/**/*.test.tsx"],
      setupFiles: ["./vitest.setup.web.ts"],
    },
  },
]);
