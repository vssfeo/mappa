//! Minimal zlib (RFC 1950/1951) and gzip (RFC 1952) decoders.
//!
//! GeoTIFF elevation tiles and vector MBTiles use DEFLATE compression. The
//! workspace keeps its dependency set small, so this module implements the
//! subset both formats need: stored, fixed-Huffman and dynamic-Huffman blocks,
//! optional gzip headers, concatenated members and checksum validation.
//!
//! Output is capped by the caller, which also protects against crafted
//! streams expanding far beyond the expected tile size.

const MAX_CODE_BITS: usize = 15;
const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// Decompresses a zlib stream, refusing output larger than `limit` bytes.
pub fn zlib_decompress(input: &[u8], limit: usize) -> Result<Vec<u8>, String> {
    if input.len() < 2 {
        return Err("zlib stream is too short".to_owned());
    }
    let cmf = input[0];
    let flg = input[1];
    if cmf & 0x0f != 8 || cmf >> 4 > 7 {
        return Err("not a DEFLATE zlib stream".to_owned());
    }
    if (u16::from(cmf) << 8 | u16::from(flg)) % 31 != 0 {
        return Err("invalid zlib header checksum".to_owned());
    }
    if flg & 0x20 != 0 {
        return Err("zlib preset dictionaries are not supported".to_owned());
    }

    let mut reader = BitReader::new(&input[2..]);
    let output = inflate(&mut reader, limit)?;
    reader.align();
    let checksum = reader.take_bytes(4)?;
    let expected = u32::from_be_bytes([checksum[0], checksum[1], checksum[2], checksum[3]]);
    if adler32(&output) != expected {
        return Err("zlib payload checksum mismatch".to_owned());
    }
    Ok(output)
}

/// Decompresses one or more concatenated gzip members.
pub fn gzip_decompress(input: &[u8], limit: usize) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut offset = 0usize;
    while offset < input.len() {
        // RFC 1952 permits zero padding after the last member.
        if input[offset..].iter().all(|byte| *byte == 0) {
            break;
        }
        let header = gzip_header(&input[offset..])?;
        let body = offset + header;
        let mut reader = BitReader::new(&input[body..]);
        let start = output.len();
        inflate_into(&mut reader, &mut output, limit)?;
        reader.align();
        let trailer = reader.take_bytes(8)?;
        let expected_crc = u32::from_le_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]);
        let expected_size =
            u32::from_le_bytes([trailer[4], trailer[5], trailer[6], trailer[7]]) as usize;
        let member = &output[start..];
        if crc32(member) != expected_crc {
            return Err("gzip payload checksum mismatch".to_owned());
        }
        if member.len() != expected_size {
            return Err("gzip payload size mismatch".to_owned());
        }
        offset = body + reader.position;
    }
    Ok(output)
}

/// Returns the byte offset of the DEFLATE payload inside a gzip member.
fn gzip_header(data: &[u8]) -> Result<usize, String> {
    if data.len() < 10 {
        return Err("gzip header is truncated".to_owned());
    }
    if data[..2] != GZIP_MAGIC {
        return Err("not a gzip stream".to_owned());
    }
    if data[2] != 8 {
        return Err("unsupported gzip compression method".to_owned());
    }
    let flags = data[3];
    if flags & 0xe0 != 0 {
        return Err("reserved gzip flags are set".to_owned());
    }
    let mut offset = 10usize;
    if flags & 0x04 != 0 {
        let extra = checked_slice(data, offset, 2)?;
        let length = usize::from(u16::from_le_bytes([extra[0], extra[1]]));
        offset = offset
            .checked_add(2 + length)
            .ok_or_else(|| "gzip extra field overflow".to_owned())?;
        checked_slice(data, offset - length, length)?;
    }
    if flags & 0x08 != 0 {
        offset = skip_c_string(data, offset)?;
    }
    if flags & 0x10 != 0 {
        offset = skip_c_string(data, offset)?;
    }
    if flags & 0x02 != 0 {
        checked_slice(data, offset, 2)?;
        offset += 2;
    }
    if offset >= data.len() {
        return Err("gzip header is truncated".to_owned());
    }
    Ok(offset)
}

fn skip_c_string(data: &[u8], start: usize) -> Result<usize, String> {
    let tail = data
        .get(start..)
        .ok_or_else(|| "gzip header is truncated".to_owned())?;
    let length = tail
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| "unterminated gzip header string".to_owned())?;
    start
        .checked_add(length + 1)
        .ok_or_else(|| "gzip header overflow".to_owned())
}

fn checked_slice(data: &[u8], start: usize, count: usize) -> Result<&[u8], String> {
    let end = start
        .checked_add(count)
        .ok_or_else(|| "gzip byte range overflow".to_owned())?;
    data.get(start..end)
        .ok_or_else(|| "gzip header is truncated".to_owned())
}

struct BitReader<'a> {
    data: &'a [u8],
    position: usize,
    buffer: u32,
    buffered_bits: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            position: 0,
            buffer: 0,
            buffered_bits: 0,
        }
    }

    fn bits(&mut self, count: u8) -> Result<u32, String> {
        if count == 0 {
            return Ok(0);
        }
        while self.buffered_bits < count {
            let byte = *self
                .data
                .get(self.position)
                .ok_or_else(|| "truncated DEFLATE stream".to_owned())?;
            self.position += 1;
            self.buffer |= u32::from(byte) << self.buffered_bits;
            self.buffered_bits += 8;
        }
        let mask = (1u32 << count) - 1;
        let value = self.buffer & mask;
        self.buffer >>= count;
        self.buffered_bits -= count;
        Ok(value)
    }

    fn align(&mut self) {
        self.buffer = 0;
        self.buffered_bits = 0;
    }

    fn take_bytes(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .position
            .checked_add(count)
            .ok_or_else(|| "DEFLATE byte range overflow".to_owned())?;
        let bytes = self
            .data
            .get(self.position..end)
            .ok_or_else(|| "truncated DEFLATE stream".to_owned())?;
        self.position = end;
        Ok(bytes)
    }
}

struct Huffman {
    counts: [u16; MAX_CODE_BITS + 1],
    symbols: Vec<u16>,
}

impl Huffman {
    fn from_lengths(lengths: &[u8]) -> Result<Self, String> {
        let mut counts = [0u16; MAX_CODE_BITS + 1];
        for &length in lengths {
            let length = usize::from(length);
            if length > MAX_CODE_BITS {
                return Err("DEFLATE Huffman code is too long".to_owned());
            }
            counts[length] += 1;
        }

        let mut remaining = 1i32;
        for count in counts.iter().skip(1) {
            remaining = (remaining << 1) - i32::from(*count);
            if remaining < 0 {
                return Err("oversubscribed DEFLATE Huffman tree".to_owned());
            }
        }

        let mut offsets = [0u16; MAX_CODE_BITS + 1];
        let mut offset = 0u16;
        for length in 1..=MAX_CODE_BITS {
            offsets[length] = offset;
            offset += counts[length];
        }
        let mut symbols = vec![0u16; lengths.len()];
        for (symbol, &length) in lengths.iter().enumerate() {
            if length > 0 {
                let slot = &mut offsets[usize::from(length)];
                symbols[usize::from(*slot)] = symbol as u16;
                *slot += 1;
            }
        }
        Ok(Self { counts, symbols })
    }

    fn decode(&self, reader: &mut BitReader<'_>) -> Result<u16, String> {
        let mut code = 0u32;
        let mut first = 0u32;
        let mut index = 0usize;
        for length in 1..=MAX_CODE_BITS {
            code |= reader.bits(1)?;
            let count = u32::from(self.counts[length]);
            if code < first + count {
                let symbol = index + (code - first) as usize;
                return self
                    .symbols
                    .get(symbol)
                    .copied()
                    .ok_or_else(|| "invalid DEFLATE Huffman code".to_owned());
            }
            index += count as usize;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err("invalid DEFLATE Huffman code".to_owned())
    }
}

struct Tables {
    literals: Huffman,
    distances: Huffman,
}

fn fixed_tables() -> &'static Tables {
    static TABLES: std::sync::OnceLock<Tables> = std::sync::OnceLock::new();
    TABLES.get_or_init(|| {
        let mut literals = [0u8; 288];
        literals[..144].fill(8);
        literals[144..256].fill(9);
        literals[256..280].fill(7);
        literals[280..].fill(8);
        let distances = [5u8; 32];
        Tables {
            literals: Huffman::from_lengths(&literals).expect("fixed literal table"),
            distances: Huffman::from_lengths(&distances).expect("fixed distance table"),
        }
    })
}

const CODE_LENGTH_ORDER: [usize; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

fn dynamic_tables(reader: &mut BitReader<'_>) -> Result<Tables, String> {
    let literal_count = reader.bits(5)? as usize + 257;
    let distance_count = reader.bits(5)? as usize + 1;
    let code_count = reader.bits(4)? as usize + 4;

    let mut code_lengths = [0u8; 19];
    for &slot in CODE_LENGTH_ORDER.iter().take(code_count) {
        code_lengths[slot] = reader.bits(3)? as u8;
    }
    let code_table = Huffman::from_lengths(&code_lengths)?;

    let total = literal_count + distance_count;
    let mut lengths = vec![0u8; total];
    let mut index = 0usize;
    while index < total {
        match code_table.decode(reader)? {
            value @ 0..=15 => {
                lengths[index] = value as u8;
                index += 1;
            }
            16 => {
                let previous = *lengths
                    .get(index.wrapping_sub(1))
                    .ok_or_else(|| "DEFLATE repeat without previous code".to_owned())?;
                let repeat = 3 + reader.bits(2)? as usize;
                fill_lengths(&mut lengths, index, repeat, previous)?;
                index += repeat;
            }
            17 => {
                let repeat = 3 + reader.bits(3)? as usize;
                fill_lengths(&mut lengths, index, repeat, 0)?;
                index += repeat;
            }
            18 => {
                let repeat = 11 + reader.bits(7)? as usize;
                fill_lengths(&mut lengths, index, repeat, 0)?;
                index += repeat;
            }
            _ => return Err("invalid DEFLATE code-length symbol".to_owned()),
        }
    }

    let literals = Huffman::from_lengths(&lengths[..literal_count])?;
    let distances = Huffman::from_lengths(&lengths[literal_count..])?;
    Ok(Tables {
        literals,
        distances,
    })
}

fn fill_lengths(lengths: &mut [u8], start: usize, count: usize, value: u8) -> Result<(), String> {
    let end = start
        .checked_add(count)
        .ok_or_else(|| "DEFLATE code-length overflow".to_owned())?;
    let target = lengths
        .get_mut(start..end)
        .ok_or_else(|| "DEFLATE code lengths overflow".to_owned())?;
    target.fill(value);
    Ok(())
}

const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

fn inflate(reader: &mut BitReader<'_>, limit: usize) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(limit.min(1024 * 1024));
    inflate_into(reader, &mut output, limit)?;
    Ok(output)
}

fn inflate_into(
    reader: &mut BitReader<'_>,
    output: &mut Vec<u8>,
    limit: usize,
) -> Result<(), String> {
    loop {
        let last = reader.bits(1)? != 0;
        match reader.bits(2)? {
            0 => stored_block(reader, output, limit)?,
            1 => compressed_block(reader, output, limit, fixed_tables())?,
            2 => {
                let tables = dynamic_tables(reader)?;
                compressed_block(reader, output, limit, &tables)?;
            }
            _ => return Err("reserved DEFLATE block type".to_owned()),
        }
        if last {
            return Ok(());
        }
    }
}

fn stored_block(
    reader: &mut BitReader<'_>,
    output: &mut Vec<u8>,
    limit: usize,
) -> Result<(), String> {
    reader.align();
    let header = reader.take_bytes(4)?;
    let length = u16::from_le_bytes([header[0], header[1]]);
    let inverse = u16::from_le_bytes([header[2], header[3]]);
    if length != !inverse {
        return Err("invalid DEFLATE stored block length".to_owned());
    }
    let data = reader.take_bytes(usize::from(length))?;
    if output.len() + data.len() > limit {
        return Err("DEFLATE output exceeds the expected size".to_owned());
    }
    output.extend_from_slice(data);
    Ok(())
}

fn compressed_block(
    reader: &mut BitReader<'_>,
    output: &mut Vec<u8>,
    limit: usize,
    tables: &Tables,
) -> Result<(), String> {
    loop {
        let symbol = tables.literals.decode(reader)?;
        match symbol {
            0..=255 => push_byte(output, symbol as u8, limit)?,
            256 => return Ok(()),
            257..=285 => {
                let index = usize::from(symbol - 257);
                let length =
                    usize::from(LENGTH_BASE[index]) + reader.bits(LENGTH_EXTRA[index])? as usize;
                let distance_symbol = tables.distances.decode(reader)?;
                if distance_symbol > 29 {
                    return Err("invalid DEFLATE distance symbol".to_owned());
                }
                let index = usize::from(distance_symbol);
                let distance = usize::from(DISTANCE_BASE[index])
                    + reader.bits(DISTANCE_EXTRA[index])? as usize;
                copy_match(output, distance, length, limit)?;
            }
            _ => return Err("invalid DEFLATE literal/length symbol".to_owned()),
        }
    }
}

fn push_byte(output: &mut Vec<u8>, value: u8, limit: usize) -> Result<(), String> {
    if output.len() >= limit {
        return Err("DEFLATE output exceeds the expected size".to_owned());
    }
    output.push(value);
    Ok(())
}

fn copy_match(
    output: &mut Vec<u8>,
    distance: usize,
    length: usize,
    limit: usize,
) -> Result<(), String> {
    if distance == 0 || distance > output.len() {
        return Err("invalid DEFLATE back-reference".to_owned());
    }
    if output.len() + length > limit {
        return Err("DEFLATE output exceeds the expected size".to_owned());
    }
    let start = output.len() - distance;
    for index in 0..length {
        let value = output[start + index];
        output.push(value);
    }
    Ok(())
}

fn adler32(data: &[u8]) -> u32 {
    let mut a = 1u32;
    let mut b = 0u32;
    for chunk in data.chunks(5552) {
        for &byte in chunk {
            a += u32::from(byte);
            b += a;
        }
        a %= 65_521;
        b %= 65_521;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (index, slot) in table.iter_mut().enumerate() {
            let mut value = index as u32;
            for _ in 0..8 {
                value = if value & 1 != 0 {
                    (value >> 1) ^ 0xedb8_8320
                } else {
                    value >> 1
                };
            }
            *slot = value;
        }
        table
    });
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc = table[((crc ^ u32::from(byte)) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn decodes_dynamic_fixed_and_stored_blocks() {
        let text = b"the quick brown fox jumps over the lazy dog ".repeat(4);
        let dynamic = hex(
            "78da2bc94855282ccd4cce56482aca2fcf5348cbaf50c82acd2d2856c82f4b2d5228014ae72456552aa4e4a7833903ad1600602e4065",
        );
        assert_eq!(zlib_decompress(&dynamic, 4096).unwrap(), text);

        let fixed = hex("7801cb48cdc9c957c8402701680308b1");
        assert_eq!(
            zlib_decompress(&fixed, 4096).unwrap(),
            b"hello hello hello hello"
        );

        let stored = hex(
            "78010180007fff000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f4ded0fc1",
        );
        let expected: Vec<u8> = (0..64u8).chain(0..64u8).collect();
        assert_eq!(zlib_decompress(&stored, 1024).unwrap(), expected);
    }

    #[test]
    fn decodes_and_validates_gzip_members() {
        // gzip -n of "hello hello hello hello" followed by the same member.
        let member = hex("1f8b08000000000000ffcb48cdc9c957c8402701e3513d8d17000000");
        let mut concatenated = member.clone();
        concatenated.extend_from_slice(&member);
        let expected = b"hello hello hello hello".repeat(2);
        assert_eq!(gzip_decompress(&concatenated, 4096).unwrap(), expected);

        let mut corrupt = member.clone();
        *corrupt.get_mut(12).unwrap() ^= 1;
        assert!(gzip_decompress(&corrupt, 4096).is_err());
        assert!(gzip_decompress(&member, 8).is_err());
    }

    #[test]
    fn rejects_bad_checksum_and_oversized_output() {
        let payload = hex("7801cb48cdc9c957c8402701680308b1");
        let mut corrupt = payload.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        assert!(zlib_decompress(&corrupt, 4096).is_err());
        assert!(zlib_decompress(&payload, 8).is_err());
    }
}
