import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

describe("App error screen", () => {
  it("renders error message when WebGPU is unavailable", () => {
    render(() => (
      <App
        checkGpu={() => "WebGPU is not supported in this browser."}
        getBrowserGuide={() => null}
      />
    ));

    expect(screen.getByText("WebGPU is not supported in this browser.")).toBeTruthy();
    expect(screen.getByText(/requires a browser with WebGPU support/)).toBeTruthy();
    expect(screen.getByText("LLM Rogue")).toBeTruthy();
  });

  it("shows Firefox guide link when on Firefox", () => {
    render(() => (
      <App
        checkGpu={() => "WebGPU is not supported in this browser."}
        getBrowserGuide={() => ({
          name: "Firefox",
          url: "https://enablegpu.com/guides/firefox/",
        })}
      />
    ));

    const link = screen.getByRole("link", { name: /Enable WebGPU in Firefox/ });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://enablegpu.com/guides/firefox/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows Safari guide link when on Safari", () => {
    render(() => (
      <App
        checkGpu={() => "WebGPU is not supported in this browser."}
        getBrowserGuide={() => ({
          name: "Safari",
          url: "https://enablegpu.com/guides/safari/",
        })}
      />
    ));

    const link = screen.getByRole("link", { name: /Enable WebGPU in Safari/ });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://enablegpu.com/guides/safari/");
  });

  it("does not show guide link for unsupported browsers", () => {
    render(() => (
      <App
        checkGpu={() => "WebGPU is not supported in this browser."}
        getBrowserGuide={() => null}
      />
    ));

    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("App resize handling", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;
  let originalWorker: typeof Worker;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    originalWorker = globalThis.Worker;

    class MockWorker {
      postMessage = postMessageSpy;
      onmessage: ((e: MessageEvent) => void) | null = null;
      terminate = vi.fn();
    }
    globalThis.Worker = MockWorker as unknown as typeof Worker;

    HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn().mockReturnValue({
      width: 0,
      height: 0,
    });

    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      writable: true,
      configurable: true,
    });

    // jsdom does not implement matchMedia; stub it for the DPI watcher
    window.matchMedia = vi.fn().mockReturnValue({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
    Object.defineProperty(window, "devicePixelRatio", {
      value: 1,
      writable: true,
      configurable: true,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends DPI-scaled dimensions in init message", () => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });

    render(() => <App checkGpu={() => null} />);

    const initMsg = postMessageSpy.mock.calls.find(
      (call: unknown[]) => (call[0] as { type: string }).type === "init",
    );
    expect(initMsg).toBeDefined();
    expect(initMsg?.[0].width).toBe(1600); // 800 * 2
    expect(initMsg?.[0].height).toBe(1200); // 600 * 2
  });

  it("sends debounced resize message on window resize", () => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });

    render(() => <App checkGpu={() => null} />);
    postMessageSpy.mockClear();

    // Simulate resize
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
    window.dispatchEvent(new Event("resize"));

    // No message sent yet (debounce pending)
    const resizeBefore = postMessageSpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === "resize",
    );
    expect(resizeBefore).toHaveLength(0);

    // Advance past debounce timer (150ms)
    vi.advanceTimersByTime(200);

    const resizeAfter = postMessageSpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === "resize",
    );
    expect(resizeAfter).toHaveLength(1);
    expect(resizeAfter[0][0].width).toBe(2048); // 1024 * 2
    expect(resizeAfter[0][0].height).toBe(1536); // 768 * 2
  });
});
