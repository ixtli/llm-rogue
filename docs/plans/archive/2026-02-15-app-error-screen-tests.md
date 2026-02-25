# App Error Screen Tests

## Goal

Test that the App component renders the correct error UI when WebGPU
initialization fails, including browser-specific guide links for Firefox and
Safari.

## Approach: Extract + Inject

Move `checkWebGPU()` and `getBrowserGuideUrl()` out of `App.tsx` into a
standalone module (`src/ui/gpu-check.ts`). The `App` component accepts optional
props for these functions, defaulting to the real implementations. Tests inject
stubs via props — no global mocking needed.

## New Module: `src/ui/gpu-check.ts`

Exports:
- `checkWebGPU(): string | null` — returns error message or null
- `getBrowserGuideUrl(): { name: string; url: string } | null` — returns
  browser-specific guide or null

## App Component Changes

New optional props:
- `checkGpu?: () => string | null` (defaults to `checkWebGPU`)
- `getBrowserGuide?: () => { name: string; url: string } | null` (defaults to
  `getBrowserGuideUrl`)

No changes to rendering logic.

## Test Cases (`src/ui/App.test.tsx`)

1. **Error message renders when WebGPU unavailable** — inject `checkGpu`
   returning an error string, assert error text and compatibility info appear.
2. **Firefox guide link** — inject both stubs (error + Firefox guide), assert
   link with `href="https://enablegpu.com/guides/firefox/"`.
3. **Safari guide link** — same pattern, assert Safari URL.
4. **No guide link for other browsers** — inject `checkGpu` (error) and
   `getBrowserGuide` returning null, assert no link rendered.

## Test Infrastructure

- **Runner:** Vitest with jsdom environment
- **Rendering:** `@solidjs/testing-library`
- **Config:** `vitest.config.ts` with `vite-plugin-solid`
- **Script:** `"test": "vitest run"` in package.json

## Out of Scope

- Happy-path test (WebGPU available, worker boots successfully)
- Unit tests for the actual `navigator.gpu` / `userAgent` sniffing logic
- Worker message handling tests
