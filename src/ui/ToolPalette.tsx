import { type Component, createSignal } from "solid-js";

export type ActiveTool = "none" | "sprite-editor";

const [activeTool, setActiveTool] = createSignal<ActiveTool>("none");
export { activeTool };

const ToolPalette: Component = () => {
  const toggle = (tool: ActiveTool) => {
    setActiveTool((current) => (current === tool ? "none" : tool));
  };

  return (
    <div
      style={{
        position: "absolute",
        top: "36px",
        left: "10px",
        display: "flex",
        gap: "4px",
      }}
    >
      <button
        type="button"
        onClick={() => toggle("sprite-editor")}
        style={{
          background: activeTool() === "sprite-editor" ? "#4a5568" : "#2d3748",
          color: "white",
          border: "1px solid #4a5568",
          padding: "4px 8px",
          "font-family": "monospace",
          "font-size": "12px",
          cursor: "pointer",
          "border-radius": "3px",
        }}
      >
        Sprites
      </button>
    </div>
  );
};

export default ToolPalette;
