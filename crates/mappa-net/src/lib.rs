//! Polite HTTP fetching for tile providers.
//!
//! The client enforces a per-provider token bucket and concurrency limit,
//! retries transient failures with jittered exponential backoff, honours
//! `Retry-After`, and rejects HTML error pages served with HTTP 200.

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use httpdate::HttpDate;
use mappa_core::{AuthKind, Provider};
use reqwest::Url;
use reqwest::header::{
    AGE, CACHE_CONTROL, CONTENT_TYPE, ETAG, EXPIRES, HeaderMap, HeaderName, HeaderValue,
    IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, RETRY_AFTER, USER_AGENT,
};
use thiserror::Error;
use tokio::sync::{Mutex, Semaphore};

/// Default `User-Agent`; providers expect a contact.
pub const DEFAULT_USER_AGENT: &str = "Mappa/0.1 (interactive offline map workstation)";

const DEFAULT_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_ERROR_PREVIEW: usize = 160;

/// Client tuning.
#[derive(Debug, Clone)]
pub struct NetConfig {
    /// Whole-request timeout.
    pub timeout: Duration,
    /// TCP/TLS connect timeout.
    pub connect_timeout: Duration,
    /// Fallback `User-Agent` when a provider does not set one.
    pub user_agent: String,
    /// Optional HTTP proxy URL.
    pub proxy: Option<String>,
    /// Number of retries after the first attempt.
    pub max_retries: u32,
    /// In-flight requests per provider.
    pub max_concurrent_per_provider: usize,
    /// First backoff step; doubles every attempt.
    pub backoff_base: Duration,
    /// Backoff ceiling.
    pub backoff_max: Duration,
    /// Largest accepted tile body.
    pub max_tile_bytes: usize,
    /// TTL used when the response has no cache headers.
    pub default_ttl: Duration,
    /// Per-provider credentials. Never logged or serialized.
    pub credentials: HashMap<String, Credential>,
}

impl Default for NetConfig {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(20),
            connect_timeout: Duration::from_secs(8),
            user_agent: DEFAULT_USER_AGENT.to_owned(),
            proxy: None,
            max_retries: 3,
            max_concurrent_per_provider: 4,
            backoff_base: Duration::from_millis(300),
            backoff_max: Duration::from_secs(8),
            max_tile_bytes: 4 * 1024 * 1024,
            default_ttl: DEFAULT_TTL,
            credentials: HashMap::new(),
        }
    }
}

/// Secret material for one provider.
#[derive(Debug, Clone)]
pub enum Credential {
    /// Raw value for the header named by `provider.auth.name`.
    Header(String),
    /// Raw value for the query parameter named by `provider.auth.name`.
    Query(String),
    /// HTTP basic authentication.
    Basic { username: String, password: String },
}

/// Validators for a conditional request.
#[derive(Debug, Clone, Default)]
pub struct Conditional {
    /// Previous `ETag`.
    pub etag: Option<String>,
    /// Previous `Last-Modified`.
    pub last_modified: Option<String>,
}

/// Fresh tile body and metadata.
#[derive(Debug, Clone)]
pub struct FetchedTile {
    /// Encoded image bytes.
    pub data: Vec<u8>,
    /// Detected image format (`png`, `jpg`, `webp`).
    pub format: &'static str,
    /// Response `Content-Type`.
    pub content_type: Option<String>,
    /// Response `ETag`.
    pub etag: Option<String>,
    /// Response `Last-Modified`.
    pub last_modified: Option<String>,
    /// Expiry derived from cache headers, Unix seconds.
    pub expires_at: Option<i64>,
    /// `false` when the server sent `no-store`.
    pub cacheable: bool,
}

/// Result of a conditional fetch.
#[derive(Debug, Clone)]
pub enum FetchOutcome {
    /// A new body was returned.
    Fetched(FetchedTile),
    /// The cached body is still valid.
    NotModified {
        /// Expiry derived from cache headers, Unix seconds.
        expires_at: Option<i64>,
        /// New or previous `ETag`.
        etag: Option<String>,
        /// New or previous `Last-Modified`.
        last_modified: Option<String>,
    },
}

/// HTTP client with per-provider politeness.
#[derive(Debug)]
pub struct TileClient {
    client: reqwest::Client,
    config: NetConfig,
    buckets: Mutex<HashMap<String, std::sync::Arc<Mutex<TokenBucket>>>>,
    semaphores: Mutex<HashMap<String, std::sync::Arc<Semaphore>>>,
}

impl TileClient {
    /// Builds the underlying connection pool.
    pub fn new(config: NetConfig) -> Result<Self, NetError> {
        let mut builder = reqwest::Client::builder()
            .user_agent(&config.user_agent)
            .timeout(config.timeout)
            .connect_timeout(config.connect_timeout)
            .pool_idle_timeout(Duration::from_secs(90))
            .gzip(true)
            .brotli(true)
            .deflate(true);
        if let Some(proxy) = &config.proxy {
            builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(NetError::Client)?);
        }
        let client = builder.build().map_err(NetError::Client)?;
        Ok(Self {
            client,
            config,
            buckets: Mutex::new(HashMap::new()),
            semaphores: Mutex::new(HashMap::new()),
        })
    }

    /// Returns the tuning this client was built with.
    pub fn config(&self) -> &NetConfig {
        &self.config
    }

    /// Fetches a tile unconditionally.
    pub async fn fetch(
        &self,
        provider: &Provider,
        z: u8,
        x: u32,
        y: u32,
    ) -> Result<FetchedTile, NetError> {
        match self
            .fetch_conditional(provider, z, x, y, &Conditional::default())
            .await?
        {
            FetchOutcome::Fetched(tile) => Ok(tile),
            FetchOutcome::NotModified { .. } => Err(NetError::UnexpectedNotModified {
                provider: provider.id.clone(),
            }),
        }
    }

    /// Fetches a small text document such as WMTS `GetCapabilities`.
    ///
    /// Unlike [`Self::fetch`] this does not require a provider or touch the
    /// tile cache; it applies caller headers (API keys) and retries transient
    /// failures with the same backoff policy.
    pub async fn fetch_document(
        &self,
        url: &str,
        headers: &BTreeMap<String, String>,
        limit: usize,
    ) -> Result<String, NetError> {
        let parsed = Url::parse(url).map_err(|error| NetError::Provider {
            provider: "document".to_owned(),
            // URLs may carry API keys in their query string; do not echo them.
            reason: format!("invalid URL: {error}"),
        })?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(NetError::Provider {
                provider: "document".to_owned(),
                reason: format!("unsupported scheme {:?}", parsed.scheme()),
            });
        }
        let mut request_headers = HeaderMap::new();
        for (name, value) in headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
                NetError::InvalidHeader {
                    provider: "document".to_owned(),
                    reason: error.to_string(),
                }
            })?;
            let value = HeaderValue::from_str(value).map_err(|error| NetError::InvalidHeader {
                provider: "document".to_owned(),
                reason: error.to_string(),
            })?;
            request_headers.insert(name, value);
        }
        if !request_headers.contains_key(USER_AGENT) {
            let value = HeaderValue::from_str(&self.config.user_agent).map_err(|error| {
                NetError::InvalidHeader {
                    provider: "document".to_owned(),
                    reason: error.to_string(),
                }
            })?;
            request_headers.insert(USER_AGENT, value);
        }

        let mut attempt = 0_u32;
        loop {
            let outcome = self
                .attempt_document(parsed.clone(), &request_headers, limit)
                .await;
            match outcome {
                Ok(document) => return Ok(document),
                Err(error) => {
                    let retryable = error.is_retryable();
                    if !retryable || attempt >= self.config.max_retries {
                        return if attempt > 0 {
                            Err(NetError::RetryExhausted {
                                attempts: attempt + 1,
                                source: Box::new(error),
                            })
                        } else {
                            Err(error)
                        };
                    }
                    let delay = error.retry_after().unwrap_or_else(|| {
                        backoff(self.config.backoff_base, self.config.backoff_max, attempt)
                    });
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                }
            }
        }
    }

    async fn attempt_document(
        &self,
        url: Url,
        headers: &HeaderMap,
        limit: usize,
    ) -> Result<String, NetError> {
        let response = self
            .client
            .get(url)
            .headers(headers.clone())
            .send()
            .await
            .map_err(|error| NetError::Transport {
                provider: "document".to_owned(),
                source: error.without_url(),
            })?;
        let status = response.status();
        let response_headers = response.headers().clone();
        if !status.is_success() {
            let body = read_prefix(response, MAX_ERROR_PREVIEW).await;
            return Err(NetError::Status {
                provider: "document".to_owned(),
                status: status.as_u16(),
                retry_after: parse_retry_after(&response_headers),
                preview: preview(&body),
            });
        }
        if let Some(length) = response.content_length()
            && length as usize > limit
        {
            return Err(NetError::TooLarge {
                provider: "document".to_owned(),
                size: length as usize,
                limit,
            });
        }
        let body = read_limited(response, limit, "document").await?;
        if body.is_empty() {
            return Err(NetError::Empty {
                provider: "document".to_owned(),
            });
        }
        Ok(String::from_utf8_lossy(&body).into_owned())
    }

    /// Fetches a tile with `If-None-Match` / `If-Modified-Since`.
    pub async fn fetch_conditional(
        &self,
        provider: &Provider,
        z: u8,
        x: u32,
        y: u32,
        conditional: &Conditional,
    ) -> Result<FetchOutcome, NetError> {
        let url = provider
            .tile_url(z, x, y)
            .map_err(|error| NetError::Provider {
                provider: provider.id.clone(),
                reason: error.to_string(),
            })?;
        let mut headers = request_headers(provider, &self.config)?;
        let url = apply_credentials(provider, &url, &self.config, &mut headers)?;
        let bucket = self.bucket_for(provider).await;
        let semaphore = self.semaphore_for(provider).await;

        let mut attempt = 0_u32;
        loop {
            if let Some(bucket) = &bucket {
                bucket.lock().await.acquire().await;
            }
            let permit =
                semaphore
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| NetError::Provider {
                        provider: provider.id.clone(),
                        reason: "concurrency limiter closed".to_owned(),
                    })?;
            let result = self
                .attempt(provider, url.clone(), &headers, conditional)
                .await;
            drop(permit);

            match result {
                Ok(outcome) => return Ok(outcome),
                Err(error) => {
                    let retryable = error.is_retryable();
                    if !retryable || attempt >= self.config.max_retries {
                        return if attempt > 0 {
                            Err(NetError::RetryExhausted {
                                attempts: attempt + 1,
                                source: Box::new(error),
                            })
                        } else {
                            Err(error)
                        };
                    }
                    let delay = error.retry_after().unwrap_or_else(|| {
                        backoff(self.config.backoff_base, self.config.backoff_max, attempt)
                    });
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                }
            }
        }
    }

    async fn attempt(
        &self,
        provider: &Provider,
        url: Url,
        headers: &HeaderMap,
        conditional: &Conditional,
    ) -> Result<FetchOutcome, NetError> {
        let mut request = self.client.get(url).headers(headers.clone());
        if let Some(etag) = &conditional.etag
            && let Ok(value) = HeaderValue::from_str(etag)
        {
            request = request.header(IF_NONE_MATCH, value);
        }
        if let Some(modified) = &conditional.last_modified
            && let Ok(value) = HeaderValue::from_str(modified)
        {
            request = request.header(IF_MODIFIED_SINCE, value);
        }

        let response = request.send().await.map_err(|error| NetError::Transport {
            provider: provider.id.clone(),
            source: error.without_url(),
        })?;
        let status = response.status();
        let response_headers = response.headers().clone();

        if status == reqwest::StatusCode::NOT_MODIFIED {
            let expires_at = ttl_from_headers(&response_headers, self.config.default_ttl);
            return Ok(FetchOutcome::NotModified {
                expires_at: expires_at.expires_at,
                etag: header_string(&response_headers, ETAG).or_else(|| conditional.etag.clone()),
                last_modified: header_string(&response_headers, LAST_MODIFIED)
                    .or_else(|| conditional.last_modified.clone()),
            });
        }

        if let Some(blocked) = response_headers.get("x-blocked") {
            // OSM and some mirrors answer blocked clients with HTTP 200 and a
            // placeholder PNG. Without this check that image would be cached
            // as a real tile and linger after the block is lifted.
            return Err(NetError::Blocked {
                provider: provider.id.clone(),
                reason: blocked.to_str().unwrap_or("access denied").to_owned(),
            });
        }

        if !status.is_success() {
            let retry_after = parse_retry_after(&response_headers);
            // Never buffer an arbitrary error page; a few KiB are enough.
            let body = read_prefix(response, MAX_ERROR_PREVIEW).await;
            return Err(NetError::Status {
                provider: provider.id.clone(),
                status: status.as_u16(),
                retry_after,
                preview: preview(&body),
            });
        }

        if let Some(length) = response.content_length()
            && length as usize > self.config.max_tile_bytes
        {
            return Err(NetError::TooLarge {
                provider: provider.id.clone(),
                size: length as usize,
                limit: self.config.max_tile_bytes,
            });
        }

        let content_type = header_string(&response_headers, CONTENT_TYPE);
        let body = read_limited(response, self.config.max_tile_bytes, &provider.id).await?;
        if body.is_empty() {
            return Err(NetError::Empty {
                provider: provider.id.clone(),
            });
        }
        let detected = sniff_image(&body).ok_or_else(|| NetError::InvalidPayload {
            provider: provider.id.clone(),
            content_type: content_type.clone().unwrap_or_default(),
            preview: preview(&body),
        })?;
        let declared = normalize_format(&provider.format);
        if declared != detected {
            // Some public services (USGS among them) mix PNG and JPEG tiles
            // behind one endpoint. The bytes are still a valid image, and
            // MapLibre sniffs the format, so accept both.
            log::debug!(
                "provider {} declared {declared} but returned {detected}",
                provider.id
            );
        }

        let ttl = ttl_from_headers(&response_headers, self.config.default_ttl);
        Ok(FetchOutcome::Fetched(FetchedTile {
            data: body.to_vec(),
            format: detected,
            content_type,
            etag: header_string(&response_headers, ETAG),
            last_modified: header_string(&response_headers, LAST_MODIFIED),
            expires_at: ttl.expires_at,
            cacheable: ttl.cacheable,
        }))
    }

    async fn bucket_for(&self, provider: &Provider) -> Option<std::sync::Arc<Mutex<TokenBucket>>> {
        let limit = provider.rate_limit?;
        // The rate is part of the key: editing a custom source must take
        // effect immediately instead of reusing the old token bucket.
        let key = format!("{}:{}:{}", provider.id, limit.rps.to_bits(), limit.burst);
        let mut buckets = self.buckets.lock().await;
        Some(
            buckets
                .entry(key)
                .or_insert_with(|| {
                    std::sync::Arc::new(Mutex::new(TokenBucket::new(
                        f64::from(limit.rps),
                        f64::from(limit.burst),
                    )))
                })
                .clone(),
        )
    }

    async fn semaphore_for(&self, provider: &Provider) -> std::sync::Arc<Semaphore> {
        let mut semaphores = self.semaphores.lock().await;
        semaphores
            .entry(provider.id.clone())
            .or_insert_with(|| {
                std::sync::Arc::new(Semaphore::new(
                    self.config.max_concurrent_per_provider.max(1),
                ))
            })
            .clone()
    }
}

fn request_headers(provider: &Provider, config: &NetConfig) -> Result<HeaderMap, NetError> {
    let mut headers = HeaderMap::new();
    for (name, value) in &provider.headers {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|error| NetError::InvalidHeader {
                provider: provider.id.clone(),
                reason: error.to_string(),
            })?;
        let value = HeaderValue::from_str(value).map_err(|error| NetError::InvalidHeader {
            provider: provider.id.clone(),
            reason: error.to_string(),
        })?;
        headers.insert(name, value);
    }
    if !headers.contains_key(USER_AGENT) {
        let value =
            HeaderValue::from_str(&config.user_agent).map_err(|error| NetError::InvalidHeader {
                provider: provider.id.clone(),
                reason: error.to_string(),
            })?;
        headers.insert(USER_AGENT, value);
    }
    Ok(headers)
}

fn apply_credentials(
    provider: &Provider,
    url: &str,
    config: &NetConfig,
    headers: &mut HeaderMap,
) -> Result<Url, NetError> {
    let parse = |value: &str| {
        Url::parse(value).map_err(|error| NetError::Provider {
            provider: provider.id.clone(),
            reason: error.to_string(),
        })
    };
    let Some(auth) = &provider.auth else {
        return parse(url);
    };
    if auth.kind == AuthKind::None {
        return parse(url);
    }
    let Some(credential) = config.credentials.get(&provider.id) else {
        return Err(NetError::MissingCredentials {
            provider: provider.id.clone(),
        });
    };
    match (auth.kind, credential) {
        (AuthKind::Query, Credential::Query(value)) => {
            let name = auth.name.as_deref().ok_or_else(|| NetError::InvalidAuth {
                provider: provider.id.clone(),
                reason: "query auth needs a parameter name".to_owned(),
            })?;
            let mut url = parse(url)?;
            url.query_pairs_mut().append_pair(name, value);
            Ok(url)
        }
        (AuthKind::Header, Credential::Header(value)) => {
            let name = auth.name.as_deref().ok_or_else(|| NetError::InvalidAuth {
                provider: provider.id.clone(),
                reason: "header auth needs a header name".to_owned(),
            })?;
            let name =
                HeaderName::from_bytes(name.as_bytes()).map_err(|error| NetError::InvalidAuth {
                    provider: provider.id.clone(),
                    reason: error.to_string(),
                })?;
            let value = HeaderValue::from_str(value).map_err(|error| NetError::InvalidAuth {
                provider: provider.id.clone(),
                reason: error.to_string(),
            })?;
            headers.insert(name, value);
            parse(url)
        }
        (AuthKind::Basic, Credential::Basic { username, password }) => {
            use base64::Engine;
            let encoded =
                base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
            let value = HeaderValue::from_str(&format!("Basic {encoded}")).map_err(|error| {
                NetError::InvalidAuth {
                    provider: provider.id.clone(),
                    reason: error.to_string(),
                }
            })?;
            headers.insert(reqwest::header::AUTHORIZATION, value);
            parse(url)
        }
        _ => Err(NetError::InvalidAuth {
            provider: provider.id.clone(),
            reason: "credential kind does not match provider auth".to_owned(),
        }),
    }
}

#[derive(Debug)]
struct TokenBucket {
    rate: f64,
    capacity: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    fn new(rate: f64, burst: f64) -> Self {
        Self {
            rate,
            capacity: burst.max(1.0),
            tokens: burst.max(1.0),
            last: Instant::now(),
        }
    }

    async fn acquire(&mut self) {
        loop {
            let now = Instant::now();
            let elapsed = now.duration_since(self.last).as_secs_f64();
            self.tokens = (self.tokens + elapsed * self.rate).min(self.capacity);
            self.last = now;
            if self.tokens >= 1.0 {
                self.tokens -= 1.0;
                return;
            }
            let wait = (1.0 - self.tokens) / self.rate;
            tokio::time::sleep(Duration::from_secs_f64(wait.max(0.001))).await;
        }
    }
}

fn backoff(base: Duration, maximum: Duration, attempt: u32) -> Duration {
    let multiplier = 1_u32.checked_shl(attempt.min(16)).unwrap_or(u32::MAX);
    let raw = base.saturating_mul(multiplier).min(maximum);
    let jitter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() % 100)
        .unwrap_or(0);
    raw + Duration::from_millis(u64::from(jitter))
}

struct Ttl {
    expires_at: Option<i64>,
    cacheable: bool,
}

fn ttl_from_headers(headers: &HeaderMap, default_ttl: Duration) -> Ttl {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let cache_control = header_string(headers, CACHE_CONTROL).unwrap_or_default();
    let directives = cache_control
        .split(',')
        .map(|part| part.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    if directives.iter().any(|part| part == "no-store") {
        return Ttl {
            expires_at: None,
            cacheable: false,
        };
    }
    let age = header_string(headers, AGE)
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(0)
        .max(0);
    for directive in &directives {
        if let Some(value) = directive.strip_prefix("max-age=") {
            let seconds = value.trim().parse::<i64>().unwrap_or(0).max(0);
            // Shared caches must subtract the time the response already spent
            // in an upstream cache.
            return Ttl {
                expires_at: Some(now + (seconds - age).max(0)),
                cacheable: true,
            };
        }
    }
    if directives.iter().any(|part| part == "no-cache") {
        return Ttl {
            expires_at: Some(now),
            cacheable: true,
        };
    }
    if let Some(expires) = header_string(headers, EXPIRES)
        && let Ok(date) = expires.parse::<HttpDate>()
    {
        let expires = SystemTime::from(date);
        let seconds = expires
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        return Ttl {
            expires_at: Some(seconds),
            cacheable: true,
        };
    }
    Ttl {
        expires_at: Some(now + default_ttl.as_secs() as i64),
        cacheable: true,
    }
}

fn parse_retry_after(headers: &HeaderMap) -> Option<Duration> {
    const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);
    let value = header_string(headers, RETRY_AFTER)?;
    let wait = if let Ok(seconds) = value.trim().parse::<u64>() {
        Duration::from_secs(seconds)
    } else {
        let date = value.parse::<HttpDate>().ok()?;
        let target = SystemTime::from(date);
        target
            .duration_since(SystemTime::now())
            .ok()
            .map(|wait| wait.max(Duration::from_millis(100)))?
    };
    // A hostile or misconfigured provider must not park a worker for hours.
    Some(wait.min(MAX_RETRY_AFTER))
}

/// Reads at most `limit` bytes, dropping the connection once exceeded.
async fn read_limited(
    mut response: reqwest::Response,
    limit: usize,
    provider: &str,
) -> Result<Vec<u8>, NetError> {
    let mut body = Vec::with_capacity(limit.min(64 * 1024));
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| NetError::Transport {
                provider: provider.to_owned(),
                source: error.without_url(),
            })?;
        let Some(chunk) = chunk else { break };
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(NetError::TooLarge {
                provider: provider.to_owned(),
                size: body.len().saturating_add(chunk.len()),
                limit,
            });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Reads a short prefix of an error body without trusting its length.
async fn read_prefix(mut response: reqwest::Response, limit: usize) -> Vec<u8> {
    let mut body = Vec::with_capacity(limit.min(8 * 1024));
    while body.len() < limit {
        let Ok(Some(chunk)) = response.chunk().await else {
            break;
        };
        let room = limit - body.len();
        if chunk.len() > room {
            body.extend_from_slice(&chunk[..room]);
            break;
        }
        body.extend_from_slice(&chunk);
    }
    body
}

fn header_string(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn preview(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(MAX_ERROR_PREVIEW).collect()
}

fn normalize_format(format: &str) -> &'static str {
    match format {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        _ => "png",
    }
}

fn sniff_image(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// Fetch errors. URLs are stripped so query-string API keys never leak.
#[derive(Debug, Error)]
pub enum NetError {
    /// Client construction failed.
    #[error("cannot build HTTP client: {0}")]
    Client(#[source] reqwest::Error),
    /// Provider configuration is invalid for a request.
    #[error("provider {provider}: {reason}")]
    Provider { provider: String, reason: String },
    /// Network, TLS or timeout failure.
    #[error("request to provider {provider} failed: {source}")]
    Transport {
        provider: String,
        #[source]
        source: reqwest::Error,
    },
    /// Non-success HTTP status.
    #[error("provider {provider} returned HTTP {status}: {preview}")]
    Status {
        provider: String,
        status: u16,
        retry_after: Option<Duration>,
        preview: String,
    },
    /// Body does not look like the declared image format.
    #[error("provider {provider} returned an invalid tile ({content_type}): {preview}")]
    InvalidPayload {
        provider: String,
        content_type: String,
        preview: String,
    },
    /// The service refused to serve this client.
    #[error("provider {provider} blocked the client: {reason}")]
    Blocked { provider: String, reason: String },
    /// Body is empty.
    #[error("provider {provider} returned an empty tile")]
    Empty { provider: String },
    /// Body exceeds the configured limit.
    #[error("provider {provider} returned {size} bytes, limit is {limit}")]
    TooLarge {
        provider: String,
        size: usize,
        limit: usize,
    },
    /// Provider declares auth but no credential was configured.
    #[error("provider {provider} requires credentials")]
    MissingCredentials { provider: String },
    /// Auth configuration is inconsistent.
    #[error("provider {provider} auth is invalid: {reason}")]
    InvalidAuth { provider: String, reason: String },
    /// Provider header is not a valid HTTP header.
    #[error("provider {provider} header is invalid: {reason}")]
    InvalidHeader { provider: String, reason: String },
    /// 304 without validators, which should not happen.
    #[error("provider {provider} returned 304 to an unconditional request")]
    UnexpectedNotModified { provider: String },
    /// Every retry failed.
    #[error("request failed after {attempts} attempts: {source}")]
    RetryExhausted {
        attempts: u32,
        #[source]
        source: Box<NetError>,
    },
}

impl NetError {
    fn is_retryable(&self) -> bool {
        match self {
            Self::Transport { .. } => true,
            Self::Status { status, .. } => {
                matches!(*status, 408 | 425 | 429 | 500 | 502 | 503 | 504)
            }
            Self::RetryExhausted { .. } => true,
            _ => false,
        }
    }

    fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Status { retry_after, .. } => *retry_after,
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mappa_core::{Auth, AuthKind, Provider};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];

    #[derive(Clone)]
    struct MockResponse {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl MockResponse {
        fn png() -> Self {
            Self {
                status: 200,
                headers: vec![
                    ("Content-Type".into(), "image/png".into()),
                    ("Cache-Control".into(), "max-age=120".into()),
                    ("ETag".into(), "\"v1\"".into()),
                ],
                body: PNG.to_vec(),
            }
        }

        fn status(status: u16) -> Self {
            Self {
                status,
                headers: vec![("Content-Type".into(), "text/html".into())],
                body: b"<html>error</html>".to_vec(),
            }
        }
    }

    async fn mock_server(
        responses: Vec<MockResponse>,
    ) -> (
        String,
        Arc<AtomicUsize>,
        Arc<std::sync::Mutex<Vec<String>>>,
        JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let captures = Arc::new(std::sync::Mutex::new(Vec::new()));
        let counter = Arc::clone(&count);
        let captured = Arc::clone(&captures);
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let responses = responses.clone();
                let counter = Arc::clone(&counter);
                let captured = Arc::clone(&captured);
                tokio::spawn(async move {
                    let mut pending = Vec::new();
                    let mut buffer = [0_u8; 4096];
                    loop {
                        let read = match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(read) => read,
                        };
                        pending.extend_from_slice(&buffer[..read]);
                        while let Some(position) =
                            pending.windows(4).position(|window| window == b"\r\n\r\n")
                        {
                            let request = pending.drain(..position + 4).collect::<Vec<_>>();
                            captured
                                .lock()
                                .unwrap()
                                .push(String::from_utf8_lossy(&request).into_owned());
                            let index = counter.fetch_add(1, Ordering::SeqCst);
                            let response = &responses[index.min(responses.len().saturating_sub(1))];
                            let reason = match response.status {
                                200 => "OK",
                                304 => "Not Modified",
                                404 => "Not Found",
                                429 => "Too Many Requests",
                                500 => "Internal Server Error",
                                503 => "Service Unavailable",
                                _ => "Test",
                            };
                            let mut head = format!(
                                "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n",
                                response.status,
                                reason,
                                response.body.len()
                            );
                            for (name, value) in &response.headers {
                                head.push_str(name);
                                head.push_str(": ");
                                head.push_str(value);
                                head.push_str("\r\n");
                            }
                            head.push_str("\r\n");
                            if socket.write_all(head.as_bytes()).await.is_err()
                                || socket.write_all(&response.body).await.is_err()
                            {
                                return;
                            }
                        }
                    }
                });
            }
        });
        (format!("http://{address}"), count, captures, handle)
    }

    fn provider(url: &str) -> Provider {
        let mut provider =
            Provider::from_yaml(include_str!("../../../providers/osm.yaml")).unwrap();
        provider.url = format!("{url}/{{z}}/{{x}}/{{y}}.png");
        provider.rate_limit = None;
        provider
    }

    fn config() -> NetConfig {
        NetConfig {
            max_retries: 2,
            backoff_base: Duration::from_millis(1),
            backoff_max: Duration::from_millis(5),
            timeout: Duration::from_secs(5),
            ..NetConfig::default()
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fetches_and_parses_headers() {
        let (base, count, _, server) = mock_server(vec![MockResponse::png()]).await;
        let client = TileClient::new(config()).unwrap();
        let tile = client.fetch(&provider(&base), 1, 0, 1).await.unwrap();
        assert_eq!(tile.data, PNG);
        assert_eq!(tile.format, "png");
        assert_eq!(tile.etag.as_deref(), Some("\"v1\""));
        assert!(tile.cacheable);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert!(tile.expires_at.unwrap() >= now + 115);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fetches_documents_with_headers_and_limits() {
        let document = MockResponse {
            status: 200,
            headers: vec![("Content-Type".into(), "text/xml".into())],
            body: b"<Capabilities/>".to_vec(),
        };
        let (base, count, captures, server) = mock_server(vec![document]).await;
        let client = TileClient::new(config()).unwrap();
        let headers = BTreeMap::from([("X-Api-Key".to_owned(), "secret".to_owned())]);
        let url = format!("{base}/wmts?service=WMTS&request=GetCapabilities");
        let text = client.fetch_document(&url, &headers, 4096).await.unwrap();
        assert_eq!(text, "<Capabilities/>");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let request = captures.lock().unwrap()[0].to_ascii_lowercase();
        assert!(request.contains("x-api-key: secret"));
        assert!(request.contains("user-agent: mappa/"));
        assert!(request.starts_with("get /wmts?service=wmts"));

        let too_large = client.fetch_document(&url, &BTreeMap::new(), 4).await;
        assert!(matches!(too_large, Err(NetError::TooLarge { .. })));
        let bad_scheme = client
            .fetch_document("ftp://example.org/wmts", &BTreeMap::new(), 4096)
            .await;
        assert!(matches!(bad_scheme, Err(NetError::Provider { .. })));
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_blocked_placeholder_tiles() {
        let mut blocked = MockResponse::png();
        blocked
            .headers
            .push(("x-blocked".into(), "Access denied".into()));
        let (base, count, _, server) = mock_server(vec![blocked]).await;
        let client = TileClient::new(config()).unwrap();
        let error = client.fetch(&provider(&base), 1, 0, 1).await.unwrap_err();
        assert!(matches!(error, NetError::Blocked { .. }));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn retries_transient_errors() {
        let (base, count, _, server) = mock_server(vec![
            MockResponse::status(500),
            MockResponse::status(503),
            MockResponse::png(),
        ])
        .await;
        let client = TileClient::new(config()).unwrap();
        let tile = client.fetch(&provider(&base), 1, 0, 1).await.unwrap();
        assert_eq!(tile.data, PNG);
        assert_eq!(count.load(Ordering::SeqCst), 3);
        server.abort();
    }

    #[test]
    fn clamps_retry_after() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("86400"));
        assert_eq!(parse_retry_after(&headers), Some(Duration::from_secs(30)));
        headers.insert(RETRY_AFTER, HeaderValue::from_static("2"));
        assert_eq!(parse_retry_after(&headers), Some(Duration::from_secs(2)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn honours_retry_after() {
        let mut limit = MockResponse::status(429);
        limit.headers.push(("Retry-After".into(), "0".into()));
        let (base, count, _, server) = mock_server(vec![limit, MockResponse::png()]).await;
        let client = TileClient::new(config()).unwrap();
        let tile = client.fetch(&provider(&base), 1, 0, 1).await.unwrap();
        assert_eq!(tile.data, PNG);
        assert_eq!(count.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn does_not_retry_client_errors() {
        let (base, count, _, server) = mock_server(vec![MockResponse::status(404)]).await;
        let client = TileClient::new(config()).unwrap();
        let error = client.fetch(&provider(&base), 1, 0, 1).await.unwrap_err();
        assert!(matches!(error, NetError::Status { status: 404, .. }));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn retries_exhaust_and_report_attempts() {
        let (base, count, _, server) = mock_server(vec![MockResponse::status(500)]).await;
        let client = TileClient::new(NetConfig {
            max_retries: 2,
            ..config()
        })
        .unwrap();
        let error = client.fetch(&provider(&base), 1, 0, 1).await.unwrap_err();
        assert!(matches!(
            error,
            NetError::RetryExhausted { attempts: 3, .. }
        ));
        assert_eq!(count.load(Ordering::SeqCst), 3);
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_html_with_200() {
        let (base, _, _, server) = mock_server(vec![MockResponse {
            status: 200,
            headers: vec![("Content-Type".into(), "text/html".into())],
            body: b"<html>blocked</html>".to_vec(),
        }])
        .await;
        let client = TileClient::new(config()).unwrap();
        let error = client.fetch(&provider(&base), 1, 0, 1).await.unwrap_err();
        assert!(matches!(error, NetError::InvalidPayload { .. }));
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn conditional_request_reports_not_modified() {
        let (base, _, _, server) = mock_server(vec![
            MockResponse::png(),
            MockResponse {
                status: 304,
                headers: vec![("Cache-Control".into(), "max-age=60".into())],
                body: Vec::new(),
            },
        ])
        .await;
        let client = TileClient::new(config()).unwrap();
        let provider = provider(&base);
        let first = client.fetch(&provider, 1, 0, 1).await.unwrap();
        let outcome = client
            .fetch_conditional(
                &provider,
                1,
                0,
                1,
                &Conditional {
                    etag: first.etag,
                    last_modified: None,
                },
            )
            .await
            .unwrap();
        assert!(matches!(outcome, FetchOutcome::NotModified { .. }));
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rate_limit_delays_second_request() {
        let (base, _, _, server) = mock_server(vec![MockResponse::png()]).await;
        let mut provider = provider(&base);
        provider.rate_limit = Some(mappa_core::RateLimit {
            rps: 20.0,
            burst: 1,
        });
        let client = TileClient::new(config()).unwrap();
        let start = Instant::now();
        client.fetch(&provider, 1, 0, 1).await.unwrap();
        client.fetch(&provider, 1, 0, 1).await.unwrap();
        assert!(start.elapsed() >= Duration::from_millis(30));
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sends_header_credential() {
        let (base, _, captures, server) = mock_server(vec![MockResponse::png()]).await;
        let mut provider = provider(&base);
        provider.auth = Some(Auth {
            kind: AuthKind::Header,
            name: Some("X-Api-Key".into()),
        });
        let mut config = config();
        config
            .credentials
            .insert("osm".into(), Credential::Header("s3cret".into()));
        let client = TileClient::new(config).unwrap();
        client.fetch(&provider, 1, 0, 1).await.unwrap();
        let request = captures.lock().unwrap()[0].to_ascii_lowercase();
        assert!(request.contains("x-api-key: s3cret"), "{request}");
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sends_query_credential() {
        let (base, _, captures, server) = mock_server(vec![MockResponse::png()]).await;
        let mut provider = provider(&base);
        provider.auth = Some(Auth {
            kind: AuthKind::Query,
            name: Some("key".into()),
        });
        let mut config = config();
        config
            .credentials
            .insert("osm".into(), Credential::Query("s3cret".into()));
        let client = TileClient::new(config).unwrap();
        client.fetch(&provider, 1, 0, 1).await.unwrap();
        let request = captures.lock().unwrap()[0].clone();
        assert!(request.contains("key=s3cret"), "{request}");
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sends_basic_credential() {
        let (base, _, captures, server) = mock_server(vec![MockResponse::png()]).await;
        let mut provider = provider(&base);
        provider.auth = Some(Auth {
            kind: AuthKind::Basic,
            name: None,
        });
        let mut config = config();
        config.credentials.insert(
            "osm".into(),
            Credential::Basic {
                username: "user".into(),
                password: "pass".into(),
            },
        );
        let client = TileClient::new(config).unwrap();
        client.fetch(&provider, 1, 0, 1).await.unwrap();
        let request = captures.lock().unwrap()[0].to_ascii_lowercase();
        // base64("user:pass")
        assert!(
            request.contains("authorization: basic dxnlcjpwyxnz"),
            "{request}"
        );
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reports_missing_credentials_without_connecting() {
        let (base, count, _, server) = mock_server(vec![MockResponse::png()]).await;
        let mut provider = provider(&base);
        provider.auth = Some(Auth {
            kind: AuthKind::Header,
            name: Some("X-Api-Key".into()),
        });
        let client = TileClient::new(config()).unwrap();
        let error = client.fetch(&provider, 1, 0, 1).await.unwrap_err();
        assert!(matches!(error, NetError::MissingCredentials { .. }));
        assert_eq!(count.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn accepts_mixed_image_formats() {
        let (base, _, _, server) = mock_server(vec![MockResponse {
            status: 200,
            headers: vec![("Content-Type".into(), "image/jpeg".into())],
            body: vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10],
        }])
        .await;
        let client = TileClient::new(config()).unwrap();
        let tile = client.fetch(&provider(&base), 1, 0, 1).await.unwrap();
        assert_eq!(tile.format, "jpg");
        assert_eq!(tile.content_type.as_deref(), Some("image/jpeg"));
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn subtracts_age_from_max_age() {
        let (base, _, _, server) = mock_server(vec![MockResponse {
            status: 200,
            headers: vec![
                ("Content-Type".into(), "image/png".into()),
                ("Cache-Control".into(), "max-age=120".into()),
                ("Age".into(), "20".into()),
            ],
            body: PNG.to_vec(),
        }])
        .await;
        let client = TileClient::new(config()).unwrap();
        let tile = client.fetch(&provider(&base), 1, 0, 1).await.unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let expires = tile.expires_at.unwrap();
        assert!(expires >= now + 95 && expires <= now + 102, "{expires}");
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn honours_no_store() {
        let (base, _, _, server) = mock_server(vec![MockResponse {
            status: 200,
            headers: vec![
                ("Content-Type".into(), "image/png".into()),
                ("Cache-Control".into(), "no-store".into()),
            ],
            body: PNG.to_vec(),
        }])
        .await;
        let client = TileClient::new(config()).unwrap();
        let tile = client.fetch(&provider(&base), 1, 0, 1).await.unwrap();
        assert!(!tile.cacheable);
        assert!(tile.expires_at.is_none());
        server.abort();
    }

    #[test]
    fn sniffs_supported_formats() {
        assert_eq!(sniff_image(PNG), Some("png"));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(sniff_image(b"RIFF1234WEBP"), Some("webp"));
        assert_eq!(sniff_image(b"<html>"), None);
    }

    #[test]
    fn backoff_grows_and_caps() {
        let base = Duration::from_millis(10);
        let max = Duration::from_millis(100);
        assert!(backoff(base, max, 0) >= base);
        assert!(backoff(base, max, 10) <= max + Duration::from_millis(99));
    }
}
