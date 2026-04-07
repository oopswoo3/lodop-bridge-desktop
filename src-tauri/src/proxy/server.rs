use crate::diagnostics::{run_host_diagnosis, HostDiagnosis};
use crate::storage::{HostInfo, Storage};
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;

use super::websocket::WebSocketHandler;

const PRIMARY_PROXY_PORT: u16 = 8000;
const FALLBACK_PROXY_PORT: u16 = 18000;
const LOOPBACK_HOST: &str = "127.0.0.1";

type HttpResponse = Response<Full<Bytes>>;

pub struct ProxyServer {
    port: u16,
    listener: TcpListener,
    storage: Arc<RwLock<Storage>>,
    last_diagnosis: Arc<RwLock<Option<HostDiagnosis>>>,
}

impl ProxyServer {
    pub async fn new(
        storage: Arc<RwLock<Storage>>,
        last_diagnosis: Arc<RwLock<Option<HostDiagnosis>>>,
    ) -> Result<Self, String> {
        let (listener, port) = bind_proxy_listener().await?;
        Ok(Self {
            port,
            listener,
            storage,
            last_diagnosis,
        })
    }

    pub fn get_port(&self) -> u16 {
        self.port
    }

    pub async fn run(self) -> Result<(), Box<dyn std::error::Error>> {
        let addr = SocketAddr::from(([127, 0, 0, 1], self.port));
        tracing::info!("Proxy server listening on http://{}", addr);

        let ws_handler = Arc::new(WebSocketHandler::new(self.storage.clone(), self.port));

        loop {
            let (stream, _) = self.listener.accept().await?;
            let io = TokioIo::new(stream);
            let ws_handler = ws_handler.clone();
            let local_port = self.port;
            let last_diagnosis = self.last_diagnosis.clone();

            tokio::spawn(async move {
                let service = service_fn(move |req| {
                    let ws_handler = ws_handler.clone();
                    let last_diagnosis = last_diagnosis.clone();
                    async move { handle_request(req, ws_handler, local_port, last_diagnosis).await }
                });

                if let Err(err) = http1::Builder::new()
                    .preserve_header_case(true)
                    .title_case_headers(true)
                    .serve_connection(io, service)
                    .with_upgrades()
                    .await
                {
                    tracing::error!("Error serving connection: {:?}", err);
                }
            });
        }
    }
}

async fn bind_proxy_listener() -> Result<(TcpListener, u16), String> {
    for port in [PRIMARY_PROXY_PORT, FALLBACK_PROXY_PORT] {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        match TcpListener::bind(addr).await {
            Ok(listener) => return Ok((listener, port)),
            Err(err) => {
                tracing::warn!("Port {} is unavailable: {}", port, err);
            }
        }
    }

    Err(format!(
        "端口 {} 和 {} 都不可用，请释放端口后重试",
        PRIMARY_PROXY_PORT, FALLBACK_PROXY_PORT
    ))
}

async fn handle_request(
    req: Request<hyper::body::Incoming>,
    ws_handler: Arc<WebSocketHandler>,
    local_port: u16,
    last_diagnosis: Arc<RwLock<Option<HostDiagnosis>>>,
) -> Result<HttpResponse, hyper::Error> {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req.headers().clone();
    let path = uri.path().to_string();

    tracing::info!("{} {}", method, uri);

    let is_websocket = headers
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    if is_websocket {
        if path == "/ws" || path.starts_with("/c_webskt") {
            return ws_handler.handle_upgrade(req).await;
        }
        return Ok(not_found());
    }

    match (method.as_str(), path.as_str()) {
        ("GET", "/CLodopfuncs.js") => handle_clodopfuncs(ws_handler, local_port).await,
        ("GET", "/demo/index.html") => Ok(handle_demo_index(local_port)),
        ("GET", "/api/status") => handle_status(ws_handler).await,
        ("GET", "/api/diag/last") => handle_diag_last(ws_handler, last_diagnosis).await,
        ("POST", "/api/bind") => handle_bind(req, ws_handler).await,
        ("POST", "/api/unbind") => handle_unbind(ws_handler).await,
        _ => Ok(not_found()),
    }
}

fn handle_demo_index(local_port: u16) -> HttpResponse {
    let template = include_str!("../../../demo/index.html");
    let body = rewrite_demo_index(template, local_port);

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/html; charset=utf-8")
        .body(Full::new(Bytes::from(body)))
        .expect("demo response should be valid")
}

async fn handle_clodopfuncs(
    ws_handler: Arc<WebSocketHandler>,
    local_port: u16,
) -> Result<HttpResponse, hyper::Error> {
    let storage = ws_handler.storage.read().await;
    let bound_host = storage.get_bound_host().await;
    drop(storage);

    match bound_host {
        Some(host) => match fetch_and_replace_clodopfuncs(&host, local_port).await {
            Ok(content) => Ok(Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/javascript; charset=utf-8")
                .body(Full::new(Bytes::from(content)))
                .expect("CLodopfuncs response should be valid")),
            Err(err) => Ok(string_response(
                StatusCode::BAD_GATEWAY,
                format!("Failed to fetch CLodopfuncs.js: {}", err),
            )),
        },
        None => Ok(string_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "No host bound",
        )),
    }
}

async fn fetch_and_replace_clodopfuncs(
    host: &HostInfo,
    local_port: u16,
) -> Result<String, Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let url = format!("http://{}:{}/CLodopfuncs.js", host.ip, host.port);

    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(format!("Remote server returned {}", resp.status()).into());
    }

    let content = resp.text().await?;
    Ok(rewrite_clodopfuncs(&content, host, local_port))
}

fn rewrite_clodopfuncs(content: &str, host: &HostInfo, local_port: u16) -> String {
    let escaped_ip = regex::escape(&host.ip);

    // Replace protocol+ip+port first.
    let protocol_re = regex::Regex::new(&format!(r"(https?|wss?)://{}:{}", escaped_ip, host.port))
        .expect("protocol regex should compile");
    let replaced_protocol = protocol_re.replace_all(content, |caps: &regex::Captures| {
        format!("{}://{}:{}", &caps[1], LOOPBACK_HOST, local_port)
    });

    // Replace plain ip:port.
    let ip_port_re =
        regex::Regex::new(&format!(r"{}:{}", escaped_ip, host.port)).expect("ip:port regex");
    let replaced_ip_port = ip_port_re.replace_all(
        &replaced_protocol,
        format!("{}:{}", LOOPBACK_HOST, local_port),
    );

    // Replace standalone IP.
    let ip_re = regex::Regex::new(&format!(r"\b{}\b", escaped_ip)).expect("ip regex");
    let replaced_ip = ip_re
        .replace_all(&replaced_ip_port, LOOPBACK_HOST)
        .to_string();

    // C-Lodop scripts may still use localhost/127.0.0.1 with static ports.
    // Force all local loopback websocket/http targets to the active proxy port.
    let loopback_with_protocol_re =
        regex::Regex::new(r"(https?|wss?)://(?:localhost|127\.0\.0\.1):\d+")
            .expect("loopback protocol regex");
    let replaced_loopback_protocol = loopback_with_protocol_re
        .replace_all(&replaced_ip, |caps: &regex::Captures| {
            format!("{}://{}:{}", &caps[1], LOOPBACK_HOST, local_port)
        });

    let loopback_ip_port_re =
        regex::Regex::new(r"(?:localhost|127\.0\.0\.1):\d+").expect("loopback ip:port regex");
    let replaced_loopback_ip_port = loopback_ip_port_re.replace_all(
        &replaced_loopback_protocol,
        format!("{}:{}", LOOPBACK_HOST, local_port),
    );

    replaced_loopback_ip_port.replace("localhost", LOOPBACK_HOST)
}

fn rewrite_demo_index(template: &str, local_port: u16) -> String {
    let script_url = format!("http://{}:{}/CLodopfuncs.js", LOOPBACK_HOST, local_port);
    let mut body = template.to_string();

    for pattern in [
        r#"https?://localhost:\d+/CLodopfuncs\.js"#,
        r#"https?://127\.0\.0\.1:\d+/CLodopfuncs\.js"#,
    ] {
        let re = regex::Regex::new(pattern).expect("demo script regex should compile");
        body = re.replace_all(&body, script_url.as_str()).to_string();
    }

    body
}

async fn handle_status(ws_handler: Arc<WebSocketHandler>) -> Result<HttpResponse, hyper::Error> {
    let storage = ws_handler.storage.read().await;
    let bound_host = storage.get_bound_host().await;
    drop(storage);

    let (online, error) = match &bound_host {
        Some(host) => match verify_host_reachable(&host.ip, host.port, 1_500).await {
            Ok(_) => (true, Option::<String>::None),
            Err(err) => (false, Some(err)),
        },
        None => (false, Some("未绑定主机".to_string())),
    };

    let body = serde_json::json!({
        "boundHost": bound_host,
        "status": {
            "online": online,
            "error": error
        }
    });

    Ok(json_response(StatusCode::OK, body))
}

async fn handle_diag_last(
    ws_handler: Arc<WebSocketHandler>,
    last_diagnosis: Arc<RwLock<Option<HostDiagnosis>>>,
) -> Result<HttpResponse, hyper::Error> {
    let bound_host = {
        let storage = ws_handler.storage.read().await;
        storage.get_bound_host().await
    };

    let Some(host) = bound_host else {
        return Ok(json_response(
            StatusCode::OK,
            serde_json::json!({
                "summary": {
                    "ok": false,
                    "phase": "idle",
                    "error": "未绑定主机"
                }
            }),
        ));
    };

    let diagnosis = run_host_diagnosis(&host.ip, Some(host.port), 1_500).await;
    {
        let mut last = last_diagnosis.write().await;
        *last = Some(diagnosis.clone());
    }

    Ok(json_response(
        StatusCode::OK,
        serde_json::to_value(diagnosis).unwrap_or_else(|_| {
            serde_json::json!({
                "summary": {
                    "ok": false,
                    "phase": "unknown",
                    "error": "诊断序列化失败"
                }
            })
        }),
    ))
}

#[derive(Debug, Deserialize)]
struct BindHostPayload {
    ip: String,
    port: u16,
}

async fn handle_bind(
    req: Request<hyper::body::Incoming>,
    ws_handler: Arc<WebSocketHandler>,
) -> Result<HttpResponse, hyper::Error> {
    let mut body = req.into_body();
    let bytes = BodyExt::collect(&mut body).await?.to_bytes();
    let payload = match serde_json::from_slice::<BindHostPayload>(&bytes) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(string_response(
                StatusCode::BAD_REQUEST,
                format!("Invalid payload: {}", err),
            ))
        }
    };

    if payload.ip.trim().is_empty() || payload.port == 0 {
        return Ok(string_response(
            StatusCode::BAD_REQUEST,
            "IP and port required",
        ));
    }

    if let Err(err) = verify_host_reachable(&payload.ip, payload.port, 1_500).await {
        return Ok(string_response(
            StatusCode::BAD_REQUEST,
            format!("Host not reachable: {}", err),
        ));
    }

    let mut storage = ws_handler.storage.write().await;
    let set_result = storage
        .set_bound_host(HostInfo {
            ip: payload.ip.clone(),
            port: payload.port,
            hostname: None,
            os: None,
            version: None,
            rtt: None,
            tcp_ok: Some(true),
            script_ok: Some(true),
            timestamp: chrono::Utc::now().timestamp_millis(),
        })
        .await;
    drop(storage);

    match set_result {
        Ok(_) => Ok(json_response(
            StatusCode::OK,
            serde_json::json!({
                "success": true,
                "host": {
                    "ip": payload.ip,
                    "port": payload.port
                }
            }),
        )),
        Err(err) => Ok(string_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to persist binding: {}", err),
        )),
    }
}

async fn handle_unbind(ws_handler: Arc<WebSocketHandler>) -> Result<HttpResponse, hyper::Error> {
    let mut storage = ws_handler.storage.write().await;
    let clear_result = storage.clear_bound_host().await;
    drop(storage);

    match clear_result {
        Ok(_) => Ok(json_response(
            StatusCode::OK,
            serde_json::json!({ "success": true }),
        )),
        Err(err) => Ok(string_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to clear binding: {}", err),
        )),
    }
}

pub async fn verify_host_reachable(ip: &str, port: u16, timeout_ms: u64) -> Result<(), String> {
    let addr = format!("{}:{}", ip, port);
    let timeout = Duration::from_millis(timeout_ms.clamp(200, 15_000));

    match tokio::time::timeout(timeout, TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => return Err(format!("TCP connect failed: {}", err)),
        Err(_) => return Err("TCP connect timeout".to_string()),
    }

    let http_timeout = Duration::from_millis((timeout_ms * 2).clamp(500, 20_000));
    let client = reqwest::Client::builder()
        .timeout(http_timeout)
        .build()
        .map_err(|err| format!("HTTP client init failed: {}", err))?;

    for endpoint in ["c_sysmessage", "CLodopfuncs.js"] {
        let url = format!("http://{}:{}/{}", ip, port, endpoint);
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(_) => continue,
            Err(_) => continue,
        }
    }

    Err("Host reachable but C-Lodop endpoints are unavailable".to_string())
}

fn json_response(status: StatusCode, body: serde_json::Value) -> HttpResponse {
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json; charset=utf-8")
        .body(Full::new(Bytes::from(body.to_string())))
        .expect("json response should be valid")
}

fn string_response(status: StatusCode, body: impl Into<String>) -> HttpResponse {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(Full::new(Bytes::from(body.into())))
        .expect("string response should be valid")
}

fn not_found() -> HttpResponse {
    string_response(StatusCode::NOT_FOUND, "Not Found")
}
