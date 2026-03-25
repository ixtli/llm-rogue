# Phase 9 Tier 1: Minimum Viable Chunk Server — Design Spec

Standalone Rust HTTP server that generates and serves precomputed chunk data.
The WASM render worker fetches chunks asynchronously, skipping all client-side
extraction. Game remains fully playable offline via local Perlin fallback.

## Architecture

```
┌─────────────────────────────┐
│  Chunk Server (Rust/axum)   │
│  GET /chunks/{cx},{cy},{cz} │
│  GET /health                │
│  MapConfig generation       │
│  Precomputes: occupancy,    │
│    collision, terrain grid   │
│  In-memory LRU cache        │
│  postcard response          │
└──────────────┬──────────────┘
               │ HTTP (localhost or remote)
               ▼
┌──────────────────────────────────────────────┐
│  Render Worker (Rust/WASM)                   │
│  ChunkManager state machine per chunk:       │
│  Empty → Fetching → Ready (or FallbackLocal) │
│  Browser fetch() via spawn_local callback    │
│  Deserialize postcard payload                │
│  Upload voxels + precomputed data to atlas   │
│  Emit chunk_terrain to game worker           │
└──────────────────────────────────────────────┘
```

No changes to the game worker or UI thread. They continue receiving
`chunk_terrain` messages exactly as before.

## Chunk Server Binary

New Rust crate: `crates/chunk-server/`. Depends on `engine` crate (native, not
WASM) for `Chunk`, `CollisionMap`, `TerrainGrid`, `MapConfig`, and occupancy
computation. Must be added to workspace `members` in the root `Cargo.toml` and
inherit `[workspace.lints]`.

### Endpoints

- `GET /chunks/{cx},{cy},{cz}` — `postcard`-serialized `ChunkPayload`
- `GET /health` — liveness check for deployment probes and client connectivity

### Generation Flow

1. Check LRU cache for `(cx, cy, cz)`
2. Cache miss → generate chunk via `MapConfig::generate_chunk(coord)` (same
   pipeline as the client uses for local generation — ensures deterministic
   parity between server and fallback), compute occupancy, collision map,
   terrain grid
3. Serialize to `postcard`, store in cache, return response

### Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 3001 | Listen port |
| `--seed` | random | World generation seed |
| `--cache-size` | 4096 | Max cached chunks (~160 MB at ~40 KB each) |

CORS: `Access-Control-Allow-Origin: *` for Tier 1.

### Dependencies

`axum`, `tokio`, `postcard` (with `serde`), `lru`, `clap`, plus `engine` crate
(native).

### Run Command

```bash
cargo run -p chunk-server
cargo run -p chunk-server -- --port 3001 --seed 42
```

## Wire Format (postcard + serde)

Shared `ChunkPayload` struct defined in the `engine` crate (available to both
server and client):

```rust
#[derive(serde::Serialize, serde::Deserialize)]
pub struct ChunkPayload {
    pub cx: i32,
    pub cy: i32,
    pub cz: i32,
    pub voxels: Vec<u8>,        // 32768 × 4 bytes = 128 KB
    pub occupancy: u64,         // 64-bit bitmask
    pub collision: Vec<u8>,     // CHUNK_SIZE^3 / 8 bytes (4096 at CHUNK_SIZE=32)
    pub terrain_grid: Vec<u8>,  // variable, existing serialization format
}
```

Serialized via `postcard` — a compact, no-std-compatible, serde-based binary
format. Works on both native (server) and `wasm32-unknown-unknown` (client)
without platform-specific dependencies.

### Why postcard over Cap'n Proto

Cap'n Proto's Rust runtime (`capnp` crate) depends on `std::fs` and OS I/O,
making it incompatible with `wasm32-unknown-unknown`. `postcard` is
`no_std`-compatible, has zero platform deps, and compiles cleanly to WASM.
While it doesn't offer true zero-copy reads, deserialization of the ~40 KB
payload is sub-millisecond and not a bottleneck vs the fetch latency.

### Extensibility

Adding Tier 2a fields is a backward-compatible serde change:

```rust
pub struct ChunkPayload {
    // ... existing fields ...
    #[serde(default)]
    pub baked_ao: Option<Vec<u8>>,
    #[serde(default)]
    pub sun_shadow: Option<Vec<u8>>,
}
```

Old payloads without these fields deserialize with `None`. Old clients ignore
unknown trailing bytes (postcard's default behavior).

## Client-Side Integration

### Chunk State Machine

```
Empty → Fetching → Ready
  │                  ↑
  └──→ FallbackLocal─┘  (on fetch failure)
```

### Async Fetch Architecture

Browser `fetch()` cannot be called from a synchronous Rust function. The
integration uses `wasm_bindgen_futures::spawn_local` with a shared result queue:

1. `tick_budgeted` checks for chunks that need loading. For each (up to budget),
   if `server_url` is set and chunk is not already `Fetching`, mark it
   `Fetching` and call `spawn_local` with an async closure that:
   - Calls `web_sys::window().fetch()` for the chunk URL
   - On success: deserializes the `postcard` payload
   - Pushes a `CompletedFetch { coord, result: Result<ChunkPayload, Error> }`
     into a `Rc<RefCell<Vec<CompletedFetch>>>` shared with the ChunkManager
2. On each subsequent `tick_budgeted` call, drain the completed fetches queue
   first. For each completed fetch:
   - Success: upload voxels to atlas via a new `upload_precomputed` path that
     accepts raw voxel bytes + precomputed occupancy mask (bypasses
     `chunk.occupancy_mask()` call). Set collision map and terrain grid from
     payload. Emit `chunk_terrain`. Mark chunk `Ready`.
   - Failure: fall back to local generation. Mark chunk `FallbackLocal`.
3. If `server_url` is `None`, skip all of the above — use existing synchronous
   `chunk_gen` closure (behavior identical to today).

### cfg Gating

All fetch-related code is gated behind `#[cfg(feature = "wasm")]`:
- `spawn_local`, `web_sys::Request`, `JsFuture` imports
- `pending_count`, `completed_queue` fields on ChunkManager
- The `spawn_local` call path in `tick_budgeted`

For native compilation (`cargo test -p engine`), these fields and code paths
don't exist. The `server_url` field exists on all targets but is only acted
on in WASM builds.

### Atlas Upload Path

New method `ChunkAtlas::upload_precomputed(coord, voxels, occupancy, collision)`
that:
- Allocates or reuses an atlas slot (existing logic)
- Writes voxel bytes directly to the 3D texture (existing `queue.write_texture`)
- Stores the precomputed occupancy mask in `occupancy_masks[slot]` (bypasses
  `chunk.occupancy_mask()`)
- Stores the precomputed collision map (bypasses `CollisionMap::from_chunk()`)

This avoids constructing a `Chunk` struct on the client side — the payload
bytes flow directly to their destinations.

### Connectivity Tracking

- Track consecutive fetch failures. After 5 failures, switch to offline mode —
  stop making requests, generate all chunks locally.
- Every 30 seconds, try one probe fetch (to `/health`). If it succeeds, resume
  server mode.
- Report server status in stats pipeline as integer: 0=offline, 1=local
  (never connected), 2=server.

### What Doesn't Change

- `chunk_terrain` message format
- Chunk budget (4/frame)
- Distance prioritization
- GPU upload path (`queue.write_texture`)

The CPU savings (~8 ms/frame at 4 chunks/frame) come from skipping extraction
of occupancy, collision, and terrain grid for server-provided chunks.

## Server URL Configuration

Precedence (highest first):

1. `?server=http://...` query parameter — ad-hoc testing
2. `VITE_CHUNK_SERVER_URL` env var — baked at build time for deployments
3. Not set → pure offline mode (no fetches, existing Perlin)

URL is read in render worker initialization, passed to `ChunkManager` as
`server_url: Option<String>`.

### Dev Workflow

```bash
# Terminal 1
cargo run -p chunk-server

# Terminal 2
VITE_CHUNK_SERVER_URL=http://localhost:3001 bun run dev
```

Or just `bun run dev` with no env var for offline mode.

## Compression

HTTP-level only (brotli/gzip) via server framework and browser. No
application-level compression for Tier 1. Can add LZ4 later if bandwidth
becomes a bottleneck.

## Diagnostics

Stats pipeline additions (following existing 6-step pattern, all `f32`):

| Stat | Type | Encoding | Description |
|------|------|----------|-------------|
| `chunk_source` | f32 | 0=offline, 1=local, 2=server | Current mode |
| `server_chunks_loaded` | f32 | count | Chunks loaded from server this session |
| `fallback_chunks_loaded` | f32 | count | Chunks that fell back to local |
| `fetch_latency_ms` | f32 | milliseconds | Rolling average fetch round-trip |

Displayed in diagnostics overlay (~). Server-side logs: request coord, cache
hit/miss, generation time, response size.

## Testing

### Server (native Rust, `crates/chunk-server/`)

- Generate chunk via endpoint, deserialize response, verify
  voxels/occupancy/collision/terrain match local `engine` computation
- LRU cache: same coord returns identical bytes, eviction works

### Client (engine crate)

- Deserialize `postcard` `ChunkPayload`, verify precomputed fields used
  directly (no extraction called)
- `upload_precomputed` unit test: verify occupancy mask and collision map are
  stored at the correct atlas slot without calling extraction functions
- Fallback: simulate fetch failure → local Perlin generation
- State machine: Empty → Fetching → Ready, Empty → FallbackLocal

### Integration (manual, browser)

- Start both servers, verify chunks load from server (diagnostics shows "server")
- Kill chunk server, verify fallback with "offline" indicator
- Restart server, verify reconnection after probe

### Unchanged

Game logic tests, UI tests, and render regression tests are unaffected —
game worker interface doesn't change.

## Tier 2 Extension Points

The design accommodates future tiers without architectural changes:

- **Tier 2a (baked shadows + AO):** Add `Option` fields to `ChunkPayload`.
  Server computes sun shadow bits and AO values. Shader reads baked data. Fall
  back to real-time tracing for mutated chunks.
- **Tier 2b (light culling):** Add region tags and face connectivity fields.
- **Tier 3 (LLM):** Server replaces `MapConfig` generation with Claude API
  call. LRU cache becomes critical (LLM latency ~500 ms). Same wire format.
