export function checkWebGPU(): string | null {
  if (!navigator.gpu) {
    return "WebGPU is not supported in this browser.";
  }
  if (typeof OffscreenCanvas === "undefined") {
    return "OffscreenCanvas is not supported in this browser.";
  }
  return null;
}

export function getBrowserGuideUrl(): { name: string; url: string } | null {
  const ua = navigator.userAgent;
  if (/Firefox\//i.test(ua)) {
    return { name: "Firefox", url: "https://enablegpu.com/guides/firefox/" };
  }
  // Safari UA check: contains "Safari" but not "Chrome" (Chrome also includes "Safari")
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
    return { name: "Safari", url: "https://enablegpu.com/guides/safari/" };
  }
  return null;
}
