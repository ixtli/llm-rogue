import { type Component, createSignal, For } from "solid-js";
import { type GlyphEntry, GlyphRegistry } from "./glyph-registry";

interface SpriteEditorPanelProps {
  onAtlasChanged: (registry: GlyphRegistry, cellSize: number) => void;
}

const SpriteEditorPanel: Component<SpriteEditorPanelProps> = (props) => {
  const registry = new GlyphRegistry();
  const [entries, setEntries] = createSignal<GlyphEntry[]>([...registry.entries()]);
  const [cellSize, setCellSize] = createSignal(32);

  const refresh = () => {
    setEntries([...registry.entries()]);
    props.onAtlasChanged(registry, cellSize());
  };

  // Trigger initial atlas build
  props.onAtlasChanged(registry, cellSize());

  const updateEntry = (spriteId: number, field: keyof GlyphEntry, value: string) => {
    const existing = registry.get(spriteId);
    if (!existing) return;
    const updated = { ...existing, [field]: value || (field === "tint" ? null : "") };
    if (field === "tint" && value === "") updated.tint = null;
    registry.set(spriteId, updated);
    refresh();
  };

  const addEntry = () => {
    registry.add({ char: "?", label: "New", tint: null });
    refresh();
  };

  const removeEntry = (spriteId: number) => {
    registry.remove(spriteId);
    refresh();
  };

  const toggleCellSize = () => {
    const newSize = cellSize() === 32 ? 64 : 32;
    setCellSize(newSize);
    props.onAtlasChanged(registry, newSize);
  };

  return (
    <div
      style={{
        position: "absolute",
        top: "64px",
        left: "10px",
        width: "320px",
        "max-height": "calc(100vh - 80px)",
        "overflow-y": "auto",
        background: "rgba(26, 32, 44, 0.95)",
        border: "1px solid #4a5568",
        "border-radius": "4px",
        padding: "8px",
        "font-family": "monospace",
        "font-size": "12px",
        color: "#e2e8f0",
      }}
    >
      <div style={{ display: "flex", "justify-content": "space-between", "margin-bottom": "8px" }}>
        <span style={{ "font-weight": "bold" }}>Sprite Editor</span>
        <button
          type="button"
          onClick={toggleCellSize}
          style={{
            background: "#2d3748",
            color: "white",
            border: "1px solid #4a5568",
            padding: "2px 6px",
            cursor: "pointer",
            "border-radius": "3px",
            "font-family": "monospace",
            "font-size": "11px",
          }}
        >
          {cellSize()}px
        </button>
      </div>

      <For each={entries()}>
        {(entry) => (
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "4px",
              "margin-bottom": "4px",
              padding: "2px 0",
              "border-bottom": "1px solid #2d3748",
            }}
          >
            <span style={{ width: "20px", "text-align": "right", color: "#718096" }}>
              {entry.spriteId}
            </span>
            <input
              type="text"
              value={entry.char}
              maxLength={2}
              onInput={(e) => updateEntry(entry.spriteId, "char", e.currentTarget.value)}
              style={{
                width: "28px",
                "text-align": "center",
                background: "#2d3748",
                color: "white",
                border: "1px solid #4a5568",
                "border-radius": "2px",
                padding: "2px",
                "font-size": "16px",
              }}
            />
            <input
              type="text"
              value={entry.label}
              onInput={(e) => updateEntry(entry.spriteId, "label", e.currentTarget.value)}
              style={{
                flex: "1",
                background: "#2d3748",
                color: "white",
                border: "1px solid #4a5568",
                "border-radius": "2px",
                padding: "2px 4px",
                "font-size": "12px",
              }}
            />
            <input
              type="color"
              value={entry.tint ?? "#FFFFFF"}
              onInput={(e) => updateEntry(entry.spriteId, "tint", e.currentTarget.value)}
              style={{
                width: "24px",
                height: "20px",
                padding: "0",
                border: "none",
                cursor: "pointer",
              }}
            />
            <button
              type="button"
              onClick={() => removeEntry(entry.spriteId)}
              style={{
                background: "none",
                color: "#f56565",
                border: "none",
                cursor: "pointer",
                "font-size": "14px",
                padding: "0 2px",
              }}
            >
              x
            </button>
          </div>
        )}
      </For>

      <button
        type="button"
        onClick={addEntry}
        style={{
          width: "100%",
          background: "#2d3748",
          color: "#a0aec0",
          border: "1px solid #4a5568",
          padding: "4px",
          cursor: "pointer",
          "border-radius": "3px",
          "margin-top": "4px",
          "font-family": "monospace",
          "font-size": "12px",
        }}
      >
        + Add Sprite
      </button>
    </div>
  );
};

export { SpriteEditorPanel };
export type { SpriteEditorPanelProps };
