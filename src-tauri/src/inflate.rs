//! DEFLATE helpers shared with the storage crate.
//!
//! The implementation lives in `mappa-core` so GeoTIFF elevation tiles and
//! gzip-compressed vector MBTiles use the same decoder.

pub(crate) use mappa_core::inflate::zlib_decompress;
