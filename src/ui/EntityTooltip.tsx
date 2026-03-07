import type { Component } from "solid-js";

export interface TooltipData {
  name: string;
  hostility: "friendly" | "neutral" | "hostile";
  healthTier: string;
  screenX: number;
  screenY: number;
}

const HOSTILITY_COLORS: Record<string, string> = {
  friendly: "#4ade80",
  neutral: "#facc15",
  hostile: "#f87171",
};

const EntityTooltip: Component<{ data: TooltipData }> = (props) => {
  return (
    <div
      style={{
        position: "absolute",
        left: `${props.data.screenX}px`,
        top: `${props.data.screenY}px`,
        background: "rgba(0, 0, 0, 0.85)",
        color: "#e0e0e0",
        "font-family": "monospace",
        "font-size": "13px",
        padding: "6px 10px",
        "border-radius": "4px",
        "pointer-events": "none",
        "white-space": "nowrap",
        "z-index": "100",
        border: `1px solid ${HOSTILITY_COLORS[props.data.hostility] ?? "#666"}`,
      }}
    >
      <div style={{ "font-weight": "bold", "margin-bottom": "2px" }}>{props.data.name}</div>
      <div style={{ color: HOSTILITY_COLORS[props.data.hostility], "font-size": "11px" }}>
        {props.data.hostility}
      </div>
      {props.data.healthTier && (
        <div style={{ "font-size": "11px", "margin-top": "2px" }}>{props.data.healthTier}</div>
      )}
    </div>
  );
};

export default EntityTooltip;
