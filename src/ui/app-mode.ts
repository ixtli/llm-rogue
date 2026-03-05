import { createSignal } from "solid-js";

export type AppMode = "play" | "edit";

const [appMode, setAppMode] = createSignal<AppMode>("play");

export { appMode, setAppMode };

export function toggleAppMode(): void {
  setAppMode((m) => (m === "play" ? "edit" : "play"));
}
