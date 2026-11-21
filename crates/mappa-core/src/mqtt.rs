//! Minimal MQTT 3.1.1 subscriber for read-only telemetry.
//!
//! Only what a field map needs: CONNECT, SUBSCRIBE (QoS 0), receive PUBLISH,
//! and PINGREQ keepalives. No TLS, no retained-session tricks, no publishing.
//! The client is deliberately small and dependency-free so it can be tested
//! against a fake broker without pulling an async runtime into the app.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::telemetry::{JsonFix, parse_json_fix};

#[derive(Debug, Clone)]
pub struct MqttConfig {
    pub host: String,
    pub port: u16,
    pub topic: String,
    pub client_id: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub keep_alive_s: u16,
}

impl MqttConfig {
    pub fn new(host: impl Into<String>, port: u16, topic: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            port,
            topic: topic.into(),
            client_id: "mappa-telemetry".to_owned(),
            username: None,
            password: None,
            keep_alive_s: 30,
        }
    }
}

fn push_string(out: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    let len = u16::try_from(bytes.len()).unwrap_or(u16::MAX);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&bytes[..usize::from(len)]);
}

fn push_remaining_length(out: &mut Vec<u8>, mut value: usize) {
    loop {
        let mut byte = (value % 128) as u8;
        value /= 128;
        if value > 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

fn packet(first: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![first];
    push_remaining_length(&mut out, body.len());
    out.extend_from_slice(body);
    out
}

/// CONNECT with a clean session and optional username/password.
pub fn connect_packet(config: &MqttConfig) -> Vec<u8> {
    let mut body = Vec::new();
    push_string(&mut body, "MQTT");
    body.push(4); // protocol level 3.1.1
    let mut flags = 0x02_u8; // clean session
    if config.username.is_some() {
        flags |= 0x80;
    }
    if config.password.is_some() {
        flags |= 0x40;
    }
    body.push(flags);
    body.extend_from_slice(&config.keep_alive_s.to_be_bytes());
    push_string(&mut body, &config.client_id);
    if let Some(username) = &config.username {
        push_string(&mut body, username);
    }
    if let Some(password) = &config.password {
        push_string(&mut body, password);
    }
    packet(0x10, &body)
}

pub fn subscribe_packet(packet_id: u16, topic: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&packet_id.to_be_bytes());
    push_string(&mut body, topic);
    body.push(0); // requested QoS 0
    packet(0x82, &body)
}

pub fn pingreq_packet() -> Vec<u8> {
    vec![0xC0, 0]
}

fn decode_remaining_length(bytes: &[u8], offset: &mut usize) -> Result<usize, String> {
    let mut value = 0_usize;
    let mut multiplier = 1_usize;
    for _ in 0..4 {
        let byte = *bytes
            .get(*offset)
            .ok_or_else(|| "truncated remaining length".to_owned())?;
        *offset += 1;
        value += usize::from(byte & 0x7F) * multiplier;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        multiplier *= 128;
    }
    Err("remaining length is too long".to_owned())
}

/// Reads exactly one MQTT packet, including its fixed header.
pub fn read_packet<R: Read>(reader: &mut R, max: usize) -> Result<Vec<u8>, String> {
    let mut first = [0_u8; 1];
    reader
        .read_exact(&mut first)
        .map_err(|error| format!("mqtt read: {error}"))?;
    let mut header = vec![first[0]];
    let mut length_bytes = Vec::new();
    let mut value = 0_usize;
    let mut multiplier = 1_usize;
    loop {
        let mut byte = [0_u8; 1];
        reader
            .read_exact(&mut byte)
            .map_err(|error| format!("mqtt length: {error}"))?;
        header.push(byte[0]);
        length_bytes.push(byte[0]);
        value += usize::from(byte[0] & 0x7F) * multiplier;
        if byte[0] & 0x80 == 0 {
            break;
        }
        multiplier *= 128;
        if length_bytes.len() > 4 {
            return Err("mqtt remaining length is too long".to_owned());
        }
    }
    if value > max {
        return Err(format!("mqtt packet too large: {value} bytes"));
    }
    let mut body = vec![0_u8; value];
    reader
        .read_exact(&mut body)
        .map_err(|error| format!("mqtt body: {error}"))?;
    header.extend_from_slice(&body);
    Ok(header)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Publish {
    pub topic: String,
    pub payload: Vec<u8>,
    pub qos: u8,
    pub retained: bool,
}

/// Parses a PUBLISH packet (QoS 0, 1 or 2 headers; payload untouched).
pub fn parse_publish(packet: &[u8]) -> Result<Publish, String> {
    if packet.len() < 2 || packet[0] & 0xF0 != 0x30 {
        return Err("not an MQTT PUBLISH".to_owned());
    }
    let qos = (packet[0] >> 1) & 0x03;
    let retained = packet[0] & 0x01 != 0;
    let mut offset = 1;
    let remaining = decode_remaining_length(packet, &mut offset)?;
    let end = offset
        .checked_add(remaining)
        .filter(|end| *end <= packet.len())
        .ok_or_else(|| "truncated PUBLISH".to_owned())?;
    if end < offset + 2 {
        return Err("PUBLISH has no topic".to_owned());
    }
    let topic_len = usize::from(u16::from_be_bytes([packet[offset], packet[offset + 1]]));
    offset += 2;
    if offset + topic_len > end {
        return Err("truncated PUBLISH topic".to_owned());
    }
    let topic = String::from_utf8(packet[offset..offset + topic_len].to_vec())
        .map_err(|_| "PUBLISH topic is not UTF-8".to_owned())?;
    offset += topic_len;
    if qos > 0 {
        if offset + 2 > end {
            return Err("PUBLISH has no packet id".to_owned());
        }
        offset += 2;
    }
    Ok(Publish {
        topic,
        payload: packet[offset..end].to_vec(),
        qos,
        retained,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Runs a single MQTT connection until `stop` is set or the socket fails.
/// Calls `on_fix` for every valid telemetry payload; other topics are ignored.
pub fn run_mqtt<F>(config: &MqttConfig, stop: &AtomicBool, mut on_fix: F) -> Result<(), String>
where
    F: FnMut(JsonFix),
{
    let address = format!("{}:{}", config.host, config.port);
    let mut stream = TcpStream::connect(&address)
        .map_err(|error| format!("cannot connect to MQTT broker {address}: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| format!("mqtt timeout: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| format!("mqtt write timeout: {error}"))?;
    stream
        .write_all(&connect_packet(config))
        .map_err(|error| format!("mqtt CONNECT: {error}"))?;
    let connack = read_packet(&mut stream, 64)?;
    if connack.len() < 4 || connack[0] & 0xF0 != 0x20 || connack[3] != 0 {
        return Err("MQTT broker rejected the connection".to_owned());
    }
    stream
        .write_all(&subscribe_packet(1, &config.topic))
        .map_err(|error| format!("mqtt SUBSCRIBE: {error}"))?;

    let mut last_ping = Instant::now();
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        if last_ping.elapsed() >= Duration::from_secs(u64::from(config.keep_alive_s.max(5))) {
            stream
                .write_all(&pingreq_packet())
                .map_err(|error| format!("mqtt PINGREQ: {error}"))?;
            last_ping = Instant::now();
        }
        let packet = match read_packet(&mut stream, 1_048_576) {
            Ok(packet) => packet,
            Err(error)
                if error.contains("timed out")
                    || error.contains("WouldBlock")
                    || error.contains("Resource temporarily unavailable") =>
            {
                continue;
            }
            Err(error)
                if error.contains("failed to fill whole buffer")
                    && stop.load(Ordering::Relaxed) =>
            {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        match packet[0] & 0xF0 {
            0x30 => {
                let publish = parse_publish(&packet)?;
                if topic_matches(&config.topic, &publish.topic)
                    && let Ok(fix) = parse_json_fix(
                        std::str::from_utf8(&publish.payload).unwrap_or(""),
                        now_ms(),
                    )
                {
                    on_fix(fix);
                }
            }
            0x90 | 0xD0 => {}
            _ => {}
        }
    }
}

/// MQTT wildcard match for `+` and `#`, enough for telemetry topics.
pub fn topic_matches(filter: &str, topic: &str) -> bool {
    let filter_parts: Vec<&str> = filter.split('/').collect();
    let topic_parts: Vec<&str> = topic.split('/').collect();
    for (index, part) in filter_parts.iter().enumerate() {
        if *part == "#" {
            return true;
        }
        match topic_parts.get(index) {
            Some(value) if *part == "+" || part == value => {}
            _ => return false,
        }
    }
    filter_parts.len() == topic_parts.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn builds_connect_and_subscribe_packets() {
        let mut config = MqttConfig::new("127.0.0.1", 1883, "mappa/fix");
        config.username = Some("u".to_owned());
        config.password = Some("p".to_owned());
        let connect = connect_packet(&config);
        assert_eq!(connect[0], 0x10);
        assert!(connect.windows(5).any(|window| window == b"MQTT\x04"));
        let subscribe = subscribe_packet(1, "mappa/fix");
        assert_eq!(subscribe[0], 0x82);
        assert!(subscribe.windows(9).any(|window| window == b"mappa/fix"));
    }

    #[test]
    fn parses_publish_with_qos_and_topic() {
        let mut body = Vec::new();
        push_string(&mut body, "mappa/fix");
        body.extend_from_slice(br#"{"lat":44.9,"lon":34.1,"alt":100}"#);
        let packet = packet(0x30, &body);
        let publish = parse_publish(&packet).expect("publish");
        assert_eq!(publish.topic, "mappa/fix");
        assert_eq!(publish.qos, 0);
        assert!(publish.payload.starts_with(b"{"));
    }

    #[test]
    fn matches_mqtt_wildcards() {
        assert!(topic_matches("mappa/+/fix", "mappa/uav/fix"));
        assert!(topic_matches("mappa/#", "mappa/uav/fix"));
        assert!(!topic_matches("mappa/+/fix", "mappa/uav/telemetry"));
        assert!(!topic_matches("mappa/fix", "mappa/uav/fix"));
    }

    #[test]
    fn reads_packets_from_a_reader() {
        let mut cursor = Cursor::new(vec![0x20, 0x02, 0x00, 0x00]);
        let packet = read_packet(&mut cursor, 64).expect("packet");
        assert_eq!(packet, vec![0x20, 0x02, 0x00, 0x00]);
    }

    #[test]
    fn receives_a_fix_from_a_fake_broker() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let port = listener.local_addr().expect("addr").port();
        let stop = Arc::new(AtomicBool::new(false));
        let broker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let connect = read_packet(&mut socket, 4096).expect("connect");
            assert_eq!(connect[0], 0x10);
            socket
                .write_all(&[0x20, 0x02, 0x00, 0x00])
                .expect("connack");
            let subscribe = read_packet(&mut socket, 4096).expect("subscribe");
            assert_eq!(subscribe[0], 0x82);
            socket
                .write_all(&[0x90, 0x03, 0x00, 0x01, 0x00])
                .expect("suback");
            let mut body = Vec::new();
            push_string(&mut body, "mappa/fix");
            body.extend_from_slice(br#"{"lat":44.9,"lon":34.1,"alt_m":120,"heading":90}"#);
            socket.write_all(&packet(0x30, &body)).expect("publish");
            thread::sleep(Duration::from_secs(2));
        });
        let (sender, receiver) = mpsc::channel();
        let client_stop = Arc::clone(&stop);
        let config = MqttConfig::new("127.0.0.1", port, "mappa/fix");
        let client = thread::spawn(move || {
            run_mqtt(&config, &client_stop, |fix| {
                let _ = sender.send(fix);
            })
        });
        let fix = receiver.recv_timeout(Duration::from_secs(2)).expect("fix");
        assert_eq!(fix.lat, 44.9);
        assert_eq!(fix.heading_deg, 90.0);
        stop.store(true, Ordering::Relaxed);
        client.join().expect("client").expect("run mqtt");
        broker.join().expect("broker");
    }
}
