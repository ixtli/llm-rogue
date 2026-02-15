import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
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
