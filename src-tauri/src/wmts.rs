//! Minimal WMTS `GetCapabilities` reader.
//!
//! Capabilities documents can be several megabytes, but only a handful of
//! elements matter for adding a raster layer. A tiny purpose-built XML reader
//! keeps this dependency-free and refuses pathological nesting while still
//! accepting the namespace prefixes every real server emits.

use std::collections::BTreeMap;

use serde::Serialize;

/// Largest capabilities document accepted by the UI.
pub const MAX_CAPABILITIES_BYTES: usize = 8 * 1024 * 1024;

const MAX_DEPTH: usize = 96;
const MAX_NODES: usize = 200_000;

/// One raster WMTS layer that can be added as an XYZ-style source.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WmtsLayerInfo {
    /// Layer identifier used by `GetTile`.
    pub identifier: String,
    /// Human-readable title.
    pub title: String,
    /// Default style identifier.
    pub style: String,
    /// Selected image format (`png`, `jpg` or `webp`).
    pub format: String,
    /// Linked tile matrix set.
    pub matrix_set: String,
    /// Tile URL template with `{z}`, `{x}` and `{y}`.
    pub url: String,
    /// First matrix level, which doubles as the minimum MapLibre zoom.
    pub min_zoom: u8,
    /// Last matrix level.
    pub max_zoom: u8,
    /// Tile edge in pixels.
    pub tile_size: u16,
    /// WGS84 bounds as `[west, south, east, north]`.
    pub bounds: Option<[f64; 4]>,
}

/// Layers found in a capabilities document.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WmtsCapabilities {
    /// Service title, if advertised.
    pub title: String,
    /// Raster layers usable as tile sources.
    pub layers: Vec<WmtsLayerInfo>,
}

#[derive(Debug, Clone)]
struct Node {
    name: String,
    attrs: BTreeMap<String, String>,
    children: Vec<Node>,
    text: String,
}

impl Node {
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|node| node.name == name)
    }

    fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> {
        self.children.iter().filter(move |node| node.name == name)
    }

    fn value(&self) -> String {
        self.text.trim().to_owned()
    }

    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }

    /// Depth-first search; capabilities documents are shallow.
    fn find(&self, name: &str) -> Option<&Node> {
        if self.name == name {
            return Some(self);
        }
        self.children.iter().find_map(|child| child.find(name))
    }
}

/// Parses a WMTS capabilities document into addable raster layers.
pub fn parse(document: &str) -> Result<WmtsCapabilities, String> {
    let document = document.trim_start_matches('\u{feff}');
    let root = Document::new(document).parse()?;
    if root.name != "capabilities" {
        return Err(format!(
            "not a WMTS capabilities document (root element <{}>)",
            root.name
        ));
    }
    let title = root
        .child("serviceidentification")
        .and_then(|service| service.child("title"))
        .map(Node::value)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "WMTS".to_owned());
    let endpoint = get_tile_endpoint(&root);
    let mut sets = Vec::new();
    if let Some(contents) = root.child("contents") {
        for set in contents.children_named("tilematrixset") {
            if let Some(parsed) = parse_matrix_set(set) {
                sets.push(parsed);
            }
        }
        let mut layers = Vec::new();
        for layer in contents.children_named("layer") {
            if let Some(info) = parse_layer(layer, &sets, endpoint.as_deref()) {
                layers.push(info);
            }
        }
        Ok(WmtsCapabilities { title, layers })
    } else {
        Err("document has no <Contents> element".to_owned())
    }
}

fn get_tile_endpoint(root: &Node) -> Option<String> {
    let operations = root.child("operationsmetadata")?;
    for operation in operations.children_named("operation") {
        if !operation
            .attr("name")
            .is_some_and(|name| name.eq_ignore_ascii_case("gettile"))
        {
            continue;
        }
        let get = operation.find("get")?;
        if let Some(href) = get.attr("href").map(str::trim).filter(|h| !h.is_empty()) {
            return Some(href.to_owned());
        }
    }
    None
}

#[derive(Debug)]
struct Matrix {
    id: u8,
    tile_size: u16,
}

#[derive(Debug)]
struct MatrixSet {
    id: String,
    web_mercator: bool,
    matrices: Vec<Matrix>,
}

fn parse_matrix_set(node: &Node) -> Option<MatrixSet> {
    let id = node.child("identifier")?.value();
    if id.is_empty() {
        return None;
    }
    let web_mercator = node.child("supportedcrs").is_none_or(|crs| {
        let uppercase = crs.value().to_ascii_uppercase();
        ["3857", "900913", "102100"]
            .iter()
            .any(|code| uppercase.ends_with(code) || uppercase.ends_with(&format!(":{code}")))
    });
    let matrices = node
        .children_named("tilematrix")
        .filter_map(|matrix| {
            let id = matrix.child("identifier")?.value();
            let id = id.parse::<u8>().ok()?;
            let size = matrix
                .child("tilewidth")
                .and_then(|width| width.value().parse::<u16>().ok())
                .or_else(|| {
                    matrix
                        .child("tileheight")
                        .and_then(|height| height.value().parse::<u16>().ok())
                })
                .unwrap_or(256);
            Some(Matrix {
                id,
                tile_size: size,
            })
        })
        .collect::<Vec<_>>();
    if matrices.is_empty() {
        return None;
    }
    Some(MatrixSet {
        id,
        web_mercator,
        matrices,
    })
}

impl MatrixSet {
    /// Tile size shared by every level; mismatched levels are unusable.
    fn tile_size(&self) -> Option<u16> {
        let first = self.matrices.first()?.tile_size;
        if !matches!(first, 256 | 512) {
            return None;
        }
        if self.matrices.iter().any(|matrix| matrix.tile_size != first) {
            return None;
        }
        Some(first)
    }

    /// Contiguous numeric levels, in ascending order.
    fn zoom_range(&self) -> Option<(u8, u8)> {
        let mut levels = self
            .matrices
            .iter()
            .map(|matrix| matrix.id)
            .collect::<Vec<_>>();
        levels.sort_unstable();
        levels.dedup();
        let first = *levels.first()?;
        let last = *levels.last()?;
        if last - first + 1 != levels.len() as u8 {
            return None;
        }
        Some((first, last))
    }
}

fn parse_layer(node: &Node, sets: &[MatrixSet], endpoint: Option<&str>) -> Option<WmtsLayerInfo> {
    let identifier = node.child("identifier")?.value();
    if identifier.is_empty() {
        return None;
    }
    let title = node
        .child("title")
        .map(Node::value)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| identifier.clone());
    let style = default_style(node).unwrap_or_else(|| "default".to_owned());
    let formats = node
        .children_named("format")
        .filter_map(|format| normalize_format(&format.value()))
        .collect::<Vec<_>>();
    let resource_urls = node
        .children_named("resourceurl")
        .filter(|resource| {
            resource
                .attr("resourcetype")
                .is_some_and(|kind| kind.eq_ignore_ascii_case("tile"))
        })
        .filter_map(|resource| {
            let format = normalize_format(resource.attr("format")?)?;
            let template = resource.attr("template")?.trim();
            Some((format, template.to_owned()))
        })
        .collect::<Vec<_>>();
    let bounds = wgs84_bounds(node);
    let links = node
        .children_named("tilematrixsetlink")
        .filter_map(|link| link.child("tilematrixset").map(Node::value))
        .collect::<Vec<_>>();

    for link in links {
        let Some(set) = sets.iter().find(|set| set.id == link) else {
            continue;
        };
        if !set.web_mercator {
            continue;
        }
        let Some(tile_size) = set.tile_size() else {
            continue;
        };
        let Some((min_zoom, max_zoom)) = set.zoom_range() else {
            continue;
        };
        let Some((format, template)) = choose_resource(&resource_urls, &formats) else {
            continue;
        };
        let url = if let Some(template) = template {
            normalize_template(&template, &set.id, &style)?
        } else {
            let endpoint = endpoint?;
            kvp_template(endpoint, &identifier, &style, &set.id, &format)
        };
        return Some(WmtsLayerInfo {
            identifier,
            title,
            style,
            format,
            matrix_set: set.id.clone(),
            url,
            min_zoom,
            max_zoom,
            tile_size,
            bounds,
        });
    }
    None
}

fn default_style(node: &Node) -> Option<String> {
    let styles = node.children_named("style").collect::<Vec<_>>();
    let chosen = styles
        .iter()
        .find(|style| {
            style
                .attr("isdefault")
                .is_some_and(|flag| flag.eq_ignore_ascii_case("true"))
        })
        .or_else(|| styles.first())?;
    chosen
        .child("identifier")
        .map(Node::value)
        .filter(|value| !value.is_empty())
}

/// Only raster formats Mappa can render; vector tiles are ignored here.
fn normalize_format(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.starts_with("image/png") {
        Some("png".to_owned())
    } else if value.starts_with("image/jpeg") || value == "image/jpg" {
        Some("jpg".to_owned())
    } else if value.starts_with("image/webp") {
        Some("webp".to_owned())
    } else {
        None
    }
}

/// Picks the first image format advertised by both the layer and a resource.
fn choose_resource(
    resources: &[(String, String)],
    formats: &[String],
) -> Option<(String, Option<String>)> {
    for preferred in ["png", "jpg", "webp"] {
        if !formats.is_empty() && !formats.iter().any(|format| format == preferred) {
            continue;
        }
        if let Some((format, template)) = resources
            .iter()
            .find(|(format, _)| format == preferred)
            .map(|(format, template)| (format.clone(), Some(template.clone())))
        {
            return Some((format, template));
        }
    }
    // No ResourceURL for an advertised image format: callers may still build
    // a KVP request when the service exposes a GetTile endpoint.
    formats.first().map(|format| (format.clone(), None))
}

fn wgs84_bounds(node: &Node) -> Option<[f64; 4]> {
    let bbox = node.child("wgs84boundingbox")?;
    let lower = bbox.child("lowercorner")?.value();
    let upper = bbox.child("uppercorner")?.value();
    let mut values = lower
        .split_whitespace()
        .chain(upper.split_whitespace())
        .filter_map(|value| value.parse::<f64>().ok());
    let west = values.next()?;
    let south = values.next()?;
    let east = values.next()?;
    let north = values.next()?;
    let valid = [west, south, east, north]
        .iter()
        .all(|value| value.is_finite())
        && west < east
        && south < north
        && (-180.0..=180.0).contains(&west)
        && (-180.0..=180.0).contains(&east)
        && (-90.0..=90.0).contains(&south)
        && (-90.0..=90.0).contains(&north);
    valid.then_some([west, south, east, north])
}

fn normalize_template(template: &str, matrix_set: &str, style: &str) -> Option<String> {
    let url = template
        .replace("{TileMatrixSet}", &percent_encode(matrix_set))
        .replace("{Style}", &percent_encode(style))
        .replace("{TileMatrix}", "{z}")
        .replace("{TileCol}", "{x}")
        .replace("{TileRow}", "{y}");
    // Any remaining brace token would leak literally into the tile URL.
    let mut rest = url.clone();
    for token in ["{z}", "{x}", "{y}", "{-y}"] {
        rest = rest.replace(token, "");
    }
    if rest.contains('{') || rest.contains('}') {
        return None;
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return None;
    }
    Some(url)
}

fn kvp_template(
    endpoint: &str,
    layer: &str,
    style: &str,
    matrix_set: &str,
    format: &str,
) -> String {
    let separator = if endpoint.contains('?') { '&' } else { '?' };
    let mime = match format {
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    format!(
        "{endpoint}{separator}service=WMTS&request=GetTile&version=1.0.0&layer={layer}\
         &style={style}&tilematrixset={set}&format={mime}\
         &TileMatrix={{z}}&TileCol={{x}}&TileRow={{y}}",
        layer = percent_encode(layer),
        style = percent_encode(style),
        set = percent_encode(matrix_set),
        mime = percent_encode(mime),
    )
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Tiny XML reader with a bounded element tree.
struct Document<'a> {
    input: &'a [u8],
    pos: usize,
    nodes: usize,
}

impl<'a> Document<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            input: input.as_bytes(),
            pos: 0,
            nodes: 0,
        }
    }

    fn parse(mut self) -> Result<Node, String> {
        self.skip_misc()?;
        if self.peek() != Some(b'<') {
            return Err("document has no root element".to_owned());
        }
        let root = self.element(0)?;
        Ok(root)
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.pos).copied()
    }

    fn starts_with(&self, prefix: &[u8]) -> bool {
        self.input
            .get(self.pos..)
            .is_some_and(|rest| rest.starts_with(prefix))
    }

    fn skip_whitespace(&mut self) {
        while self.peek().is_some_and(|byte| byte.is_ascii_whitespace()) {
            self.pos += 1;
        }
    }

    fn skip_misc(&mut self) -> Result<(), String> {
        loop {
            self.skip_whitespace();
            if self.starts_with(b"<?") {
                self.pos += 2;
                self.skip_until(b"?>")?;
            } else if self.starts_with(b"<!--") {
                self.pos += 4;
                self.skip_until(b"-->")?;
            } else if self.starts_with(b"<!") {
                self.skip_declaration()?;
            } else {
                return Ok(());
            }
        }
    }

    /// Advances past `marker`, which must be found at or after the cursor.
    fn skip_until(&mut self, marker: &[u8]) -> Result<(), String> {
        let start = self.pos;
        let Some(offset) = self.input.get(start..).and_then(|rest| {
            rest.windows(marker.len())
                .position(|window| window == marker)
        }) else {
            return Err("unterminated XML section".to_owned());
        };
        self.pos = start + offset + marker.len();
        Ok(())
    }

    fn skip_declaration(&mut self) -> Result<(), String> {
        let mut depth = 0_i32;
        let mut quote = None;
        while let Some(byte) = self.peek() {
            self.pos += 1;
            if let Some(active) = quote {
                if byte == active {
                    quote = None;
                }
                continue;
            }
            match byte {
                b'"' | b'\'' => quote = Some(byte),
                b'[' => depth += 1,
                b']' => depth = (depth - 1).max(0),
                b'>' if depth == 0 => return Ok(()),
                _ => {}
            }
        }
        Err("unterminated XML declaration".to_owned())
    }

    fn element(&mut self, depth: usize) -> Result<Node, String> {
        if depth > MAX_DEPTH {
            return Err(format!("XML nesting exceeds {MAX_DEPTH} levels"));
        }
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            return Err(format!("XML has more than {MAX_NODES} elements"));
        }
        debug_assert_eq!(self.peek(), Some(b'<'));
        self.pos += 1;
        let (name, attrs, self_closing) = self.start_tag()?;
        let mut node = Node {
            name,
            attrs,
            children: Vec::new(),
            text: String::new(),
        };
        if self_closing {
            return Ok(node);
        }
        loop {
            let text_start = self.pos;
            while self.peek().is_some_and(|byte| byte != b'<') {
                self.pos += 1;
            }
            if self.pos > text_start {
                let raw = String::from_utf8_lossy(&self.input[text_start..self.pos]);
                node.text.push_str(&decode_entities(&raw));
            }
            if self.pos >= self.input.len() {
                break;
            }
            if self.starts_with(b"<!--") {
                self.pos += 4;
                self.skip_until(b"-->")?;
            } else if self.starts_with(b"<![CDATA[") {
                let start = self.pos + 9;
                let Some(offset) = self.input[start..]
                    .windows(3)
                    .position(|window| window == b"]]>")
                else {
                    return Err("unterminated CDATA section".to_owned());
                };
                let raw = String::from_utf8_lossy(&self.input[start..start + offset]);
                node.text.push_str(&raw);
                self.pos = start + offset + 3;
            } else if self.starts_with(b"<?") {
                self.pos += 2;
                self.skip_until(b"?>")?;
            } else if self.starts_with(b"<!") {
                self.skip_declaration()?;
            } else if self.starts_with(b"</") {
                self.pos += 2;
                let closing = local_name(&self.read_name());
                self.skip_until(b">")?;
                if closing == node.name {
                    break;
                }
                // Lenient: ignore stray closing tags from broken servers.
            } else {
                let child = self.element(depth + 1)?;
                node.children.push(child);
            }
        }
        Ok(node)
    }

    /// Reads `name attr="value" ...>` after the opening `<`.
    fn start_tag(&mut self) -> Result<(String, BTreeMap<String, String>, bool), String> {
        let raw_name = self.read_name();
        if raw_name.is_empty() {
            return Err("empty element name".to_owned());
        }
        let name = local_name(&raw_name);
        let mut attrs = BTreeMap::new();
        loop {
            self.skip_whitespace();
            match self.peek() {
                Some(b'>') => {
                    self.pos += 1;
                    return Ok((name, attrs, false));
                }
                Some(b'/') => {
                    self.pos += 1;
                    if self.peek() != Some(b'>') {
                        return Err("malformed self-closing element".to_owned());
                    }
                    self.pos += 1;
                    return Ok((name, attrs, true));
                }
                None => return Err("unterminated start tag".to_owned()),
                _ => {}
            }
            let attr = self.read_name();
            if attr.is_empty() {
                // Skip punctuation instead of looping forever.
                self.pos += 1;
                continue;
            }
            self.skip_whitespace();
            if self.peek() != Some(b'=') {
                continue;
            }
            self.pos += 1;
            self.skip_whitespace();
            let Some(quote) = self.peek().filter(|byte| matches!(byte, b'"' | b'\'')) else {
                return Err("attribute value is not quoted".to_owned());
            };
            self.pos += 1;
            let start = self.pos;
            while self.peek().is_some_and(|byte| byte != quote) {
                self.pos += 1;
            }
            if self.peek().is_none() {
                return Err("unterminated attribute value".to_owned());
            }
            let raw = String::from_utf8_lossy(&self.input[start..self.pos]);
            attrs.insert(local_name(&attr), decode_entities(&raw));
            self.pos += 1;
        }
    }

    fn read_name(&mut self) -> String {
        let start = self.pos;
        while self.peek().is_some_and(|byte| {
            !byte.is_ascii_whitespace() && !matches!(byte, b'=' | b'>' | b'/' | b'<')
        }) {
            self.pos += 1;
        }
        String::from_utf8_lossy(&self.input[start..self.pos]).into_owned()
    }
}

/// `ows:Identifier` → `identifier`.
fn local_name(name: &str) -> String {
    name.rsplit(':').next().unwrap_or(name).to_ascii_lowercase()
}

fn decode_entities(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_owned();
    }
    let mut decoded = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(index) = rest.find('&') {
        decoded.push_str(&rest[..index]);
        let after = &rest[index + 1..];
        let Some(end) = after.bytes().take(16).position(|byte| byte == b';') else {
            decoded.push('&');
            rest = after;
            continue;
        };
        let entity = &after[..end];
        let replacement = match entity {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            value if value.starts_with("#x") || value.starts_with("#X") => {
                u32::from_str_radix(&value[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            value if value.starts_with('#') => {
                value[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(character) = replacement {
            decoded.push(character);
            rest = &after[end + 1..];
        } else {
            decoded.push('&');
            rest = after;
        }
    }
    decoded.push_str(rest);
    decoded
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPABILITIES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0"
  xmlns:ows="http://www.opengis.net/ows/1.1"
  xmlns:xlink="http://www.w3.org/1999/xlink" version="1.0.0">
  <ows:ServiceIdentification>
    <ows:Title>Test &amp; Tiles</ows:Title>
  </ows:ServiceIdentification>
  <ows:OperationsMetadata>
    <ows:Operation name="GetTile">
      <ows:DCP><ows:HTTP>
        <ows:Get xlink:href="https://tiles.example.org/wmts?key=abc"/>
      </ows:HTTP></ows:DCP>
    </ows:Operation>
  </ows:OperationsMetadata>
  <Contents>
    <Layer>
      <ows:Title>Raster &amp; labels</ows:Title>
      <ows:Identifier>base</ows:Identifier>
      <ows:WGS84BoundingBox>
        <ows:LowerCorner>-180 -85</ows:LowerCorner>
        <ows:UpperCorner>180 85</ows:UpperCorner>
      </ows:WGS84BoundingBox>
      <Style isDefault="true"><ows:Identifier>night</ows:Identifier></Style>
      <Format>image/png</Format>
      <TileMatrixSetLink><TileMatrixSet>WebMercator</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile"
        template="https://tiles.example.org/{TileMatrixSet}/{Style}/{TileMatrix}/{TileRow}/{TileCol}.png?key=abc"/>
    </Layer>
    <Layer>
      <ows:Title>Vector</ows:Title>
      <ows:Identifier>vector</ows:Identifier>
      <Style><ows:Identifier>default</ows:Identifier></Style>
      <Format>application/vnd.mapbox-vector-tile</Format>
      <TileMatrixSetLink><TileMatrixSet>WebMercator</TileMatrixSet></TileMatrixSetLink>
    </Layer>
    <Layer>
      <ows:Title>Projected</ows:Title>
      <ows:Identifier>projected</ows:Identifier>
      <Style><ows:Identifier>main</ows:Identifier></Style>
      <Format>image/png</Format>
      <TileMatrixSetLink><TileMatrixSet>UTM</TileMatrixSet></TileMatrixSetLink>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>WebMercator</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
      <TileMatrix>
        <ows:Identifier>2</ows:Identifier>
        <TileWidth>256</TileWidth><TileHeight>256</TileHeight>
      </TileMatrix>
      <TileMatrix>
        <ows:Identifier>3</ows:Identifier>
        <TileWidth>256</TileWidth><TileHeight>256</TileHeight>
      </TileMatrix>
      <TileMatrix>
        <ows:Identifier>4</ows:Identifier>
        <TileWidth>256</TileWidth><TileHeight>256</TileHeight>
      </TileMatrix>
    </TileMatrixSet>
    <TileMatrixSet>
      <ows:Identifier>UTM</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::32637</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>0</ows:Identifier><TileWidth>256</TileWidth></TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>"#;

    #[test]
    fn parses_raster_layers_and_templates() {
        let parsed = parse(CAPABILITIES).unwrap();
        assert_eq!(parsed.title, "Test & Tiles");
        assert_eq!(parsed.layers.len(), 1);
        let layer = &parsed.layers[0];
        assert_eq!(layer.identifier, "base");
        assert_eq!(layer.title, "Raster & labels");
        assert_eq!(layer.style, "night");
        assert_eq!(layer.format, "png");
        assert_eq!(layer.matrix_set, "WebMercator");
        assert_eq!((layer.min_zoom, layer.max_zoom), (2, 4));
        assert_eq!(layer.tile_size, 256);
        assert_eq!(layer.bounds, Some([-180.0, -85.0, 180.0, 85.0]));
        assert_eq!(
            layer.url,
            "https://tiles.example.org/WebMercator/night/{z}/{y}/{x}.png?key=abc"
        );
    }

    #[test]
    fn falls_back_to_kvp_get_tile() {
        let document = CAPABILITIES.replace(
            r#"<ResourceURL format="image/png" resourceType="tile"
        template="https://tiles.example.org/{TileMatrixSet}/{Style}/{TileMatrix}/{TileRow}/{TileCol}.png?key=abc"/>"#,
            "",
        );
        let parsed = parse(&document).unwrap();
        let layer = &parsed.layers[0];
        assert!(
            layer
                .url
                .starts_with("https://tiles.example.org/wmts?key=abc&")
        );
        assert!(layer.url.contains("layer=base"));
        assert!(layer.url.contains("style=night"));
        assert!(layer.url.contains("tilematrixset=WebMercator"));
        assert!(layer.url.contains("format=image%2Fpng"));
        assert!(
            layer
                .url
                .ends_with("TileMatrix={z}&TileCol={x}&TileRow={y}")
        );
    }

    #[test]
    fn rejects_non_capabilities_and_broken_documents() {
        assert!(parse("<html><body/></html>").is_err());
        assert!(parse("<Capabilities><Contents>").is_ok()); // lenient EOF
        assert!(parse("not xml").is_err());
        assert!(parse(&"<a>".repeat(MAX_DEPTH + 2)).is_err());
    }

    #[test]
    fn decodes_entities_and_local_names() {
        assert_eq!(
            decode_entities("a &lt; b &amp; c &#65; &#x42;"),
            "a < b & c A B"
        );
        assert_eq!(local_name("ows:Identifier"), "identifier");
        assert_eq!(percent_encode("EPSG:3857 / a"), "EPSG%3A3857%20%2F%20a");
    }
}
