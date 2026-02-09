import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import wasm from "vite-plugin-wasm";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/llm-rogue/" : "/",
  plugins: [solid(), wasm()],
  worker: {
    plugins: () => [wasm()],
  },
}));
