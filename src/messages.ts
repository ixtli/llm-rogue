export type MainToRenderMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "key_down"; key: string }
  | { type: "key_up"; key: string }
  | { type: "pointer_move"; dx: number; dy: number }
  | { type: "scroll"; dy: number }
  | { type: "pan"; dx: number; dy: number };

export type RenderToMainMessage = { type: "ready" } | { type: "error"; message: string };
