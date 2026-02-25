# App Error Screen Tests — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test that the App component renders the correct error UI (including browser-specific guide links) when WebGPU initialization fails.

**Architecture:** Extract `checkWebGPU` and `getBrowserGuideUrl` into `src/ui/gpu-check.ts`. Add optional props to `App` so tests can inject stubs instead of mocking globals. Use Vitest + `@solidjs/testing-library` to render and assert.

**Tech Stack:** Vitest, jsdom, @solidjs/testing-library, vite-plugin-solid

---

### Task 1: Install test dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install packages**

Run:
```bash
bun add -d vitest jsdom @solidjs/testing-library @testing-library/jest-dom
```

**Step 2: Verify install**

Run:
```bash
bun pm ls | grep -E 'vitest|jsdom|solidjs/testing-library|jest-dom'
```

Expected: all four packages listed.

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add vitest and solid-testing-library dev deps"
```

---

### Task 2: Add vitest config and test script

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add `"test"` script)

**Step 1: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    globals: true,
  },
});
```

Notes:
- We use a separate `vitest.config.ts` rather than adding `test` to the existing
  `vite.config.ts` because the vite config uses a function form `defineConfig(({ command }) => ...)`
  which doesn't compose cleanly with Vitest's test block.
- `globals: true` makes `describe`/`it`/`expect` available without imports.

**Step 2: Add test script to `package.json`**

Add to the `"scripts"` object:

```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 3: Verify vitest runs (no tests yet)**

Run:
```bash
bun run test
```

Expected: exits cleanly with "No test files found" or similar (not an error).

**Step 4: Commit**

```bash
git add vitest.config.ts package.json
git commit -m "chore: add vitest config and test scripts"
```

---

### Task 3: Extract gpu-check module

**Files:**
- Create: `src/ui/gpu-check.ts`
- Modify: `src/ui/App.tsx`

**Step 1: Create `src/ui/gpu-check.ts`**

Move the two functions out of App.tsx verbatim:

```ts
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
```

**Step 2: Update `src/ui/App.tsx`**

Remove the `checkWebGPU` and `getBrowserGuideUrl` function bodies from App.tsx.
Add imports and optional props:

```tsx
import { checkWebGPU as defaultCheckGpu, getBrowserGuideUrl as defaultGetBrowserGuide } from "./gpu-check";
```

Change the component signature from:

```tsx
const App: Component = () => {
```

to:

```tsx
interface AppProps {
  checkGpu?: () => string | null;
  getBrowserGuide?: () => { name: string; url: string } | null;
}

const App: Component<AppProps> = (props) => {
```

Inside `onMount`, replace:

```tsx
const gpuError = checkWebGPU();
```

with:

```tsx
const checkGpu = props.checkGpu ?? defaultCheckGpu;
const gpuError = checkGpu();
```

In the JSX error fallback, replace the IIFE that calls `getBrowserGuideUrl()`:

```tsx
{(() => {
  const guide = getBrowserGuideUrl();
```

with:

```tsx
{(() => {
  const getBrowserGuide = props.getBrowserGuide ?? defaultGetBrowserGuide;
  const guide = getBrowserGuide();
```

**Step 3: Lint**

Run:
```bash
bun run lint
```

Expected: clean.

**Step 4: Verify the app still works**

Run:
```bash
bun run build:wasm && bun run dev
```

Open in Chrome — should render exactly as before.

**Step 5: Commit**

```bash
git add src/ui/gpu-check.ts src/ui/App.tsx
git commit -m "refactor: extract gpu-check module, add dependency injection props to App"
```

---

### Task 4: Write failing test — error message renders

**Files:**
- Create: `src/ui/App.test.tsx`

**Step 1: Write the failing test**

```tsx
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
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
bun run test
```

Expected: FAIL — the test file should be found but tests should fail because
the extraction and props from Task 3 haven't been verified in test context yet.
If it passes already, that's fine — move to Step 3.

Note: If the test fails due to import/config issues (not assertion failures),
debug the vitest/solid setup before proceeding.

**Step 3: Fix any setup issues until the test passes**

The test should pass once Task 3's refactor is correct. If there are jsdom
or solid-testing-library issues, fix them in the vitest config.

**Step 4: Run test to verify it passes**

Run:
```bash
bun run test
```

Expected: 1 test PASS.

**Step 5: Commit**

```bash
git add src/ui/App.test.tsx
git commit -m "test: add error screen renders when WebGPU unavailable"
```

---

### Task 5: Write test — Firefox guide link

**Files:**
- Modify: `src/ui/App.test.tsx`

**Step 1: Write the failing test**

Add to the `describe("App error screen")` block:

```tsx
  it("shows Firefox guide link when on Firefox", () => {
    render(() => (
      <App
        checkGpu={() => "WebGPU is not supported in this browser."}
        getBrowserGuide={() => ({ name: "Firefox", url: "https://enablegpu.com/guides/firefox/" })}
      />
    ));

    const link = screen.getByRole("link", { name: /Enable WebGPU in Firefox/ });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://enablegpu.com/guides/firefox/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
```

**Step 2: Run test**

Run:
```bash
bun run test
```

Expected: 2 tests PASS (the link is rendered by the existing component code).

**Step 3: Commit**

```bash
git add src/ui/App.test.tsx
git commit -m "test: add Firefox guide link assertion"
```

---

### Task 6: Write test — Safari guide link

**Files:**
- Modify: `src/ui/App.test.tsx`

**Step 1: Write the failing test**

Add to the `describe` block:

```tsx
  it("shows Safari guide link when on Safari", () => {
    render(() => (
      <App
        checkGpu={() => "WebGPU is not supported in this browser."}
        getBrowserGuide={() => ({ name: "Safari", url: "https://enablegpu.com/guides/safari/" })}
      />
    ));

    const link = screen.getByRole("link", { name: /Enable WebGPU in Safari/ });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://enablegpu.com/guides/safari/");
  });
```

**Step 2: Run test**

Run:
```bash
bun run test
```

Expected: 3 tests PASS.

**Step 3: Commit**

```bash
git add src/ui/App.test.tsx
git commit -m "test: add Safari guide link assertion"
```

---

### Task 7: Write test — no guide link for other browsers

**Files:**
- Modify: `src/ui/App.test.tsx`

**Step 1: Write the failing test**

Add to the `describe` block:

```tsx
  it("does not show guide link for unsupported browsers", () => {
    render(() => (
      <App
        checkGpu={() => "WebGPU is not supported in this browser."}
        getBrowserGuide={() => null}
      />
    ));

    expect(screen.queryByRole("link")).toBeNull();
  });
```

**Step 2: Run test**

Run:
```bash
bun run test
```

Expected: 4 tests PASS.

**Step 3: Commit**

```bash
git add src/ui/App.test.tsx
git commit -m "test: assert no guide link for unsupported browsers"
```

---

### Task 8: Final lint + verify

**Files:** none (verification only)

**Step 1: Lint everything**

Run:
```bash
bun run lint
```

Expected: clean.

**Step 2: Run full test suite**

Run:
```bash
bun run test
```

Expected: 4 tests, all PASS.

**Step 3: Run Rust tests too (sanity check)**

Run:
```bash
cargo test -p engine
```

Expected: existing tests still pass.

**Step 4: Commit (only if lint/fmt made changes)**

```bash
git add -A && git commit -m "chore: lint fixes" || echo "nothing to commit"
```
