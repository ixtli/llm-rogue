import type { Component } from "solid-js";
import { COLOR_DANGER, COLOR_GOOD, COLOR_WARN } from "./ui-colors";

export interface PlayerHUDData {
  health: number;
  maxHealth: number;
  attack: number;
  defense: number;
}

function hpColor(ratio: number): string {
  if (ratio > 0.5) return COLOR_GOOD;
  if (ratio > 0.25) return COLOR_WARN;
  return COLOR_DANGER;
}

const PlayerHUD: Component<{ data: PlayerHUDData }> = (props) => {
  const ratio = () => (props.data.maxHealth > 0 ? props.data.health / props.data.maxHealth : 0);

  return (
    <div
      style={{
        background: "rgba(0, 0, 0, 0.75)",
        color: "#e0e0e0",
        "font-family": "monospace",
        "font-size": "13px",
        padding: "8px 12px",
        "border-radius": "4px",
        "pointer-events": "none",
        "min-width": "160px",
      }}
    >
      <div style={{ "margin-bottom": "4px" }}>
        HP: {props.data.health}/{props.data.maxHealth}
      </div>
      <div
        style={{
          background: "#333",
          height: "6px",
          "border-radius": "3px",
          overflow: "hidden",
          "margin-bottom": "6px",
        }}
      >
        <div
          style={{
            width: `${Math.max(0, Math.min(100, ratio() * 100))}%`,
            height: "100%",
            background: hpColor(ratio()),
            transition: "width 0.2s, background 0.2s",
          }}
        />
      </div>
      <div style={{ "font-size": "11px", color: "#9ca3af" }}>
        ATK {props.data.attack} | DEF {props.data.defense}
      </div>
    </div>
  );
};

export default PlayerHUD;
