import { type Component, For } from "solid-js";

export interface CombatLogEntry {
  text: string;
  color: string;
}

const MAX_VISIBLE = 8;

const CombatLog: Component<{ entries: CombatLogEntry[] }> = (props) => {
  const visible = () => props.entries.slice(-MAX_VISIBLE);

  return (
    <div
      style={{
        background: "rgba(0, 0, 0, 0.6)",
        color: "#e0e0e0",
        "font-family": "monospace",
        "font-size": "12px",
        padding: "6px 10px",
        "border-radius": "4px",
        "pointer-events": "none",
        "max-width": "400px",
      }}
    >
      <For each={visible()}>
        {(entry) => <div style={{ color: entry.color, "margin-bottom": "2px" }}>{entry.text}</div>}
      </For>
    </div>
  );
};

export default CombatLog;
