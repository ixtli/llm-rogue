import type { Component } from "solid-js";

interface GameOverStats {
  turns: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsPickedUp: number;
  causeOfDeath: string | null;
}

export interface GameOverScreenProps {
  stats: GameOverStats;
  onRestart: () => void;
}

const STAT_ROWS: { label: string; key: keyof GameOverStats }[] = [
  { label: "Turns Survived", key: "turns" },
  { label: "Enemies Killed", key: "kills" },
  { label: "Damage Dealt", key: "damageDealt" },
  { label: "Damage Taken", key: "damageTaken" },
  { label: "Items Picked Up", key: "itemsPickedUp" },
];

const GameOverScreen: Component<GameOverScreenProps> = (props) => {
  return (
    <div
      style={{
        position: "fixed",
        inset: "0",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        background: "rgba(0, 0, 0, 0.7)",
        "z-index": "200",
      }}
    >
      <div
        style={{
          background: "rgba(0, 0, 0, 0.95)",
          border: "1px solid #444",
          "border-radius": "6px",
          padding: "24px 32px",
          "font-family": "monospace",
          color: "#e0e0e0",
          "min-width": "300px",
          "text-align": "center",
        }}
      >
        <div
          style={{
            "font-size": "24px",
            color: "#ef4444",
            "margin-bottom": "8px",
          }}
        >
          You Died
        </div>
        <div
          style={{
            "font-size": "13px",
            color: "#999",
            "margin-bottom": "20px",
          }}
        >
          {props.stats.causeOfDeath ? `Killed by ${props.stats.causeOfDeath}` : "You have perished"}
        </div>
        <div
          style={{
            display: "grid",
            "grid-template-columns": "1fr auto",
            gap: "4px 16px",
            "text-align": "left",
            "font-size": "12px",
            "margin-bottom": "20px",
          }}
        >
          {STAT_ROWS.map((row) => (
            <>
              <span style={{ color: "#888" }}>{row.label}</span>
              <span style={{ color: "#fff", "text-align": "right" }}>{props.stats[row.key]}</span>
            </>
          ))}
        </div>
        <button
          type="button"
          onClick={props.onRestart}
          style={{
            background: "#333",
            border: "1px solid #555",
            "border-radius": "4px",
            padding: "8px 24px",
            color: "#fff",
            "font-family": "monospace",
            "font-size": "14px",
            cursor: "pointer",
          }}
        >
          New Game
        </button>
      </div>
    </div>
  );
};

export default GameOverScreen;
