//! Core primitives shared by the Mappa daemon, CLI and desktop shell.
//!
//! Tile math and bounds are pure functions so they can be tested on the host
//! and reused on ARM64. Provider catalog loading is the only I/O, and it is
//! kept behind [`provider::ProviderCatalog`].

pub mod bbox;
pub mod crs;
pub mod polygon;
pub mod provider;
pub mod tile;

pub use bbox::Bbox;
pub use crs::{Crs, CrsPreset, CrsSpec};
pub use polygon::{
    normalize_ring, point_in_ring, ring_bounds, tile_intersects_ring,
    tile_intersects_ring_with_bounds,
};
pub use provider::{
    Auth, AuthKind, Provider, ProviderCatalog, ProviderError, ProviderKind, RateLimit, TileScheme,
};
pub use tile::{TileCoord, TileRange};
