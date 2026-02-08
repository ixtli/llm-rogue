export type MainToRenderMessage = {
  type: "init";
  canvas: OffscreenCanvas;
  width: number;
  height: number;
};

export type RenderToMainMessage = {
  type: "ready";
};
