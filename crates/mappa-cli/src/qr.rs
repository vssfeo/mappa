//! Minimal QR Code encoder for LAN connection links.
//!
//! Byte mode, error correction level M, versions 1–10. The encoder follows
//! ISO/IEC 18004: data codewords, Reed–Solomon blocks, masking and format
//! information are generated locally so the CLI has no runtime dependency.

const TOTAL_CODEWORDS: [usize; 11] = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ECC_PER_BLOCK_M: [usize; 11] = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M: [usize; 11] = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGNMENT: [&[usize]; 11] = [
    &[],
    &[],
    &[6, 18],
    &[6, 22],
    &[6, 26],
    &[6, 30],
    &[6, 34],
    &[6, 22, 38],
    &[6, 24, 42],
    &[6, 26, 46],
    &[6, 28, 50],
];

#[derive(Debug, Clone)]
pub struct QrCode {
    pub size: usize,
    pub modules: Vec<bool>,
    pub version: u8,
    pub mask: u8,
}

impl QrCode {
    pub fn dark(&self, x: usize, y: usize) -> bool {
        self.modules[y * self.size + x]
    }

    /// SVG with a four-module quiet zone; usable in terminal-free contexts.
    pub fn svg(&self) -> String {
        const BORDER: usize = 4;
        let size = self.size + BORDER * 2;
        let mut path = String::new();
        for y in 0..self.size {
            for x in 0..self.size {
                if self.dark(x, y) {
                    path.push_str(&format!("M{} {}h1v1h-1z", x + BORDER, y + BORDER));
                }
            }
        }
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" \
             width=\"320\" height=\"320\" shape-rendering=\"crispEdges\">\n\
             <rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>\n\
             <path fill=\"#000000\" d=\"{path}\"/>\n\
             </svg>\n"
        )
    }

    /// Half-block terminal rendering with an ANSI black/white palette.
    pub fn terminal(&self) -> String {
        const BORDER: usize = 4;
        let size = self.size + BORDER * 2;
        let dark = |x: usize, y: usize| {
            if x < BORDER || y < BORDER || x >= BORDER + self.size || y >= BORDER + self.size {
                return false;
            }
            self.dark(x - BORDER, y - BORDER)
        };
        let mut out = String::new();
        let mut y = 0;
        while y < size {
            for x in 0..size {
                let top = dark(x, y);
                let bottom = if y + 1 < size { dark(x, y + 1) } else { false };
                let (fg, bg) = match (top, bottom) {
                    (true, true) => ("0;0;0", "0;0;0"),
                    (true, false) => ("0;0;0", "255;255;255"),
                    (false, true) => ("255;255;255", "0;0;0"),
                    (false, false) => ("255;255;255", "255;255;255"),
                };
                out.push_str(&format!("\x1b[38;2;{fg}m\x1b[48;2;{bg}m▀"));
            }
            out.push_str("\x1b[0m\n");
            y += 2;
        }
        out
    }
}

pub fn encode(text: &str) -> Result<QrCode, String> {
    let bytes = text.as_bytes();
    for version in 1..=10usize {
        let data_codewords =
            TOTAL_CODEWORDS[version] - ECC_PER_BLOCK_M[version] * BLOCKS_M[version];
        let count_bits = if version <= 9 { 8 } else { 16 };
        let needed = 4 + count_bits + bytes.len() * 8;
        if needed <= data_codewords * 8 {
            return build(version, bytes, data_codewords);
        }
    }
    Err("QR payload is too long".to_owned())
}

fn build(version: usize, bytes: &[u8], data_codewords: usize) -> Result<QrCode, String> {
    let mut bits = BitBuffer::default();
    bits.push(0b0100, 4);
    bits.push(bytes.len() as u32, if version <= 9 { 8 } else { 16 });
    for &byte in bytes {
        bits.push(u32::from(byte), 8);
    }
    let capacity = data_codewords * 8;
    let terminator = 4.min(capacity.saturating_sub(bits.len()));
    bits.push(0, terminator);
    while bits.len() % 8 != 0 {
        bits.push(0, 1);
    }
    let mut data = bits.into_bytes();
    let mut pad = 0;
    while data.len() < data_codewords {
        data.push(if pad % 2 == 0 { 0xEC } else { 0x11 });
        pad += 1;
    }

    let mut blocks = split_blocks(version, &data);
    let ec_len = ECC_PER_BLOCK_M[version];
    let generator = rs_generator(ec_len);
    let ecc: Vec<Vec<u8>> = blocks
        .iter()
        .map(|block| rs_remainder(block, &generator, ec_len))
        .collect();
    let mut codewords = Vec::with_capacity(TOTAL_CODEWORDS[version]);
    let max_data = blocks.iter().map(Vec::len).max().unwrap_or(0);
    for index in 0..max_data {
        for block in &blocks {
            if let Some(&byte) = block.get(index) {
                codewords.push(byte);
            }
        }
    }
    for index in 0..ec_len {
        for block in &ecc {
            codewords.push(block[index]);
        }
    }
    blocks.clear();

    let size = version * 4 + 17;
    let mut matrix = Matrix::new(size);
    matrix.draw_finders();
    matrix.draw_timing();
    matrix.draw_alignment(version);
    matrix.reserve_format();
    matrix.draw_version(version);
    matrix.draw_data(&codewords);

    let mut best: Option<(u32, u8, Matrix)> = None;
    for mask in 0..8u8 {
        let mut candidate = matrix.clone();
        candidate.apply_mask(mask);
        candidate.draw_format(mask);
        let penalty = candidate.penalty();
        if best.as_ref().is_none_or(|(score, _, _)| penalty < *score) {
            best = Some((penalty, mask, candidate));
        }
    }
    let (_, mask, matrix) = best.ok_or_else(|| "QR mask selection failed".to_owned())?;
    Ok(QrCode {
        size,
        modules: matrix.modules,
        version: version as u8,
        mask,
    })
}

fn split_blocks(version: usize, data: &[u8]) -> Vec<Vec<u8>> {
    let blocks = BLOCKS_M[version];
    let short_len = data.len() / blocks;
    let long_blocks = data.len() % blocks;
    let short_blocks = blocks - long_blocks;
    let mut result = Vec::with_capacity(blocks);
    let mut offset = 0;
    for _ in 0..short_blocks {
        result.push(data[offset..offset + short_len].to_vec());
        offset += short_len;
    }
    for _ in 0..long_blocks {
        result.push(data[offset..offset + short_len + 1].to_vec());
        offset += short_len + 1;
    }
    result
}

#[derive(Default)]
struct BitBuffer {
    bits: Vec<bool>,
}

impl BitBuffer {
    fn len(&self) -> usize {
        self.bits.len()
    }

    fn push(&mut self, value: u32, len: usize) {
        for shift in (0..len).rev() {
            self.bits.push((value >> shift) & 1 == 1);
        }
    }

    fn into_bytes(self) -> Vec<u8> {
        self.bits
            .chunks(8)
            .map(|chunk| {
                chunk.iter().enumerate().fold(0u8, |byte, (index, bit)| {
                    byte | (u8::from(*bit) << (7 - index))
                })
            })
            .collect()
    }
}

fn gf_mul(mut left: u8, mut right: u8) -> u8 {
    let mut result = 0u8;
    for _ in 0..8 {
        if right & 1 != 0 {
            result ^= left;
        }
        let high = left & 0x80 != 0;
        left <<= 1;
        if high {
            left ^= 0x1D;
        }
        right >>= 1;
    }
    result
}

fn rs_generator(degree: usize) -> Vec<u8> {
    let mut poly = vec![1u8];
    let mut root = 1u8;
    for _ in 0..degree {
        let mut next = vec![0u8; poly.len() + 1];
        for (index, &coefficient) in poly.iter().enumerate() {
            next[index] ^= coefficient;
            next[index + 1] ^= gf_mul(coefficient, root);
        }
        poly = next;
        root = gf_mul(root, 2);
    }
    poly
}

fn rs_remainder(data: &[u8], generator: &[u8], degree: usize) -> Vec<u8> {
    let mut remainder = vec![0u8; degree];
    for &byte in data {
        let factor = byte ^ remainder[0];
        remainder.rotate_left(1);
        remainder[degree - 1] = 0;
        for index in 0..degree {
            remainder[index] ^= gf_mul(generator[index + 1], factor);
        }
    }
    remainder
}

#[derive(Clone)]
struct Matrix {
    size: usize,
    modules: Vec<bool>,
    function: Vec<bool>,
}

impl Matrix {
    fn new(size: usize) -> Self {
        Self {
            size,
            modules: vec![false; size * size],
            function: vec![false; size * size],
        }
    }

    fn set(&mut self, x: usize, y: usize, dark: bool) {
        let index = y * self.size + x;
        self.modules[index] = dark;
        self.function[index] = true;
    }

    fn mark(&mut self, x: usize, y: usize) {
        self.function[y * self.size + x] = true;
    }

    fn get(&self, x: usize, y: usize) -> bool {
        self.modules[y * self.size + x]
    }

    fn is_function(&self, x: usize, y: usize) -> bool {
        self.function[y * self.size + x]
    }

    fn draw_finders(&mut self) {
        for &(origin_x, origin_y) in &[(0usize, 0usize), (self.size - 7, 0), (0, self.size - 7)] {
            for dy in -1i32..=7 {
                for dx in -1i32..=7 {
                    let x = origin_x as i32 + dx;
                    let y = origin_y as i32 + dy;
                    if x < 0 || y < 0 || x >= self.size as i32 || y >= self.size as i32 {
                        continue;
                    }
                    let inside = (0..7).contains(&dx) && (0..7).contains(&dy);
                    let dark = inside
                        && (dx == 0
                            || dx == 6
                            || dy == 0
                            || dy == 6
                            || ((2..=4).contains(&dx) && (2..=4).contains(&dy)));
                    self.set(x as usize, y as usize, dark);
                }
            }
        }
    }

    fn draw_timing(&mut self) {
        for index in 8..self.size - 8 {
            let dark = index % 2 == 0;
            self.set(index, 6, dark);
            self.set(6, index, dark);
        }
    }

    fn draw_alignment(&mut self, version: usize) {
        let positions = ALIGNMENT[version];
        let last = positions.len().saturating_sub(1);
        for (row, &cy) in positions.iter().enumerate() {
            for (column, &cx) in positions.iter().enumerate() {
                if (row == 0 && column == 0)
                    || (row == 0 && column == last)
                    || (row == last && column == 0)
                {
                    continue;
                }
                for dy in -2i32..=2 {
                    for dx in -2i32..=2 {
                        let dark = dx.abs().max(dy.abs()) == 2 || (dx == 0 && dy == 0);
                        self.set((cx as i32 + dx) as usize, (cy as i32 + dy) as usize, dark);
                    }
                }
            }
        }
    }

    fn reserve_format(&mut self) {
        for index in 0..=5 {
            self.mark(8, index);
        }
        self.mark(8, 7);
        self.mark(8, 8);
        self.mark(7, 8);
        for index in 9..15 {
            self.mark(14 - index, 8);
        }
        for index in 0..8 {
            self.mark(self.size - 1 - index, 8);
        }
        for index in 8..15 {
            self.mark(8, self.size - 15 + index);
        }
        self.set(8, self.size - 8, true);
    }

    fn draw_format(&mut self, mask: u8) {
        let bits = format_bits(mask);
        for index in 0..=5 {
            self.set(8, index, bit(bits, index));
        }
        self.set(8, 7, bit(bits, 6));
        self.set(8, 8, bit(bits, 7));
        self.set(7, 8, bit(bits, 8));
        for index in 9..15 {
            self.set(14 - index, 8, bit(bits, index));
        }
        for index in 0..8 {
            self.set(self.size - 1 - index, 8, bit(bits, index));
        }
        for index in 8..15 {
            self.set(8, self.size - 15 + index, bit(bits, index));
        }
    }

    fn draw_version(&mut self, version: usize) {
        if version < 7 {
            return;
        }
        let bits = version_bits(version as u32);
        for index in 0..18 {
            let value = bit(bits, index);
            let a = self.size - 11 + index % 3;
            let b = index / 3;
            self.set(a, b, value);
            self.set(b, a, value);
        }
    }

    fn draw_data(&mut self, codewords: &[u8]) {
        let mut index = 0usize;
        let mut right = self.size - 1;
        loop {
            if right == 6 {
                right = 5;
            }
            let upward = ((right + 1) & 2) == 0;
            for vertical in 0..self.size {
                let y = if upward {
                    self.size - 1 - vertical
                } else {
                    vertical
                };
                for offset in 0..2 {
                    let x = right - offset;
                    if self.is_function(x, y) || index >= codewords.len() * 8 {
                        continue;
                    }
                    let byte = codewords[index / 8];
                    self.modules[y * self.size + x] = (byte >> (7 - index % 8)) & 1 == 1;
                    index += 1;
                }
            }
            if right <= 1 {
                break;
            }
            right -= 2;
        }
    }

    fn apply_mask(&mut self, mask: u8) {
        for y in 0..self.size {
            for x in 0..self.size {
                if self.is_function(x, y) {
                    continue;
                }
                let invert = match mask {
                    0 => (x + y) % 2 == 0,
                    1 => y % 2 == 0,
                    2 => x % 3 == 0,
                    3 => (x + y) % 3 == 0,
                    4 => (y / 2 + x / 3) % 2 == 0,
                    5 => (x * y) % 2 + (x * y) % 3 == 0,
                    6 => ((x * y) % 2 + (x * y) % 3) % 2 == 0,
                    _ => ((x + y) % 2 + (x * y) % 3) % 2 == 0,
                };
                if invert {
                    self.modules[y * self.size + x] = !self.modules[y * self.size + x];
                }
            }
        }
    }

    fn penalty(&self) -> u32 {
        let mut score = 0u32;
        for y in 0..self.size {
            score += self.line_penalty(|x| self.get(x, y));
        }
        for x in 0..self.size {
            score += self.line_penalty(|y| self.get(x, y));
        }
        for y in 0..self.size - 1 {
            for x in 0..self.size - 1 {
                let color = self.get(x, y);
                if color == self.get(x + 1, y)
                    && color == self.get(x, y + 1)
                    && color == self.get(x + 1, y + 1)
                {
                    score += 3;
                }
            }
        }
        for y in 0..self.size {
            score += self.finder_penalty(|x| self.get(x, y));
        }
        for x in 0..self.size {
            score += self.finder_penalty(|y| self.get(x, y));
        }
        let total = self.size * self.size;
        let dark = self.modules.iter().filter(|&&module| module).count();
        let deviation = (dark * 20).abs_diff(total * 10) / total;
        score + deviation as u32 * 10
    }

    fn line_penalty<F>(&self, get: F) -> u32
    where
        F: Fn(usize) -> bool,
    {
        let mut score = 0u32;
        let mut run = 1usize;
        let mut previous = get(0);
        for index in 1..self.size {
            let current = get(index);
            if current == previous {
                run += 1;
            } else {
                if run >= 5 {
                    score += 3 + (run as u32 - 5);
                }
                previous = current;
                run = 1;
            }
        }
        if run >= 5 {
            score += 3 + (run as u32 - 5);
        }
        score
    }

    fn finder_penalty<F>(&self, get: F) -> u32
    where
        F: Fn(usize) -> bool,
    {
        let mut score = 0u32;
        for start in 0..self.size.saturating_sub(10) {
            let pattern: Vec<bool> = (0..11).map(|offset| get(start + offset)).collect();
            let first = [
                true, false, true, true, true, false, true, false, false, false, false,
            ];
            let second = [
                false, false, false, false, true, false, true, true, true, false, true,
            ];
            if pattern == first || pattern == second {
                score += 40;
            }
        }
        score
    }
}

fn bit(value: u32, index: usize) -> bool {
    (value >> index) & 1 == 1
}

fn format_bits(mask: u8) -> u32 {
    let data = u32::from(mask);
    let mut remainder = data << 10;
    for index in (10..15).rev() {
        if remainder & (1 << index) != 0 {
            remainder ^= 0x537 << (index - 10);
        }
    }
    ((data << 10) | (remainder & 0x3FF)) ^ 0x5412
}

fn version_bits(version: u32) -> u32 {
    let mut remainder = version << 12;
    for index in (12..18).rev() {
        if remainder & (1 << index) != 0 {
            remainder ^= 0x1F25 << (index - 12);
        }
    }
    (version << 12) | (remainder & 0xFFF)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_short_url() {
        let code = encode("http://127.0.0.1:8080/").unwrap();
        assert_eq!(code.version, 2);
        assert_eq!(code.size, 25);
        assert!(code.modules.iter().any(|&module| module));
        assert!(code.svg().contains("<svg"));
        assert!(code.terminal().contains('▀'));
    }

    #[test]
    fn rejects_payloads_above_capacity() {
        assert!(encode(&"a".repeat(1000)).is_err());
    }

    #[test]
    fn format_bits_are_stable() {
        assert_eq!(format_bits(0), 0x5412);
        assert_eq!(format_bits(7), 0x4AA0);
    }

    #[test]
    fn reed_solomon_remainder_matches_known_vector() {
        let generator = rs_generator(10);
        let remainder = rs_remainder(
            &[
                0x40, 0xB4, 0x84, 0x54, 0xC4, 0xC4, 0xF2, 0x05, 0x74, 0xF5, 0x24, 0xC4, 0x40, 0xEC,
                0x11, 0xEC,
            ],
            &generator,
            10,
        );
        assert_eq!(
            remainder,
            vec![0x0C, 0x4B, 0xCF, 0x9A, 0x89, 0x4F, 0x65, 0x09, 0x97, 0xCC]
        );
    }
}
