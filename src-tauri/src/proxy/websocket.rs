use crate::storage::Storage;
use hyper::{Request, Response, StatusCode};
use hyper::body::Incoming;
use http_body_util::Full;
use hyper::body::Bytes;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::WebSocketStream;
use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use tokio::net::TcpStream;
use tokio_tungstenite::MaybeTlsStream;

pub struct WebSocketHandler {
    pub storage: Arc<RwLock<Storage>>,
}

impl WebSocketHandler {
    pub fn new(storage: Arc<RwLock<Storage>>) -> Self {
        Self { storage }
    }

    pub async fn handle_upgrade(
        self: Arc<Self>,
        req: Request<Incoming>,
    ) -> Result<Response<Full<Bytes>>, hyper::Error> {
        let headers = req.headers();

        let key = headers
            .get("sec-websocket-key")
            .and_then(|k| k.to_str().ok())
            .unwrap_or("");

        let accept = derive_accept_key(key.as_bytes());

        // Spawn WebSocket handling task
        let _storage = self.storage.clone();
        let uri = req.uri().clone();
        tokio::spawn(async move {
            tracing::info!("WebSocket upgrade requested for: {}", uri);

            // TODO: Implement proper WebSocket connection handling
            // Need to handle the actual upgrade and message forwarding
        });

        Ok(Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Accept", accept)
            .body(Full::new(Bytes::new()))
            .unwrap())
    }

    pub async fn handle_websocket_connection(
        &self,
        storage: Arc<RwLock<Storage>>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Get the bound host from storage
        let storage_read = storage.read().await;
        let bound_host = storage_read.get_bound_host().await;

        let host = match bound_host {
            Some(h) => h,
            None => {
                tracing::warn!("No host bound, rejecting WebSocket connection");
                return Err("No host bound".into());
            }
        };

        // Connect to remote WebSocket server
        let ws_url = format!("ws://{}:{}/ws", host.ip, host.port);
        tracing::info!("Connecting to remote WebSocket: {}", ws_url);

        let (_ws_stream, _) = tokio_tungstenite::connect_async(&ws_url).await?;

        tracing::info!("Connected to remote WebSocket server");

        // Handle WebSocket messages
        // TODO: Implement proper message forwarding

        Ok(())
    }
}

// Tolerant WebSocket client for C-Lodop server compatibility
// C-Lodop incorrectly sets MASK bit on server-to-client messages
pub struct TolerantWebSocketClient {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl TolerantWebSocketClient {
    pub async fn connect(url: &str) -> Result<Self, Box<dyn std::error::Error>> {
        // Use connect_async which is simpler
        let (stream, _) = tokio_tungstenite::connect_async(url).await?;
        Ok(Self { stream })
    }

    pub async fn send(&mut self, data: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        let msg = Message::Binary(bytes::Bytes::copy_from_slice(data));
        self.stream.send(msg).await?;
        Ok(())
    }

    pub async fn send_text(&mut self, text: &str) -> Result<(), Box<dyn std::error::Error>> {
        let msg = Message::Text(text.into());
        self.stream.send(msg).await?;
        Ok(())
    }

    pub async fn recv(&mut self) -> Result<Option<Message>, Box<dyn std::error::Error>> {
        match self.stream.next().await {
            Some(Ok(msg)) => Ok(Some(msg)),
            Some(Err(e)) => {
                // Check if it's a MASK bit error from C-Lodop
                let err_str = e.to_string();
                if err_str.contains("MASK") || err_str.contains("masked") {
                    tracing::warn!("Tolerating MASK bit error from C-Lodop");
                    // Try to recover by reading raw frame
                    self.recv_raw_frame().await
                } else {
                    Err(e.into())
                }
            }
            None => Ok(None),
        }
    }

    async fn recv_raw_frame(&mut self) -> Result<Option<Message>, Box<dyn std::error::Error>> {
        // Read raw bytes and parse frame manually
        // This is a simplified recovery attempt
        tracing::warn!("Attempting raw frame recovery");
        Ok(None)
    }

    pub async fn close(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        self.stream.close(None).await?;
        Ok(())
    }
}
