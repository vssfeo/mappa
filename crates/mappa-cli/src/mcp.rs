//! Minimal Model Context Protocol server over stdio.
//!
//! Exposes the existing download/pack/SAS commands as tools so editors and
//! agents can drive Mappa without shelling out.

use anyhow::Result;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const PROTOCOL: &str = "2024-11-05";

fn text_result(text: String) -> Value {
    json!({"content": [{"type": "text", "text": text}]})
}

fn error_result(message: String) -> Value {
    json!({
        "content": [{"type": "text", "text": message}],
        "isError": true
    })
}

fn tools() -> Value {
    json!([
        {
            "name": "list_providers",
            "description": "List bundled tile providers.",
            "inputSchema": {"type": "object", "properties": {}}
        },
        {
            "name": "download",
            "description": "Download a region into the shared cache.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "provider": {"type": "string"},
                    "bbox": {"type": "string", "description": "west,south,east,north"},
                    "zoom": {"type": "string", "description": "10, 10-13 or 10..13"},
                    "cache": {"type": "string"}
                },
                "required": ["provider", "bbox", "zoom"]
            }
        },
        {
            "name": "pack",
            "description": "Export the cache region to MBTiles or PMTiles.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "provider": {"type": "string"},
                    "bbox": {"type": "string"},
                    "zoom": {"type": "string"},
                    "output": {"type": "string"},
                    "name": {"type": "string"},
                    "license": {"type": "string"},
                    "cache": {"type": "string"}
                },
                "required": ["provider", "bbox", "zoom", "output"]
            }
        },
        {
            "name": "import_sas",
            "description": "Import a SAS.Planet cache layer into MBTiles.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source": {"type": "string"},
                    "output": {"type": "string"},
                    "layer": {"type": "string"},
                    "name": {"type": "string"}
                },
                "required": ["source", "output"]
            }
        }
    ])
}

fn string(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

fn cache_arg(args: &Value) -> Option<std::path::PathBuf> {
    string(args, "cache").map(std::path::PathBuf::from)
}

async fn call_tool(name: &str, args: &Value) -> Value {
    match name {
        "list_providers" => match mappa_core::ProviderCatalog::builtin() {
            Ok(catalog) => {
                let items: Vec<Value> = catalog
                    .iter()
                    .map(|provider| {
                        json!({
                            "id": provider.id,
                            "name": provider.name,
                            "minZoom": provider.min_zoom,
                            "maxZoom": provider.max_zoom,
                            "offlineAllowed": provider.offline_allowed
                        })
                    })
                    .collect();
                text_result(serde_json::to_string_pretty(&items).unwrap_or_default())
            }
            Err(error) => error_result(error.to_string()),
        },
        "download" => {
            let (Some(provider), Some(bbox), Some(zoom)) = (
                string(args, "provider"),
                string(args, "bbox"),
                string(args, "zoom"),
            ) else {
                return error_result("provider, bbox and zoom are required".to_owned());
            };
            let request = crate::DownloadArgs {
                provider,
                bbox,
                zoom,
                cache: cache_arg(args),
                providers_dir: None,
                max_tiles: 2_000_000,
                limit_mb: 2048,
                dry_run: false,
            };
            match crate::run_download(&request, true).await {
                Ok(report) => {
                    text_result(serde_json::to_string_pretty(&report).unwrap_or_default())
                }
                Err(error) => error_result(error.to_string()),
            }
        }
        "pack" => {
            let (Some(provider), Some(bbox), Some(zoom), Some(output)) = (
                string(args, "provider"),
                string(args, "bbox"),
                string(args, "zoom"),
                string(args, "output"),
            ) else {
                return error_result("provider, bbox, zoom and output are required".to_owned());
            };
            let request = crate::PackArgs {
                provider,
                bbox,
                zoom,
                output: std::path::PathBuf::from(output),
                name: string(args, "name"),
                license: string(args, "license"),
                cache: cache_arg(args),
                providers_dir: None,
            };
            match crate::run_pack(&request, true) {
                Ok(report) => {
                    text_result(serde_json::to_string_pretty(&report).unwrap_or_default())
                }
                Err(error) => error_result(error.to_string()),
            }
        }
        "import_sas" => {
            let (Some(source), Some(output)) = (string(args, "source"), string(args, "output"))
            else {
                return error_result("source and output are required".to_owned());
            };
            let request = crate::sas::SasArgs {
                source: std::path::PathBuf::from(source),
                output: std::path::PathBuf::from(output),
                layer: string(args, "layer"),
                name: string(args, "name"),
            };
            match crate::sas::import(&request) {
                Ok(report) => {
                    text_result(serde_json::to_string_pretty(&report).unwrap_or_default())
                }
                Err(error) => error_result(error.to_string()),
            }
        }
        other => error_result(format!("unknown tool {other:?}")),
    }
}

/// Handles one JSON-RPC message; notifications return `None`.
pub(crate) async fn handle_message(message: &Value) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let response = match method {
        "initialize" => json!({
            "protocolVersion": PROTOCOL,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "mappa", "version": env!("CARGO_PKG_VERSION")}
        }),
        "ping" => json!({}),
        "tools/list" => json!({"tools": tools()}),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            call_tool(name, &arguments).await
        }
        other => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32601, "message": format!("method not found: {other}")}
            }));
        }
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": response}))
}

/// Reads JSON-RPC lines from stdin and writes responses to stdout.
pub async fn run() -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": {"code": -32700, "message": error.to_string()}
                });
                stdout.write_all(response.to_string().as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
                continue;
            }
        };
        if let Some(response) = handle_message(&message).await {
            stdout.write_all(response.to_string().as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn initializes_and_lists_tools() {
        let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}});
        let response = handle_message(&init).await.unwrap();
        assert_eq!(response["result"]["protocolVersion"], PROTOCOL);
        assert_eq!(response["result"]["serverInfo"]["name"], "mappa");
        let list = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"});
        let response = handle_message(&list).await.unwrap();
        let names: Vec<&str> = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(names.contains(&"download"));
        assert!(names.contains(&"import_sas"));
    }

    #[tokio::test]
    async fn calls_a_tool_and_reports_unknowns() {
        let call = json!({
            "jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"list_providers","arguments":{}}
        });
        let response = handle_message(&call).await.unwrap();
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("usgs"));
        let unknown = json!({"jsonrpc":"2.0","id":4,"method":"nope"});
        let response = handle_message(&unknown).await.unwrap();
        assert_eq!(response["error"]["code"], -32601);
    }
}
