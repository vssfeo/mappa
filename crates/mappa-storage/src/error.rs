//! Storage errors.

/// Result alias for storage operations.
pub type StorageResult<T> = Result<T, StorageError>;

/// Errors produced by cache and pack code.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    /// SQLite failure.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// Filesystem failure.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// A path has no parent directory that can be created.
    #[error("path {0:?} has no parent directory")]
    NoParent(std::path::PathBuf),
    /// A required MBTiles table or column is missing.
    #[error("invalid MBTiles file: {0}")]
    InvalidMbtiles(String),
    /// Coordinates cannot be represented in the expected integer range.
    #[error("coordinate out of range: z={z} x={x} y={y}")]
    CoordinateOutOfRange { z: u8, x: u32, y: u32 },
    /// SQLite accepted the database but not the requested pragma value.
    #[error("pragma: {0}")]
    Pragma(String),
    /// Database schema is newer than this build understands.
    #[error("unsupported cache schema version {0}")]
    UnsupportedSchema(i64),
    /// Download job definition is invalid.
    #[error("invalid download job: {0}")]
    InvalidJob(String),
    /// Tile image cannot be decoded or re-encoded.
    #[error("image: {0}")]
    Image(String),
    /// PMTiles archive error.
    #[error("pmtiles: {0}")]
    Pmtiles(#[from] pmtiles::PmtError),
    /// Stored integer does not fit the requested type.
    #[error("stored value out of range for {0}")]
    ValueOutOfRange(&'static str),
}
