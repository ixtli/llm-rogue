import { type Component, createSignal, For, Show } from "solid-js";

const TYPE_COLORS: Record<string, string> = {
  weapon: "#f59e0b",
  armor: "#3b82f6",
  consumable: "#22d3ee",
  key: "#a78bfa",
  misc: "#9ca3af",
};

const SLOT_LABELS: Array<"weapon" | "armor" | "helmet" | "ring"> = [
  "weapon",
  "armor",
  "helmet",
  "ring",
];

interface InventoryItem {
  slotIndex: number;
  itemId: string;
  name: string;
  type: string;
  quantity: number;
  slot?: "weapon" | "armor" | "helmet" | "ring";
  damage?: number;
  defense?: number;
  critBonus?: number;
  stackable: boolean;
}

interface EquippedItem {
  itemId: string;
  name: string;
  damage?: number;
  defense?: number;
  critBonus?: number;
}

export interface InventoryPanelProps {
  inventory: InventoryItem[];
  equipment: Record<"weapon" | "armor" | "helmet" | "ring", EquippedItem | null>;
  onEquip: (slotIndex: number) => void;
  onUnequip: (slot: "weapon" | "armor" | "helmet" | "ring") => void;
  onUse: (slotIndex: number) => void;
  onDrop: (slotIndex: number) => void;
  onClose: () => void;
}

function statLine(item: { damage?: number; defense?: number; critBonus?: number }): string {
  const parts: string[] = [];
  if (item.damage != null) parts.push(`ATK +${item.damage}`);
  if (item.defense != null) parts.push(`DEF +${item.defense}`);
  if (item.critBonus != null) parts.push(`CRIT +${item.critBonus}%`);
  return parts.join("  ");
}

const InventoryPanel: Component<InventoryPanelProps> = (props) => {
  const [hoveredItem, setHoveredItem] = createSignal<InventoryItem | null>(null);

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  };

  const handleItemClick = (item: InventoryItem, e: MouseEvent) => {
    if (e.shiftKey) {
      props.onDrop(item.slotIndex);
      return;
    }
    if (item.slot) {
      props.onEquip(item.slotIndex);
    } else if (item.type === "consumable") {
      props.onUse(item.slotIndex);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop click-to-dismiss
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: "0",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        background: "rgba(0, 0, 0, 0.5)",
        "z-index": "100",
      }}
      onClick={handleBackdropClick}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div
        style={{
          background: "rgba(0, 0, 0, 0.9)",
          border: "1px solid #444",
          "border-radius": "6px",
          padding: "16px",
          "font-family": "monospace",
          color: "#e0e0e0",
          "min-width": "360px",
          "max-width": "480px",
          "max-height": "80vh",
          "overflow-y": "auto",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            "justify-content": "space-between",
            "align-items": "center",
            "margin-bottom": "12px",
          }}
        >
          <span style={{ "font-size": "16px", color: "#fff" }}>Inventory</span>
          <span style={{ "font-size": "11px", color: "#666" }}>I or Esc to close</span>
        </div>

        {/* Equipment section */}
        <div style={{ "margin-bottom": "12px" }}>
          <div style={{ "font-size": "11px", color: "#888", "margin-bottom": "6px" }}>
            Equipment
          </div>
          <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
            <For each={SLOT_LABELS}>
              {(slot) => {
                const equipped = () => props.equipment[slot];
                return (
                  <button
                    type="button"
                    style={{
                      flex: "1",
                      "min-width": "70px",
                      background: equipped()
                        ? "rgba(255, 255, 255, 0.08)"
                        : "rgba(255, 255, 255, 0.03)",
                      border: `1px solid ${equipped() ? "#555" : "#333"}`,
                      "border-radius": "4px",
                      padding: "6px",
                      cursor: equipped() ? "pointer" : "default",
                      "font-size": "11px",
                      "text-align": "center",
                      "font-family": "inherit",
                      color: "inherit",
                    }}
                    onClick={() => {
                      if (equipped()) props.onUnequip(slot);
                    }}
                    title={
                      equipped() ? `Click to unequip ${equipped()?.name}` : `${slot} slot empty`
                    }
                  >
                    <div
                      style={{
                        color: "#888",
                        "text-transform": "capitalize",
                        "margin-bottom": "2px",
                      }}
                    >
                      {slot}
                    </div>
                    <div
                      style={{
                        color: equipped() ? (TYPE_COLORS[slot] ?? "#e0e0e0") : "#555",
                        "white-space": "nowrap",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                      }}
                    >
                      {equipped()?.name ?? "Empty"}
                    </div>
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        {/* Divider */}
        <div style={{ "border-top": "1px solid #333", "margin-bottom": "12px" }} />

        {/* Inventory list */}
        <div style={{ "font-size": "11px", color: "#888", "margin-bottom": "6px" }}>
          Items
          <span style={{ "margin-left": "8px", color: "#555" }}>
            click equip/use | shift+click drop
          </span>
        </div>

        <Show
          when={props.inventory.length > 0}
          fallback={
            <div style={{ color: "#555", "font-size": "12px", padding: "8px 0" }}>No items</div>
          }
        >
          <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
            <For each={props.inventory}>
              {(item) => (
                <button
                  type="button"
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                    padding: "4px 8px",
                    background: "rgba(255, 255, 255, 0.03)",
                    border: "none",
                    "border-radius": "3px",
                    cursor: item.slot || item.type === "consumable" ? "pointer" : "default",
                    "font-size": "12px",
                    "font-family": "inherit",
                    color: "inherit",
                    width: "100%",
                  }}
                  onClick={(e) => handleItemClick(item, e)}
                  onMouseEnter={() => setHoveredItem(item)}
                  onMouseLeave={() => setHoveredItem(null)}
                >
                  <span style={{ color: TYPE_COLORS[item.type] ?? "#9ca3af" }}>
                    {item.name}
                    {item.quantity > 1 ? ` x${item.quantity}` : ""}
                  </span>
                  <span style={{ color: "#666", "font-size": "10px", "margin-left": "12px" }}>
                    {item.slot ? "equip" : item.type === "consumable" ? "use" : ""}
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* Hover tooltip */}
        <Show when={hoveredItem()}>
          {(item) => {
            const stats = statLine(item());
            return (
              <div
                style={{
                  "margin-top": "10px",
                  "border-top": "1px solid #333",
                  "padding-top": "8px",
                  "font-size": "11px",
                }}
              >
                <div style={{ color: TYPE_COLORS[item().type] ?? "#9ca3af" }}>{item().name}</div>
                <Show when={stats}>
                  <div style={{ color: "#aaa", "margin-top": "2px" }}>{stats}</div>
                </Show>
                <div style={{ color: "#666", "margin-top": "2px" }}>
                  {item().type}
                  {item().stackable ? " (stackable)" : ""}
                </div>
              </div>
            );
          }}
        </Show>
      </div>
    </div>
  );
};

export default InventoryPanel;
