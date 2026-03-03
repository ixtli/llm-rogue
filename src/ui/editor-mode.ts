import { createSignal } from "solid-js";

export type EditorMode = "play" | "edit";

const [editorMode, setEditorMode] = createSignal<EditorMode>("play");

export { editorMode, setEditorMode };

export function toggleEditorMode(): void {
  setEditorMode((m) => (m === "play" ? "edit" : "play"));
}
