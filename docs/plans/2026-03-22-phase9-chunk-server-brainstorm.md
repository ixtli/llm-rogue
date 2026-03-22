# Phase 9: Chunk Server — Optimization Brainstorm

Pre-planning exploration of framerate optimizations achievable by offloading
computation to a chunk server. Constraint: dynamic point/spot lights remain
fully real-time for game effects.

## Current Per-Frame Budget (Client-Side)

| Component | Cost | GPU? | Notes |
|---|---|---|---|
| Chunk generation (Perlin + MapFeatures) | ~20 µs/chunk | No | Already fast |
| Occupancy bitmask computation | ~500 µs/chunk | No | Scans all 32K voxels |
| Collision map extraction | ~500 µs/chunk | No | Scans all 32K voxels |
| Terrain grid extraction | ~1 ms/chunk | No | Scans all 32K voxels for surfaces |
| GPU texture upload | ~500 µs/chunk | Yes | `queue.write_texture`, batched |
| **Subtotal (4 chunks/frame budget)** | **~10 ms/frame** | | **~60% of 16.6 ms budget** |
| | | | |
| Primary ray DDA traversal | ~5–10 ms/frame | Yes | Per-pixel, three-level DDA |
| Sun shadow rays | ~1–5 ms/frame | Yes | Up to 64 voxels per ray |
| AO sampling (6 rays/hit) | ~1–2 ms/frame | Yes | Short-range occlusion probes |
| Dynamic light evaluation | ~0.5–1 ms/frame | Yes | Radius + cone culling, MAX_LIGHTS_PER_PIXEL=8 |
| Dynamic light shadow rays | Per-light, per-pixel | Yes | Only for lights with shadow bit |
| Sprite billboard rendering | ~1 ms/frame | Yes | Camera-relative quads |
| **Subtotal (GPU render)** | **~8–19 ms/frame** | | |

## What CAN Be Offloaded

### CPU Work (per-chunk precomputation)

Server generates chunk data and precomputes derived structures, sending them
alongside the voxel array. Client skips extraction entirely.

| Computation | Client Savings | Server Payload |
|---|---|---|
| Occupancy bitmask | 500 µs/chunk | 8 bytes |
| Collision map | 500 µs/chunk | 4 KB |
| Terrain grid | 1 ms/chunk | ~4 KB |
| Voxel generation itself | ~20 µs/chunk | 128 KB raw, ~30 KB RLE |
| **Total** | **~2 ms/chunk, ~8 ms/frame** | **~38 KB compressed** |

### GPU Work — Baked Sun Shadows (Tier 2a)

The sun direction is static (or changes very slowly between game phases). The
server can precompute a 1-bit shadow mask per exposed surface voxel — whether
each face is in direct sunlight or shadow from the sun's perspective.

- **Format:** 1 bit per exposed voxel face, packed (~0.5–1 KB/chunk typical)
- **Shader change:** Read baked shadow bit instead of tracing a secondary ray
  through up to `SHADOW_MAX_DIST = 64` voxels of DDA
- **Savings: 1–5 ms/frame GPU** — eliminates the single most expensive
  per-pixel operation for static geometry
- **Invalidation:** Must rebake when terrain mutates (voxel edit mode) or sun
  direction changes. Fall back to real-time shadow rays for mutated chunks.

### GPU Work — Baked Ambient Occlusion (Tier 2a)

AO is purely geometric — how enclosed is each surface? It depends only on
nearby solid voxels, not on camera or light positions.

- **Format:** 6 AO values per exposed voxel face (one per sample direction),
  quantized to u8. ~3–8 KB/chunk typical.
- **Shader change:** Read baked AO instead of casting 6 short-range rays per hit
- **Savings: 1–2 ms/frame GPU**
- **Invalidation:** Same as sun shadows — rebake on terrain mutation, fall back
  to ray-traced AO for dirty chunks.

### Light Culling Metadata (Tier 2b, optional)

With dynamic lights always active, we can still help the shader skip impossible
light-surface pairs:

- **Indoor/outdoor sub-region tags:** Server marks each 8×8×8 sub-region as
  indoor (fully enclosed), outdoor (sky-exposed), or transitional. Dynamic
  lights in enclosed spaces only affect sub-regions they can physically reach.
  Format: 2 bits per sub-region × 64 sub-regions = 16 bytes/chunk.

- **Chunk-face connectivity:** Server precomputes which chunk faces have
  openings (doorways, windows, caves). Stored as 6 bits per chunk (one per
  face). Client uses this as a coarse adjacency graph — a light in chunk A
  can only affect chunk B if there's an open face between them.

- **Savings: 0.5–1 ms/frame** in complex indoor scenes with many lights.
  Negligible benefit for open outdoor terrain.

## What CANNOT Be Offloaded

These are inherently per-frame, camera-dependent, real-time operations:

- **Primary ray DDA traversal** — per-pixel, depends on camera position/angle
- **Dynamic light attenuation & cone math** — changes every frame as lights move
- **Dynamic light shadow rays** — direction depends on pixel position and light
  position, both of which change per frame
- **Sprite billboard rendering** — camera-relative orientation
- **Ray generation** — perspective/ortho projection math

## Proposed Chunk Payload Format

```
ChunkPayload {
  // Tier 1 — minimum viable
  voxels:        [u32; 32768]     // 128 KB raw, ~30 KB RLE-compressed
  occupancy:     u64              // 8 bytes
  collision:     [u8; 4096]       // 4 KB
  terrain_grid:  Vec<u8>          // ~4 KB (column-major surface list)

  // Tier 2a — baked lighting (optional, additive)
  baked_ao:      Vec<u8>          // ~3–8 KB, per exposed face, 6 values each
  sun_shadow:    Vec<u8>          // ~0.5–1 KB, 1 bit per exposed face

  // Tier 2b — light culling hints (optional, additive)
  region_tags:   u64              // 2 bits × 64 sub-regions
  face_openings: [u8; 6]         // per-chunk-face connectivity
}
```

Total payload per chunk: ~42–50 KB compressed (Tier 1 + 2a).

## Tier Summary

### Tier 1 — Minimum Viable Chunk Server

Server returns precomputed `{ voxels, occupancy, collision, terrain_grid }`.
Client deserializes and uploads — no extraction needed. Fallback to local Perlin
if server is unreachable.

- **CPU savings: ~8 ms/frame** (at 4 chunks/frame budget)
- **Enables:** LLM-generated content, deterministic multiplayer seeds
- **Bandwidth:** ~38 KB/chunk compressed, feasible at 10+ Mbps

### Tier 2a — Baked Sun Shadows + Static AO

Server precomputes per-face AO values and sun shadow bits for static terrain.
Shader reads baked data for sun/AO, still traces rays for all dynamic lights.

- **GPU savings: 2–7 ms/frame**
- **Dynamic lights: fully preserved** (per-pixel evaluation + shadow rays)
- **Invalidation:** Dirty-flag per chunk on terrain mutation, fall back to
  real-time tracing for mutated chunks

### Tier 2b — Light Culling Metadata (optional)

Server tags sub-regions and chunk-face connectivity. Client uses hints to reduce
dynamic light evaluation scope.

- **GPU savings: 0.5–1 ms/frame** (indoor scenes only)
- **Low implementation risk,** small payload

### Tier 3 — LLM Integration

MCP client on server queries Claude for terrain generation. Chunk caching
required (LLM latency ~200–500 ms). Server becomes world authority.

- **Latency target:** <500 ms/chunk (cache hits <50 ms)
- **Requires:** prompt design, structured output → voxel conversion, cache layer

## Net Impact (All Tiers)

| Component | Before | After Tier 1 | After Tier 2a | Dynamic lights? |
|---|---|---|---|---|
| Chunk CPU work | ~8 ms/frame | ~0.5 ms/frame | ~0.5 ms/frame | — |
| Sun shadows | 1–5 ms/frame GPU | 1–5 ms (unchanged) | **~0 ms** (baked) | N/A |
| AO | 1–2 ms/frame GPU | 1–2 ms (unchanged) | **~0 ms** (baked) | N/A |
| Point/spot light eval | 0.5–1 ms/frame | 0.5–1 ms | 0.5–1 ms | **Yes, fully dynamic** |
| Light shadow rays | per-light/pixel | per-light/pixel | per-light/pixel | **Yes, fully dynamic** |

**Total potential savings: 10–15 ms/frame** (Tier 1 + 2a combined), enough to
double the effective frame rate on mid-range GPUs or increase view distance.
