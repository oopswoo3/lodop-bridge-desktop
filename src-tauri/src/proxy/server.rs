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

async fn handle_status(
    ws_handler: Arc<WebSocketHandler>,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let storage = ws_handler.storage.read().await;
    let bound_host = storage.get_bound_host().await;

    let body = serde_json::json!({
        "boundHost": bound_host,
        "status": "online",
    });

    Ok(Response::builder()
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap())
}

async fn handle_bind(
    req: Request<hyper::body::Incoming>,
    ws_handler: Arc<WebSocketHandler>,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let mut body = req.into_body();
    let bytes = BodyExt::collect(&mut body).await?.to_bytes();
    let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    let ip = data["ip"].as_str().unwrap_or("");
    let port = data["port"].as_u64().unwrap_or(0) as u16;

    if ip.is_empty() || port == 0 {
        return Ok(Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Full::new(Bytes::from("IP and port required")))
            .unwrap());
    }

    let mut storage = ws_handler.storage.write().await;
    let _ = storage.set_bound_host(HostInfo {
        ip: ip.to_string(),
        port,
        hostname: None,
        os: None,
        version: None,
        rtt: None,
        timestamp: chrono::Utc::now().timestamp_millis(),
    }).await;

    let body = serde_json::json!({ "success": true, "host": { "ip": ip, "port": port } });
    Ok(Response::builder()
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap())
}

async fn handle_unbind(
    ws_handler: Arc<WebSocketHandler>,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let mut storage = ws_handler.storage.write().await;
    let _ = storage.clear_bound_host().await;

    Ok(Response::builder()
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(r#"{"success":true}"#)))
        .unwrap())
}

async fn handle_printers(
    _ws_handler: Arc<WebSocketHandler>,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let body = serde_json::json!({ "printers": ["默认打印机"] });
    Ok(Response::builder()
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap())
}

async fn handle_test_print(
    req: Request<hyper::body::Incoming>,
    _ws_handler: Arc<WebSocketHandler>,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let mut body = req.into_body();
    let bytes = BodyExt::collect(&mut body).await?.to_bytes();
    let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let printer = data.get("printer").and_then(|v| v.as_str());

    tracing::info!("Test print requested for printer: {:?}", printer);

    Ok(Response::builder()
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(r#"{"success":true}"#)))
        .unwrap())
}

fn not_found() -> Response<Full<Bytes>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Full::new(Bytes::from("Not Found")))
        .unwrap()
}
