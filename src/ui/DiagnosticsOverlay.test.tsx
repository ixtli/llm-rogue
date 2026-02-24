import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { type DiagnosticsDigest, EMPTY_DIGEST } from "../stats";
import DiagnosticsOverlay from "./DiagnosticsOverlay";

describe("DiagnosticsOverlay", () => {
  it("is hidden by default", () => {
    const [data] = createSignal<DiagnosticsDigest>(EMPTY_DIGEST);
    render(() => <DiagnosticsOverlay data={data()} />);
    expect(screen.queryByTestId("diagnostics-overlay")).toBeNull();
  });

  it("appears on backtick keypress", () => {
    const [data] = createSignal<DiagnosticsDigest>(EMPTY_DIGEST);
    render(() => <DiagnosticsOverlay data={data()} />);
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.getByTestId("diagnostics-overlay")).toBeTruthy();
  });

  it("hides on second backtick keypress", () => {
    const [data] = createSignal<DiagnosticsDigest>(EMPTY_DIGEST);
    render(() => <DiagnosticsOverlay data={data()} />);
    fireEvent.keyDown(window, { key: "`" });
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.queryByTestId("diagnostics-overlay")).toBeNull();
  });

  it("displays FPS and frame time", () => {
    const [data] = createSignal<DiagnosticsDigest>({
      ...EMPTY_DIGEST,
      fps: 59.8,
      frame_time_ms: 16.7,
    });
    render(() => <DiagnosticsOverlay data={data()} />);
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.getByText(/59\.8/)).toBeTruthy();
    expect(screen.getByText(/16\.7/)).toBeTruthy();
  });

  it("displays chunk stats", () => {
    const [data] = createSignal<DiagnosticsDigest>({
      ...EMPTY_DIGEST,
      loaded_chunks: 32,
      atlas_total: 512,
    });
    render(() => <DiagnosticsOverlay data={data()} />);
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.getByText(/32/)).toBeTruthy();
    expect(screen.getByText(/512/)).toBeTruthy();
  });

  it("displays WASM memory in MB", () => {
    const [data] = createSignal<DiagnosticsDigest>({
      ...EMPTY_DIGEST,
      wasm_memory_bytes: 4_194_304, // 4 MB
    });
    render(() => <DiagnosticsOverlay data={data()} />);
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.getByText(/4\.0/)).toBeTruthy();
  });
});
