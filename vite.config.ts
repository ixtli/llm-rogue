import { spawn } from "node:child_process";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import wasm from "vite-plugin-wasm";

function wasmHotReload(): Plugin {
  let building = false;
  let queued = false;

  function runBuild(server: ViteDevServer) {
    if (building) {
      queued = true;
      return;
    }
    building = true;
    server.config.logger.info("[wasm] rebuilding...", { timestamp: true });

    const proc = spawn(
      "wasm-pack",
      ["build", "crates/engine", "--target", "web", "--", "--features", "wasm"],
      { shell: true, stdio: "pipe" },
    );

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      building = false;
      if (code === 0) {
        server.config.logger.info("[wasm] rebuild complete", { timestamp: true });
        server.ws.send({ type: "full-reload" });
      } else {
        server.config.logger.error(`[wasm] build failed:\n${stderr}`);
      }
      if (queued) {
        queued = false;
        runBuild(server);
      }
    });
  }

  return {
    name: "vite-plugin-wasm-hot-reload",
    configureServer(server) {
      server.watcher.add(["crates/engine/src/**/*.rs", "shaders/**/*.wgsl"]);

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      server.watcher.on("change", (file) => {
        if (!file.endsWith(".rs") && !file.endsWith(".wgsl")) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          runBuild(server);
        }, 100);
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/llm-rogue/" : "/",
  plugins: [solid(), wasm(), ...(command === "serve" ? [wasmHotReload()] : [])],
  worker: {
    plugins: () => [wasm()],
  },
}));
