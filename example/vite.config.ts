import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "room-server/client": resolve(__dirname, "../src/client.ts"),
      "room-server/types": resolve(__dirname, "../src/types.ts"),
    },
  },
});
