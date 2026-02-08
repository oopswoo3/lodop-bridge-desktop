use crate::storage::{HostInfo, Storage};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use super::websocket::WebSocketHandler;

pub struct ProxyServer {
    port: u16,
    storage: Arc<RwLock<Storage>>,
}

impl ProxyServer {
    pub async fn new(storage: Arc<RwLock<Storage>>) -> Self {
        Self {
            port: 8000,
            storage,
        }
    }

    pub fn get_port(&self) -> u16 {
        self.port
    }

    pub async fn run(self) -> Result<(), Box<dyn std::error::Error>> {
        let addr = SocketAddr::from(([127, 0, 0, 1], self.port));
        let listener = TcpListener::bind(addr).await?;

        tracing::info!("Proxy server listening on http://{}", addr);

        let ws_handler = Arc::new(WebSocketHandler::new(self.storage.clone()));

        loop {
            let (stream, _) = listener.accept().await?;
            let io = TokioIo::new(stream);
            let ws_handler = ws_handler.clone();

            tokio::spawn(async move {
                let service = service_fn(move |req| {
                    let ws_handler = ws_handler.clone();
                    async move {
                        handle_request(req, ws_handler).await
                    }
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

async fn handle_request(
    req: Request<hyper::body::Incoming>,
    ws_handler: Arc<WebSocketHandler>,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req.headers().clone();

    tracing::info!("{} {}", method, uri);

    let is_websocket = headers
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    if is_websocket {
        return ws_handler.handle_upgrade(req).await;
    }

    match (method.as_str(), uri.path()) {
        ("GET", "/CLodopfuncs.js") => handle_clodopfuncs(req, ws_handler).await,
        ("GET", "/api/status") => handle_status(ws_handler).await,
        ("POST", "/api/bind") => handle_bind(req, ws_handler).await,
        ("POST", "/api/unbind") => handle_unbind(ws_handler).await,
        ("GET", "/api/printers") => handle_printers(ws_handler).await,
        ("POST", "/api/test-print") => handle_test_print(req, ws_handler).await,
        _ => Ok(not_found()),
    }
}

async fn handle_clodopfuncs(
    _req: Request<hyper::body::Incoming>,
    ws_handler: Arc<WebSocketHandler>,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let storage = ws_handler.storage.read().await;
    let bound_host = storage.get_bound_host().await;

    match bound_host {
        Some(host) => {
            match fetch_and_replace_clodopfuncs(&host).await {
                Ok(content) => Ok(Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "application/javascript; charset=utf-8")
                    .body(Full::new(Bytes::from(content)))
                    .unwrap()),
                Err(_) => Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Full::new(Bytes::from("Failed to fetch CLodopfuncs.js")))
                    .unwrap()),
            }
        }
        None => Ok(Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .body(Full::new(Bytes::from("No host bound")))
            .unwrap()),
    }
}

async fn fetch_and_replace_clodopfuncs(host: &HostInfo) -> Result<String, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let url = format!("http://{}:{}/CLodopfuncs.js", host.ip, host.port);

    let resp = client.get(&url).send().await?;
    let content = resp.text().await?;

    let escaped_ip = regex::escape(&host.ip);
    let re = regex::Regex::new(&format!(r"(https?://)?{}:{}|{}", escaped_ip, host.port, escaped_ip)).unwrap();
    let replaced = re.replace_all(&content, "localhost:8000").to_string();

    Ok(replaced)
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
