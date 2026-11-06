//! Optional BitTorrent seeding for packs published in the catalog.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Args;
use librqbit::{AddTorrent, AddTorrentOptions, ListenerOptions, SessionOptions};

#[derive(Debug, Args)]
pub struct SeedArgs {
    /// Path to the .torrent file.
    #[arg(long)]
    pub torrent: PathBuf,
    /// Directory containing the pack file.
    #[arg(long)]
    pub data: PathBuf,
    /// TCP/uTP port for incoming peers.
    #[arg(long, default_value_t = 51413)]
    pub port: u16,
}

pub async fn run(args: SeedArgs) -> Result<()> {
    std::fs::create_dir_all(&args.data)
        .with_context(|| format!("cannot create {}", args.data.display()))?;
    let torrent = std::fs::read(&args.torrent)
        .with_context(|| format!("cannot read {}", args.torrent.display()))?;
    let listen_addr = format!("0.0.0.0:{}", args.port).parse()?;
    let options = SessionOptions {
        listen: Some(ListenerOptions {
            listen_addr,
            ipv4_only: true,
            ..Default::default()
        }),
        ..Default::default()
    };
    let session = librqbit::Session::new_with_opts(args.data.clone(), options).await?;
    session
        .add_torrent(
            AddTorrent::TorrentFileBytes(torrent.into()),
            Some(AddTorrentOptions {
                overwrite: true,
                ..Default::default()
            }),
        )
        .await?;
    eprintln!(
        "seeding {} from {} on port {} (Ctrl-C to stop)",
        args.torrent.display(),
        args.data.display(),
        args.port
    );
    tokio::signal::ctrl_c().await?;
    Ok(())
}
