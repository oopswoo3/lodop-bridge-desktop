use crate::storage::Storage;
use bytes::{Buf, Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Bytes as HyperBytes;
use hyper::body::Incoming;
use hyper::upgrade::Upgraded;
use hyper::{Request, Response, StatusCode, Uri};
use hyper_util::rt::TokioIo;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, RwLock};
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::{Message, Role};
use tokio_tungstenite::WebSocketStream;

pub struct WebSocketHandler {
    pub storage: Arc<RwLock<Storage>>,
    local_port: u16,
}

impl WebSocketHandler {
    pub fn new(storage: Arc<RwLock<Storage>>, local_port: u16) -> Self {
        Self {
            storage,
            local_port,
        }
    }

    pub async fn handle_upgrade(
        self: Arc<Self>,
        req: Request<Incoming>,
    ) -> Result<Response<Full<HyperBytes>>, hyper::Error> {
        let key = req
            .headers()
            .get("sec-websocket-key")
            .and_then(|k| k.to_str().ok())
            .unwrap_or("");

        if key.is_empty() {
            return Ok(Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Full::new(HyperBytes::from("Missing sec-websocket-key")))
                .expect("bad request response should be valid"));
        }

        let path_and_query = request_target(req.uri());
        let accept = derive_accept_key(key.as_bytes());
        let on_upgrade = hyper::upgrade::on(req);
        let handler = self.clone();

        tokio::spawn(async move {
            match on_upgrade.await {
                Ok(upgraded) => {
                    if let Err(err) = handler.proxy_websocket(upgraded, path_and_query).await {
                        tracing::warn!(
                            "WebSocket proxy failed on port {}: {}",
                            handler.local_port,
                            err
                        );
                    }
                }
                Err(err) => {
                    tracing::warn!("WebSocket upgrade failed: {}", err);
                }
            }
        });

        Ok(Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Accept", accept)
            .body(Full::new(HyperBytes::new()))
            .expect("switching protocols response should be valid"))
    }

    async fn proxy_websocket(
        &self,
        upgraded: Upgraded,
        path_and_query: String,
    ) -> Result<(), String> {
        let mut local_ws =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, None).await;

        let bound_host = {
            let storage = self.storage.read().await;
            storage.get_bound_host().await
        };

        let host = match bound_host {
            Some(host) => host,
            None => {
                let _ = local_ws
                    .send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Policy,
                        reason: "No host bound".into(),
                    })))
                    .await;
                return Ok(());
            }
        };

        let remote_target = normalize_remote_target(&path_and_query);
        let (mut remote_reader, remote_writer) =
            TolerantWebSocketReader::connect(&host.ip, host.port, &remote_target).await?;

        let (mut local_sink, mut local_stream) = local_ws.split();

        loop {
            tokio::select! {
                maybe_local_message = local_stream.next() => {
                    match maybe_local_message {
                        Some(Ok(message)) => {
                            let is_close = matches!(message, Message::Close(_));
                            remote_writer.send_message(message).await?;
                            if is_close {
                                break;
                            }
                        }
                        Some(Err(err)) => return Err(format!("Local websocket read failed: {}", err)),
                        None => break,
                    }
                }
                remote_message = remote_reader.recv() => {
                    match remote_message? {
                        Some(message) => {
                            let is_close = matches!(message, Message::Close(_));
                            local_sink
                                .send(message)
                                .await
                                .map_err(|err| format!("Local websocket write failed: {}", err))?;
                            if is_close {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }

        let _ = remote_writer.close().await;
        let _ = local_sink.close().await;
        Ok(())
    }
}

fn request_target(uri: &Uri) -> String {
    match uri.query() {
        Some(query) => format!("{}?{}", uri.path(), query),
        None => uri.path().to_string(),
    }
}

fn normalize_remote_target(path_and_query: &str) -> String {
    let (path, query) = match path_and_query.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (path_and_query, None),
    };

    let normalized_path = if path == "/ws" || path == "/ws/" {
        "/c_webskt/".to_string()
    } else if let Some(rest) = path.strip_prefix("/ws/") {
        format!("/c_webskt/{}", rest)
    } else {
        path.to_string()
    };

    match query {
        Some(query) if !query.is_empty() => format!("{}?{}", normalized_path, query),
        _ => normalized_path,
    }
}

#[derive(Clone)]
struct TolerantWebSocketWriter {
    writer: Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>,
}

impl TolerantWebSocketWriter {
    async fn send_message(&self, message: Message) -> Result<(), String> {
        match message {
            Message::Text(text) => {
                self.send_frame(0x1, text.as_str().as_bytes().to_vec())
                    .await
            }
            Message::Binary(data) => self.send_frame(0x2, data.to_vec()).await,
            Message::Ping(data) => self.send_frame(0x9, data.to_vec()).await,
            Message::Pong(data) => self.send_frame(0xA, data.to_vec()).await,
            Message::Close(frame) => {
                let mut payload = Vec::new();
                if let Some(frame) = frame {
                    payload.extend_from_slice(&(u16::from(frame.code)).to_be_bytes());
                    payload.extend_from_slice(frame.reason.as_bytes());
                }
                self.send_frame(0x8, payload).await
            }
            Message::Frame(_) => Ok(()),
        }
    }

    async fn close(&self) -> Result<(), String> {
        self.send_message(Message::Close(None)).await
    }

    async fn send_pong(&self, payload: Vec<u8>) -> Result<(), String> {
        self.send_frame(0xA, payload).await
    }

    async fn send_frame(&self, opcode: u8, payload: Vec<u8>) -> Result<(), String> {
        let payload_len = payload.len();
        let mut frame = Vec::with_capacity(payload_len + 14);
        frame.push(0x80 | (opcode & 0x0F));

        if payload_len < 126 {
            frame.push(0x80 | payload_len as u8);
        } else if payload_len <= u16::MAX as usize {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload_len as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(payload_len as u64).to_be_bytes());
        }

        let mask_key = next_mask_key();
        frame.extend_from_slice(&mask_key);

        let mut masked_payload = payload;
        for (idx, byte) in masked_payload.iter_mut().enumerate() {
            *byte ^= mask_key[idx % 4];
        }
        frame.extend_from_slice(&masked_payload);

        let mut writer = self.writer.lock().await;
        writer
            .write_all(&frame)
            .await
            .map_err(|err| format!("Write websocket frame failed: {}", err))?;
        writer
            .flush()
            .await
            .map_err(|err| format!("Flush websocket frame failed: {}", err))?;

        Ok(())
    }
}

struct TolerantWebSocketReader {
    reader: tokio::net::tcp::OwnedReadHalf,
    read_buffer: BytesMut,
    writer: TolerantWebSocketWriter,
    fragmented_message: Option<FragmentedMessage>,
}

struct FragmentedMessage {
    opcode: u8,
    payload: Vec<u8>,
}

enum ParseOutcome {
    Message(u8, Vec<u8>),
    Consumed,
    NeedMore,
}

impl TolerantWebSocketReader {
    async fn connect(
        host: &str,
        port: u16,
        path_and_query: &str,
    ) -> Result<(Self, TolerantWebSocketWriter), String> {
        let mut stream = TcpStream::connect((host, port))
            .await
            .map_err(|err| format!("Connect remote websocket failed: {}", err))?;

        let path = if path_and_query.is_empty() {
            "/"
        } else {
            path_and_query
        };
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: {}:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
            path, host, port
        );

        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|err| format!("Send websocket handshake failed: {}", err))?;

        let mut handshake_buffer = BytesMut::with_capacity(4096);
        loop {
            if let Some(header_end) = find_http_header_end(&handshake_buffer) {
                let head = &handshake_buffer[..header_end];
                let header_text = String::from_utf8_lossy(head);
                if !header_text.contains(" 101 ") {
                    return Err(format!(
                        "Remote websocket handshake rejected: {}",
                        header_text
                    ));
                }

                let rest = handshake_buffer.split_off(header_end + 4);
                let (reader_half, writer_half) = stream.into_split();
                let writer = TolerantWebSocketWriter {
                    writer: Arc::new(Mutex::new(writer_half)),
                };
                let reader = Self {
                    reader: reader_half,
                    read_buffer: rest,
                    writer: writer.clone(),
                    fragmented_message: None,
                };
                return Ok((reader, writer));
            }

            let mut chunk = [0_u8; 1024];
            let read = stream
                .read(&mut chunk)
                .await
                .map_err(|err| format!("Read websocket handshake failed: {}", err))?;
            if read == 0 {
                return Err("Remote websocket closed during handshake".to_string());
            }
            handshake_buffer.extend_from_slice(&chunk[..read]);
            if handshake_buffer.len() > 64 * 1024 {
                return Err("Remote websocket handshake is too large".to_string());
            }
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

fn find_http_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn next_mask_key() -> [u8; 4] {
    static MASK_COUNTER: AtomicU32 = AtomicU32::new(1);

    let counter = MASK_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(0);

    (counter ^ nanos).to_be_bytes()
}
