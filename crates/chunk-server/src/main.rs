use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use clap::Parser;
use engine::chunk_payload::ChunkPayload;
use engine::map_features::MapConfig;
use glam::IVec3;
use lru::LruCache;
use tower_http::cors::CorsLayer;
use tracing::info;

#[derive(Parser)]
#[command(name = "chunk-server", about = "Voxel chunk generation server")]
struct Args {
    /// Port to listen on
    #[arg(long, default_value_t = 3001)]
    port: u16,

    /// World seed (random if omitted)
    #[arg(long)]
    seed: Option<u32>,

    /// Maximum number of cached chunks
    #[arg(long, default_value_t = 4096)]
    cache_size: usize,
}

struct AppState {
    cache: Mutex<LruCache<IVec3, Vec<u8>>>,
    seed: u32,
}

async fn health() -> &'static str {
    "ok"
}

fn parse_coords(s: &str) -> Option<IVec3> {
    let parts: Vec<&str> = s.split(',').collect();
    if parts.len() != 3 {
        return None;
    }
    let cx: i32 = parts[0].parse().ok()?;
    let cy: i32 = parts[1].parse().ok()?;
    let cz: i32 = parts[2].parse().ok()?;
    Some(IVec3::new(cx, cy, cz))
}

async fn get_chunk(
    State(state): State<Arc<AppState>>,
    Path(coords): Path<String>,
) -> impl IntoResponse {
    let Some(coord) = parse_coords(&coords) else {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "text/plain")],
            b"invalid coordinates: expected cx,cy,cz".to_vec(),
        );
    };

    // Check cache first
    {
        let mut cache = state.cache.lock().expect("cache lock poisoned");
        if let Some(bytes) = cache.get(&coord) {
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/octet-stream")],
                bytes.clone(),
            );
        }
    }

    // Generate chunk
    let config = MapConfig::with_seed(state.seed);
    let chunk = config.generate_chunk(coord);
    let payload = ChunkPayload::from_chunk(&chunk, coord);
    let bytes = postcard::to_allocvec(&payload).expect("postcard serialization failed");

    // Store in cache
    {
        let mut cache = state.cache.lock().expect("cache lock poisoned");
        cache.put(coord, bytes.clone());
    }

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        bytes,
    )
}

fn build_app(seed: u32, cache_size: usize) -> Router {
    let state = Arc::new(AppState {
        cache: Mutex::new(LruCache::new(
            NonZeroUsize::new(cache_size).expect("cache_size must be > 0"),
        )),
        seed,
    });

    Router::new()
        .route("/health", get(health))
        .route("/chunks/{coords}", get(get_chunk))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let args = Args::parse();
    let seed = args.seed.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX epoch")
            .subsec_nanos()
    });

    info!(
        port = args.port,
        seed,
        cache_size = args.cache_size,
        "starting chunk server"
    );

    let app = build_app(seed, args.cache_size);
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", args.port))
        .await
        .expect("failed to bind");

    info!(
        "listening on {}",
        listener.local_addr().expect("local addr")
    );
    axum::serve(listener, app).await.expect("server error");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_endpoint_returns_ok() {
        let app = build_app(42, 64);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local addr");

        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let resp = reqwest::get(format!("http://{addr}/health"))
            .await
            .expect("request");
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.text().await.expect("body"), "ok");
    }

    #[tokio::test]
    async fn chunk_endpoint_returns_valid_payload() {
        let seed = 42;
        let app = build_app(seed, 64);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local addr");

        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let resp = reqwest::get(format!("http://{addr}/chunks/0,0,0"))
            .await
            .expect("request");
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("application/octet-stream")
        );

        let bytes = resp.bytes().await.expect("body");
        let payload: ChunkPayload = postcard::from_bytes(&bytes).expect("deserialize payload");

        // Compare against locally generated payload with same seed
        let config = MapConfig::with_seed(seed);
        let coord = IVec3::ZERO;
        let chunk = config.generate_chunk(coord);
        let expected = ChunkPayload::from_chunk(&chunk, coord);

        assert_eq!(payload, expected);
    }

    #[tokio::test]
    async fn cache_returns_identical_bytes() {
        let app = build_app(42, 64);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local addr");

        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let url = format!("http://{addr}/chunks/1,0,-1");
        let bytes1 = reqwest::get(&url)
            .await
            .expect("req1")
            .bytes()
            .await
            .expect("body1");
        let bytes2 = reqwest::get(&url)
            .await
            .expect("req2")
            .bytes()
            .await
            .expect("body2");

        assert_eq!(bytes1, bytes2);
    }
}
