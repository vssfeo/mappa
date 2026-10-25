//! External GNSS streams over TCP: NMEA 0183 and gpsd JSON.
//!
//! The frontend owns parsing, recording and presentation; this module only
//! keeps the socket alive and forwards complete lines. A receiver exposed
//! through `socat`, a serial-to-TCP bridge or a local gpsd looks the same to
//! the rest of the app as the built-in simulator.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, watch};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const RETRY_DELAY: Duration = Duration::from_secs(3);
const READ_CHUNK: usize = 4096;
const MAX_PENDING: usize = 64 * 1024;
const MAX_NMEA_LINE: usize = 512;
const MAX_GPSD_LINE: usize = 32 * 1024;
const GPSD_WATCH: &[u8] = b"?WATCH={\"enable\":true,\"json\":true};\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Protocol {
    Nmea,
    Gpsd,
}

impl Protocol {
    fn name(self) -> &'static str {
        match self {
            Self::Nmea => "NMEA",
            Self::Gpsd => "gpsd",
        }
    }

    fn line_event(self) -> &'static str {
        match self {
            Self::Nmea => "nmea://line",
            Self::Gpsd => "gpsd://line",
        }
    }

    fn state_event(self) -> &'static str {
        match self {
            Self::Nmea => "nmea://state",
            Self::Gpsd => "gpsd://state",
        }
    }

    fn accepts(self, line: &str) -> bool {
        match self {
            Self::Nmea => line.starts_with('$'),
            Self::Gpsd => line.starts_with('{'),
        }
    }

    fn max_line(self) -> usize {
        match self {
            Self::Nmea => MAX_NMEA_LINE,
            Self::Gpsd => MAX_GPSD_LINE,
        }
    }

    fn handshake(self) -> Option<&'static [u8]> {
        match self {
            Self::Nmea => None,
            Self::Gpsd => Some(GPSD_WATCH),
        }
    }
}

/// Connection state sent to the GPS panel.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamState {
    /// `connecting`, `connected` or `error`.
    pub status: &'static str,
    pub host: String,
    pub port: u16,
    pub message: Option<String>,
}

/// Holds the stop channel for the one active TCP reader.
#[derive(Default)]
pub struct GnssTcp {
    stop: Mutex<Option<watch::Sender<bool>>>,
}

#[tauri::command]
pub async fn start_nmea_tcp(
    app: AppHandle,
    state: State<'_, GnssTcp>,
    host: String,
    port: u16,
) -> Result<(), String> {
    start_stream(app, state, host, port, Protocol::Nmea).await
}

#[tauri::command]
pub async fn stop_nmea_tcp(state: State<'_, GnssTcp>) -> Result<(), String> {
    stop_stream(state).await
}

#[tauri::command]
pub async fn start_gpsd_tcp(
    app: AppHandle,
    state: State<'_, GnssTcp>,
    host: String,
    port: u16,
) -> Result<(), String> {
    start_stream(app, state, host, port, Protocol::Gpsd).await
}

#[tauri::command]
pub async fn stop_gpsd_tcp(state: State<'_, GnssTcp>) -> Result<(), String> {
    stop_stream(state).await
}

async fn start_stream(
    app: AppHandle,
    state: State<'_, GnssTcp>,
    host: String,
    port: u16,
    protocol: Protocol,
) -> Result<(), String> {
    let host = validate_endpoint(&host, port, protocol)?;
    let (stop, receiver) = watch::channel(false);
    {
        let mut current = state.stop.lock().await;
        if let Some(previous) = current.replace(stop) {
            let _ = previous.send(true);
        }
    }
    tauri::async_runtime::spawn(run_loop(app, host, port, protocol, receiver));
    Ok(())
}

async fn stop_stream(state: State<'_, GnssTcp>) -> Result<(), String> {
    if let Some(stop) = state.stop.lock().await.take() {
        let _ = stop.send(true);
    }
    Ok(())
}

/// Restricts the endpoint to a hostname or IP literal and a usable port.
fn validate_endpoint(host: &str, port: u16, protocol: Protocol) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err(format!("{} host is empty", protocol.name()));
    }
    if host.len() > 253 {
        return Err(format!("{} host is too long", protocol.name()));
    }
    if !host.chars().all(|character| {
        character.is_ascii_alphanumeric()
            || matches!(character, '.' | '-' | '_' | ':' | '%' | '[' | ']')
    }) {
        return Err(format!(
            "{} host contains unsupported characters",
            protocol.name()
        ));
    }
    if port == 0 {
        return Err("GNSS port must be between 1 and 65535".into());
    }
    Ok(host.to_string())
}

fn emit_state(
    app: &AppHandle,
    host: &str,
    port: u16,
    protocol: Protocol,
    status: &'static str,
    message: Option<String>,
) {
    let event = StreamState {
        status,
        host: host.to_string(),
        port,
        message,
    };
    if let Err(error) = app.emit(protocol.state_event(), event) {
        log::warn!("cannot emit {} state: {error}", protocol.name());
    }
}

async fn run_loop(
    app: AppHandle,
    host: String,
    port: u16,
    protocol: Protocol,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        if *stop.borrow() {
            return;
        }
        emit_state(&app, &host, port, protocol, "connecting", None);
        let connect = tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return;
                }
                continue;
            }
            result = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host.as_str(), port))) => result,
        };
        let mut stream = match connect {
            Ok(Ok(stream)) => stream,
            Ok(Err(error)) => {
                emit_state(
                    &app,
                    &host,
                    port,
                    protocol,
                    "error",
                    Some(short_error(error)),
                );
                if wait_or_stop(&mut stop).await {
                    return;
                }
                continue;
            }
            Err(_) => {
                emit_state(
                    &app,
                    &host,
                    port,
                    protocol,
                    "error",
                    Some("connect timed out".into()),
                );
                if wait_or_stop(&mut stop).await {
                    return;
                }
                continue;
            }
        };
        if let Some(request) = protocol.handshake() {
            let written = tokio::select! {
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        return;
                    }
                    continue;
                }
                result = stream.write_all(request) => result,
            };
            if let Err(error) = written {
                emit_state(
                    &app,
                    &host,
                    port,
                    protocol,
                    "error",
                    Some(short_error(error)),
                );
                if wait_or_stop(&mut stop).await {
                    return;
                }
                continue;
            }
        }
        emit_state(&app, &host, port, protocol, "connected", None);
        let result = pump(&mut stream, &mut stop, protocol, |line| {
            if let Err(error) = app.emit(protocol.line_event(), line) {
                log::warn!("cannot emit {} line: {error}", protocol.name());
            }
        })
        .await;
        match result {
            Pump::Stopped => return,
            Pump::Eof => emit_state(
                &app,
                &host,
                port,
                protocol,
                "error",
                Some("stream closed".into()),
            ),
            Pump::Failed(message) => {
                emit_state(&app, &host, port, protocol, "error", Some(message));
            }
        }
        if wait_or_stop(&mut stop).await {
            return;
        }
    }
}

enum Pump {
    Stopped,
    Eof,
    Failed(String),
}

async fn pump<F>(
    stream: &mut TcpStream,
    stop: &mut watch::Receiver<bool>,
    protocol: Protocol,
    mut on_line: F,
) -> Pump
where
    F: FnMut(String),
{
    let mut buffer = [0u8; READ_CHUNK];
    let mut pending = Vec::with_capacity(READ_CHUNK);
    loop {
        let read = tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return Pump::Stopped;
                }
                continue;
            }
            result = stream.read(&mut buffer) => result,
        };
        match read {
            Ok(0) => return Pump::Eof,
            Ok(count) => {
                pending.extend_from_slice(&buffer[..count]);
                for line in take_lines(&mut pending, protocol) {
                    on_line(line);
                }
                // A device that never sends a newline must not grow the
                // buffer without bound.
                if pending.len() > MAX_PENDING {
                    pending.clear();
                }
            }
            Err(error) => return Pump::Failed(short_error(error)),
        }
    }
}

async fn wait_or_stop(stop: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(RETRY_DELAY) => *stop.borrow(),
        changed = stop.changed() => changed.is_err() || *stop.borrow(),
    }
}

fn short_error(error: impl std::fmt::Display) -> String {
    error.to_string().chars().take(200).collect()
}

/// Splits complete lines out of a growing byte buffer.
///
/// Accepts CRLF and lone CR/LF, keeps only lines that belong to the selected
/// protocol, drops overlong lines, and keeps an incomplete tail for the next
/// read. gpsd SKY reports can be much longer than NMEA sentences.
fn take_lines(pending: &mut Vec<u8>, protocol: Protocol) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(index) = pending
        .iter()
        .position(|byte| *byte == b'\n' || *byte == b'\r')
    {
        let separator = pending[index];
        let mut end = index + 1;
        if separator == b'\r' && pending.get(end) == Some(&b'\n') {
            end += 1;
        }
        let content = &pending[..index];
        let parsed = if content.len() <= protocol.max_line() {
            std::str::from_utf8(content)
                .ok()
                .map(str::trim)
                .filter(|line| protocol.accepts(line))
                .map(str::to_string)
        } else {
            None
        };
        pending.drain(..end);
        if let Some(line) = parsed {
            lines.push(line);
        }
    }
    if pending.len() > MAX_PENDING {
        pending.clear();
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_hosts_and_ports() {
        assert_eq!(
            validate_endpoint(" 127.0.0.1 ", 10110, Protocol::Nmea).unwrap(),
            "127.0.0.1"
        );
        assert!(validate_endpoint("", 10110, Protocol::Nmea).is_err());
        assert!(validate_endpoint("host name", 10110, Protocol::Nmea).is_err());
        assert!(validate_endpoint("host/path", 10110, Protocol::Gpsd).is_err());
        assert!(validate_endpoint("localhost", 0, Protocol::Gpsd).is_err());
    }

    #[test]
    fn frames_crlf_and_keeps_a_partial_tail() {
        let mut pending = b"$GPGGA,1*00\r\n$GPRMC,2*00".to_vec();
        assert_eq!(
            take_lines(&mut pending, Protocol::Nmea),
            vec!["$GPGGA,1*00"]
        );
        assert_eq!(pending, b"$GPRMC,2*00");
        pending.extend_from_slice(b"\r\n$GPVTG,3*00\n");
        assert_eq!(
            take_lines(&mut pending, Protocol::Nmea),
            vec!["$GPRMC,2*00", "$GPVTG,3*00"]
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn accepts_lone_cr_and_drops_noise() {
        let mut pending = b"noise\r$GPGGA,1*00\r$GPRMC,2*00".to_vec();
        assert_eq!(
            take_lines(&mut pending, Protocol::Nmea),
            vec!["$GPGGA,1*00"]
        );
        assert_eq!(pending, b"$GPRMC,2*00");
    }

    #[test]
    fn drops_overlong_lines_without_leaving_data_behind() {
        let mut pending = vec![b'$'; MAX_NMEA_LINE + 1];
        pending.extend_from_slice(b"\r\n$GPGGA,1*00\r\n");
        assert_eq!(
            take_lines(&mut pending, Protocol::Nmea),
            vec!["$GPGGA,1*00"]
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn gpsd_lines_allow_large_sky_reports_and_skip_other_text() {
        let mut pending = b"VERSION\r\n{\"class\":\"TPV\",\"mode\":3}\r\n".to_vec();
        assert_eq!(
            take_lines(&mut pending, Protocol::Gpsd),
            vec!["{\"class\":\"TPV\",\"mode\":3}"]
        );
        let mut sky = vec![b'{'; MAX_GPSD_LINE];
        sky.extend_from_slice(b"\r\n");
        assert_eq!(take_lines(&mut sky, Protocol::Gpsd).len(), 1);
    }

    #[test]
    fn gpsd_handshake_requests_json_reports() {
        assert_eq!(
            Protocol::Gpsd.handshake(),
            Some(b"?WATCH={\"enable\":true,\"json\":true};\n".as_slice())
        );
        assert_eq!(Protocol::Nmea.handshake(), None);
    }

    #[tokio::test]
    async fn reads_sentences_from_a_tcp_peer() {
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(b"$GPGGA,1*00\r\n$GPRMC,2*00\n")
                .await
                .unwrap();
            socket.shutdown().await.unwrap();
        });

        let mut stream = TcpStream::connect(address).await.unwrap();
        let (_stop, mut receiver) = watch::channel(false);
        let mut lines = Vec::new();
        let result = pump(&mut stream, &mut receiver, Protocol::Nmea, |line| {
            lines.push(line)
        })
        .await;
        server.await.unwrap();

        assert!(matches!(result, Pump::Eof));
        assert_eq!(lines, vec!["$GPGGA,1*00", "$GPRMC,2*00"]);
    }
}
