//! MAVLink telemetry over UDP (read-only).
//!
//! Listens on a UDP port (14550 by default), validates MAVLink v1/v2 frames
//! and keeps the latest position plus a recorded track. Nothing is sent to
//! the vehicle: this is a receive-only monitor for the field map.

use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Latest telemetry position.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    pub lat: f64,
    pub lon: f64,
    /// Altitude above mean sea level, metres.
    pub alt_m: f64,
    pub heading_deg: f64,
    pub at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStatus {
    pub running: bool,
    pub port: u16,
    pub frames: u64,
    pub track_points: usize,
    pub fix: Option<Fix>,
    pub last_heartbeat_ms: Option<u64>,
}

struct Inner {
    running: bool,
    port: u16,
    frames: u64,
    fix: Option<Fix>,
    track: Vec<Fix>,
    last_heartbeat_ms: Option<u64>,
}

/// Shared receiver state managed by Tauri.
pub struct Telemetry {
    inner: Arc<Mutex<Inner>>,
    stop: Arc<AtomicBool>,
}

impl Default for Telemetry {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                running: false,
                port: 14550,
                frames: 0,
                fix: None,
                track: Vec::new(),
                last_heartbeat_ms: None,
            })),
            stop: Arc::new(AtomicBool::new(false)),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Telemetry {
    fn start(&self, port: u16) -> Result<(), String> {
        if port < 1024 {
            return Err("choose a port between 1024 and 65535".to_owned());
        }
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "telemetry state is poisoned")?;
            if inner.running {
                return Err("telemetry is already running".to_owned());
            }
            inner.running = true;
            inner.port = port;
        }
        // Fail fast when the port is taken, before the thread starts.
        let socket = UdpSocket::bind(("0.0.0.0", port))
            .map_err(|error| format!("cannot bind UDP {port}: {error}"))?;
        socket
            .set_read_timeout(Some(Duration::from_millis(250)))
            .ok();
        self.stop.store(false, Ordering::Relaxed);

        let inner = Arc::clone(&self.inner);
        let stop = Arc::clone(&self.stop);
        std::thread::spawn(move || {
            let mut buffer = [0_u8; 2048];
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                match socket.recv_from(&mut buffer) {
                    Ok((size, _)) => {
                        if let Some(update) = parse_frame(&buffer[..size])
                            && let Ok(mut state) = inner.lock()
                        {
                            {
                                state.frames += 1;
                                match update {
                                    Update::Heartbeat => {
                                        state.last_heartbeat_ms = Some(now_ms());
                                    }
                                    Update::Fix(fix) => {
                                        if let Some(previous) = state.fix.as_ref() {
                                            let moved = (fix.lat - previous.lat).abs() > 1e-6
                                                || (fix.lon - previous.lon).abs() > 1e-6;
                                            let aged =
                                                fix.at_ms.saturating_sub(previous.at_ms) > 1000;
                                            if moved || aged {
                                                state.track.push(fix.clone());
                                                if state.track.len() > 200_000 {
                                                    state.track.remove(0);
                                                }
                                            }
                                        } else {
                                            state.track.push(fix.clone());
                                        }
                                        state.fix = Some(fix);
                                    }
                                }
                            }
                        }
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            || error.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(_) => break,
                }
            }
            if let Ok(mut state) = inner.lock() {
                state.running = false;
            }
        });
        Ok(())
    }

    fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Ok(mut state) = self.inner.lock() {
            state.running = false;
        }
    }

    fn status(&self) -> TelemetryStatus {
        let state = self.inner.lock().expect("telemetry state");
        TelemetryStatus {
            running: state.running,
            port: state.port,
            frames: state.frames,
            track_points: state.track.len(),
            fix: state.fix.clone(),
            last_heartbeat_ms: state.last_heartbeat_ms,
        }
    }

    fn track(&self) -> Vec<Fix> {
        self.inner
            .lock()
            .map(|state| state.track.clone())
            .unwrap_or_default()
    }

    fn clear(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.track.clear();
            state.fix = None;
            state.frames = 0;
        }
    }
}

enum Update {
    Heartbeat,
    Fix(Fix),
}

/// CRC-16/MCRF4XX used by MAVLink.
fn crc_byte(byte: u8, crc: u16) -> u16 {
    let mut tmp = byte ^ (crc as u8);
    tmp ^= tmp << 4;
    (crc >> 8) ^ ((tmp as u16) << 8) ^ ((tmp as u16) << 3) ^ ((tmp as u16) >> 4)
}

fn crc_extra(msgid: u32) -> Option<u8> {
    match msgid {
        0 => Some(50),   // HEARTBEAT
        33 => Some(104), // GLOBAL_POSITION_INT
        _ => None,
    }
}

fn checksum(bytes: &[u8], extra: u8) -> u16 {
    let mut crc = 0xFFFF_u16;
    for byte in bytes {
        crc = crc_byte(*byte, crc);
    }
    crc_byte(extra, crc)
}

/// Parses one UDP datagram; returns the update it carries, if any.
fn parse_frame(buffer: &[u8]) -> Option<Update> {
    if buffer.len() < 8 {
        return None;
    }
    match buffer[0] {
        0xFD => {
            let payload_len = buffer[1] as usize;
            if buffer.len() < 12 + payload_len {
                return None;
            }
            let msgid =
                u32::from(buffer[7]) | (u32::from(buffer[8]) << 8) | (u32::from(buffer[9]) << 16);
            let extra = crc_extra(msgid)?;
            let expected = u16::from_le_bytes([buffer[10 + payload_len], buffer[11 + payload_len]]);
            if checksum(&buffer[1..10 + payload_len], extra) != expected {
                return None;
            }
            payload_update(msgid, &buffer[10..10 + payload_len])
        }
        0xFE => {
            let payload_len = buffer[1] as usize;
            if buffer.len() < 8 + payload_len {
                return None;
            }
            let msgid = u32::from(buffer[5]);
            let extra = crc_extra(msgid)?;
            let expected = u16::from_le_bytes([buffer[6 + payload_len], buffer[7 + payload_len]]);
            if checksum(&buffer[1..6 + payload_len], extra) != expected {
                return None;
            }
            payload_update(msgid, &buffer[6..6 + payload_len])
        }
        _ => None,
    }
}

fn payload_update(msgid: u32, payload: &[u8]) -> Option<Update> {
    match msgid {
        0 => Some(Update::Heartbeat),
        33 => {
            if payload.len() < 28 {
                return None;
            }
            let lat = i32::from_le_bytes(payload[4..8].try_into().ok()?) as f64 / 1e7;
            let lon = i32::from_le_bytes(payload[8..12].try_into().ok()?) as f64 / 1e7;
            let alt = i32::from_le_bytes(payload[12..16].try_into().ok()?) as f64 / 1000.0;
            let heading = u16::from_le_bytes(payload[26..28].try_into().ok()?) as f64 / 100.0;
            if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
                return None;
            }
            Some(Update::Fix(Fix {
                lat,
                lon,
                alt_m: alt,
                heading_deg: heading,
                at_ms: now_ms(),
            }))
        }
        _ => None,
    }
}

/// Starts the UDP receiver.
#[tauri::command]
pub async fn start_mavlink(
    telemetry: tauri::State<'_, Telemetry>,
    port: Option<u16>,
) -> Result<(), String> {
    telemetry.start(port.unwrap_or(14550))
}

/// Stops the UDP receiver.
#[tauri::command]
pub async fn stop_mavlink(telemetry: tauri::State<'_, Telemetry>) -> Result<(), String> {
    telemetry.stop();
    Ok(())
}

/// Current receiver status.
#[tauri::command]
pub async fn mavlink_status(
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<TelemetryStatus, String> {
    Ok(telemetry.status())
}

/// Recorded track.
#[tauri::command]
pub async fn mavlink_track(telemetry: tauri::State<'_, Telemetry>) -> Result<Vec<Fix>, String> {
    Ok(telemetry.track())
}

/// Clears the fix and the track.
#[tauri::command]
pub async fn mavlink_clear(telemetry: tauri::State<'_, Telemetry>) -> Result<(), String> {
    telemetry.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_v2(msgid: u32, payload: &[u8]) -> Vec<u8> {
        let mut frame = vec![0xFD, payload.len() as u8, 0, 0, 1, 1, 1];
        frame.extend_from_slice(&msgid.to_le_bytes()[..3]);
        frame.extend_from_slice(payload);
        let extra = crc_extra(msgid).unwrap();
        let crc = checksum(&frame[1..], extra);
        frame.extend_from_slice(&crc.to_le_bytes());
        frame
    }

    fn position_payload(lat: f64, lon: f64, alt_m: f64, heading: f64) -> Vec<u8> {
        let mut payload = vec![0_u8; 28];
        let lat_raw = (lat * 1e7) as i32;
        let lon_raw = (lon * 1e7) as i32;
        let alt_raw = (alt_m * 1000.0) as i32;
        let heading_raw = (heading * 100.0) as u16;
        payload[4..8].copy_from_slice(&lat_raw.to_le_bytes());
        payload[8..12].copy_from_slice(&lon_raw.to_le_bytes());
        payload[12..16].copy_from_slice(&alt_raw.to_le_bytes());
        payload[26..28].copy_from_slice(&heading_raw.to_le_bytes());
        payload
    }

    #[test]
    fn parses_a_position_frame() {
        let frame = build_v2(33, &position_payload(44.9521, 34.1023, 512.5, 271.3));
        match parse_frame(&frame) {
            Some(Update::Fix(fix)) => {
                assert!((fix.lat - 44.9521).abs() < 1e-6);
                assert!((fix.lon - 34.1023).abs() < 1e-6);
                assert!((fix.alt_m - 512.5).abs() < 0.01);
                assert!((fix.heading_deg - 271.3).abs() < 0.01);
            }
            _ => panic!("no fix parsed"),
        }
    }

    #[test]
    fn rejects_a_corrupted_frame() {
        let mut frame = build_v2(33, &position_payload(44.9, 34.1, 100.0, 90.0));
        let last = frame.len() - 1;
        frame[last] ^= 0xFF;
        assert!(parse_frame(&frame).is_none());
    }

    #[test]
    fn rejects_unknown_messages_and_short_frames() {
        // msgid 30 is not decoded, so the frame is ignored regardless of CRC.
        let mut unknown = vec![0xFD, 2, 0, 0, 1, 1, 1, 30, 0, 0, 0, 0, 0, 0];
        unknown.truncate(14);
        assert!(parse_frame(&unknown).is_none());
        assert!(parse_frame(&[0xFD, 5]).is_none());
    }

    #[test]
    fn parses_a_heartbeat() {
        let frame = build_v2(0, &[0_u8; 9]);
        assert!(matches!(parse_frame(&frame), Some(Update::Heartbeat)));
    }

    #[test]
    fn parses_a_v1_position_frame() {
        let payload = position_payload(45.0, 35.0, 200.0, 10.0);
        let mut frame = vec![0xFE, payload.len() as u8, 0, 1, 1, 33];
        frame.extend_from_slice(&payload);
        let crc = checksum(&frame[1..], 104);
        frame.extend_from_slice(&crc.to_le_bytes());
        assert!(matches!(parse_frame(&frame), Some(Update::Fix(_))));
    }
}
