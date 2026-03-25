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
│  Perlin generation          │
│  Precomputes: occupancy,    │
│    collision, terrain grid   │
│  In-memory LRU cache        │
│  Cap'n Proto response       │
└──────────────┬──────────────┘
               │ HTTP (localhost or remote)
               ▼
┌──────────────────────────────────────────────┐
│  Render Worker (Rust/WASM)                   │
│  ChunkManager state machine per chunk:       │
│  Empty → Fetching → Ready (or FallbackLocal) │
│  Browser fetch() via wasm-bindgen-futures    │
│  Deserialize Cap'n Proto (zero-copy)         │
│  Upload voxels to GPU atlas                  │
│  Use precomputed occupancy/collision/terrain  │
│  Emit chunk_terrain to game worker           │
└──────────────────────────────────────────────┘
```

No changes to the game worker or UI thread. They continue receiving
`chunk_terrain` messages exactly as before.

## Chunk Server Binary

New Rust crate: `crates/chunk-server/`. Depends on `engine` crate (native, not
WASM) for `Chunk`, `CollisionMap`, `TerrainGrid`, and occupancy computation.

### Endpoints

- `GET /chunks/{cx},{cy},{cz}` — Cap'n Proto serialized `ChunkPayload`
- `GET /health` — liveness check for deployment probes and client connectivity

### Generation Flow

1. Check LRU cache for `(cx, cy, cz)`
2. Cache miss → `Chunk::new_terrain_at(seed, coord)`, compute occupancy,
   collision map, terrain grid
3. Serialize to Cap'n Proto, store in cache, return response

### Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 3001 | Listen port |
| `--seed` | random | World generation seed |
| `--cache-size` | 4096 | Max cached chunks (~160 MB at ~40 KB each) |

CORS: `Access-Control-Allow-Origin: *` for Tier 1.

### Dependencies

`axum`, `tokio`, `capnpc-rust`, `lru`, plus `engine` crate (native).

### Run Command

```bash
cargo run -p chunk-server
cargo run -p chunk-server -- --port 3001 --seed 42
```

## Cap'n Proto Schema

Shared schema file at `schema/chunk.capnp`:

```capnp
@0xabcdef1234567890;

struct ChunkPayload {
  cx @0 :Int32;
  cy @1 :Int32;
  cz @2 :Int32;
  voxels @3 :Data;          # 32768 × 4 bytes = 128 KB
  occupancy @4 :UInt64;     # 64-bit bitmask
  collision @5 :Data;       # 4096 bytes (1 bit/voxel, packed)
  terrainGrid @6 :Data;     # variable, existing serialization format
}
```

Both `crates/chunk-server/` and `crates/engine/` generate Rust bindings from
this schema at build time via `capnpc-rust` in `build.rs`.

### Design Choices

- `voxels` is `Data` (raw bytes) not `List(UInt32)` — avoids per-element
  overhead, client interprets buffer directly
- `terrainGrid` reuses existing binary format from `terrain_grid.rs`
  (column-major `[count, [y, terrainId, headroom] × count]`)
- Schema extensible for Tier 2a: add `bakedAo @7 :Data` and
  `sunShadow @8 :Data` later. Old clients ignore unknown fields.

## Client-Side Integration

### Chunk State Machine

```
Empty → Fetching → Ready
  │                  ↑
  └──→ FallbackLocal─┘  (on fetch failure)
```

### ChunkManager Changes

- New field: `server_url: Option<String>` — `None` = pure offline mode
  (existing behavior unchanged)
- New field: `pending_fetches: HashMap<IVec3, JsFuture>` — in-flight requests
- `tick_budgeted` change: if `server_url` is set, initiate `fetch()` for each
  needed chunk (up to budget). Each fetch is a `JsFuture` polled on subsequent
  ticks.
- On fetch success: deserialize Cap'n Proto, upload voxels to atlas, use
  precomputed occupancy/collision/terrain directly (skip all extraction). Emit
  `chunk_terrain`.
- On fetch failure: log warning, fall back to `Chunk::new_terrain_at` + local
  extraction. Mark chunk as `FallbackLocal`.

### Connectivity Tracking

- Track consecutive fetch failures. After 5 failures, switch to offline mode —
  stop making requests, generate all chunks locally.
- Every 30 seconds, try one probe fetch. If it succeeds, resume server mode.
- Report server status (online/offline/degraded) in stats pipeline.

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

Stats pipeline additions (following existing 6-step pattern):

| Stat | Type | Description |
|------|------|-------------|
| `chunk_source` | string | Current mode: "server", "local", "offline" |
| `server_chunks_loaded` | number | Chunks loaded from server this session |
| `fallback_chunks_loaded` | number | Chunks that fell back to local |
| `fetch_latency_ms` | number | Rolling average fetch round-trip |

Displayed in diagnostics overlay (~). Server-side logs: request coord, cache
hit/miss, generation time, response size.

## Testing

### Server (native Rust, `crates/chunk-server/`)

- Generate chunk via endpoint, deserialize response, verify
  voxels/occupancy/collision/terrain match local `engine` computation
- LRU cache: same coord returns identical bytes, eviction works

### Client (engine crate)

- Deserialize Cap'n Proto `ChunkPayload`, verify precomputed fields used
  directly (no extraction called)
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

- **Tier 2a (baked shadows + AO):** Add fields to Cap'n Proto schema. Server
  computes sun shadow bits and AO values. Shader reads baked data. Fall back
  to real-time tracing for mutated chunks.
- **Tier 2b (light culling):** Add region tags and face connectivity to schema.
- **Tier 3 (LLM):** Server replaces Perlin with Claude API call. LRU cache
  becomes critical (LLM latency ~500 ms). Same wire format.
