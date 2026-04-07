use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionState {
    pub online: bool,
    pub phase: String,
    pub error: Option<String>,
    pub last_success_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisStage {
    pub stage: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisSummary {
    pub ok: bool,
    pub phase: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDiagnosis {
    pub ip: String,
    pub port: u16,
    pub recommended_port: u16,
    pub stages: Vec<DiagnosisStage>,
    pub summary: DiagnosisSummary,
    pub timestamp: i64,
}

#[derive(Debug, Clone)]
struct BasicPortCheck {
    port: u16,
    tcp_ok: bool,
    script_ok: bool,
}

pub async fn run_host_diagnosis(
    ip: &str,
    preferred_port: Option<u16>,
    timeout_ms: u64,
) -> HostDiagnosis {
    let mut candidates = Vec::new();
    if let Some(port) = preferred_port.filter(|p| *p > 0) {
        candidates.push(port);
    }
    for port in [8000_u16, 18000_u16] {
        if !candidates.contains(&port) {
            candidates.push(port);
        }
    }

    let mut checks = Vec::new();
    for port in &candidates {
        checks.push(basic_check(ip, *port, timeout_ms).await);
    }

    let recommended_port = checks
        .iter()
        .find(|check| check.tcp_ok && check.script_ok)
        .map(|check| check.port)
        .or_else(|| {
            checks
                .iter()
                .find(|check| check.tcp_ok)
                .map(|check| check.port)
        })
        .or(preferred_port)
        .unwrap_or(8000);

    let stages = run_stage_checks(ip, recommended_port, timeout_ms).await;
    let summary = summarize_stages(&stages);

    HostDiagnosis {
        ip: ip.to_string(),
        port: preferred_port.unwrap_or(recommended_port),
        recommended_port,
        stages,
        summary,
        timestamp: chrono::Utc::now().timestamp_millis(),
    }
}

pub fn to_connection_state(
    diagnosis: &HostDiagnosis,
    previous: &ConnectionState,
) -> ConnectionState {
    let mut state = ConnectionState {
        online: diagnosis.summary.ok,
        phase: diagnosis.summary.phase.clone(),
        error: diagnosis.summary.error.clone(),
        last_success_at: previous.last_success_at,
    };

    if diagnosis.summary.ok {
        state.last_success_at = Some(diagnosis.timestamp);
    }

    state
}

pub fn summarize_stages(stages: &[DiagnosisStage]) -> DiagnosisSummary {
    let find = |name: &str| stages.iter().find(|stage| stage.stage == name);

    let tcp_ok = find("tcp").map(|stage| stage.ok).unwrap_or(false);
    let script_ok = find("http_script").map(|stage| stage.ok).unwrap_or(false);
    let ws_ok = find("websocket").map(|stage| stage.ok).unwrap_or(false);

    if !tcp_ok {
        return DiagnosisSummary {
            ok: false,
            phase: "tcp".to_string(),
            error: find("tcp")
                .and_then(|stage| stage.error.clone())
                .or_else(|| Some("TCP 端口不可达".to_string())),
        };
    }

    if !script_ok {
        return DiagnosisSummary {
            ok: false,
            phase: "http_script".to_string(),
            error: find("http_script")
                .and_then(|stage| stage.error.clone())
                .or_else(|| Some("CLodopfuncs.js 不可达".to_string())),
        };
    }

    if !ws_ok {
        return DiagnosisSummary {
            ok: false,
            phase: "websocket".to_string(),
            error: find("websocket")
                .and_then(|stage| stage.error.clone())
                .or_else(|| Some("WebSocket 握手失败".to_string())),
        };
    }

    DiagnosisSummary {
        ok: true,
        phase: "clodop_ready".to_string(),
        error: None,
    }
}

async fn basic_check(ip: &str, port: u16, timeout_ms: u64) -> BasicPortCheck {
    let tcp_ok = check_tcp(ip, port, timeout_ms).await.is_ok();
    let script_ok = if tcp_ok {
        check_http(ip, port, "CLodopfuncs.js", timeout_ms)
            .await
            .is_ok()
    } else {
        false
    };
    BasicPortCheck {
        port,
        tcp_ok,
        script_ok,
    }
}

async fn run_stage_checks(ip: &str, port: u16, timeout_ms: u64) -> Vec<DiagnosisStage> {
    let mut stages = Vec::with_capacity(4);

    let tcp_stage = stage_from_result("tcp", check_tcp(ip, port, timeout_ms).await, ip, port);
    let tcp_ok = tcp_stage.ok;
    stages.push(tcp_stage);

    let script_stage = if tcp_ok {
        stage_from_result(
            "http_script",
            check_http(ip, port, "CLodopfuncs.js", timeout_ms).await,
            ip,
            port,
        )
    } else {
        skipped_stage("http_script", "依赖 TCP 阶段成功")
    };
    let script_ok = script_stage.ok;
    stages.push(script_stage);

    let sysmessage_stage = if tcp_ok {
        stage_from_result(
            "sysmessage",
            check_http(ip, port, "c_sysmessage", timeout_ms).await,
            ip,
            port,
        )
    } else {
        skipped_stage("sysmessage", "依赖 TCP 阶段成功")
    };
    stages.push(sysmessage_stage);

    let ws_stage = if tcp_ok && script_ok {
        let ws_result = match check_websocket(ip, port, "/c_webskt/", timeout_ms).await {
            Ok(latency) => Ok(latency),
            Err(first_err) => check_websocket(ip, port, "/ws", timeout_ms)
                .await
                .map_err(|second_err| format!("{}; {}", first_err, second_err)),
        };
        stage_from_result("websocket", ws_result, ip, port)
    } else {
        skipped_stage("websocket", "依赖 TCP+脚本阶段成功")
    };
    stages.push(ws_stage);

    stages
}

fn skipped_stage(stage: &str, reason: &str) -> DiagnosisStage {
    DiagnosisStage {
        stage: stage.to_string(),
        ok: false,
        latency_ms: None,
        error: Some(format!("跳过: {}", reason)),
    }
}

fn stage_from_result(
    stage: &str,
    result: Result<u64, String>,
    ip: &str,
    port: u16,
) -> DiagnosisStage {
    match result {
        Ok(latency_ms) => DiagnosisStage {
            stage: stage.to_string(),
            ok: true,
            latency_ms: Some(latency_ms),
            error: None,
        },
        Err(error) => {
            let friendly_error = normalize_diagnosis_error(stage, ip, port, &error);
            tracing::debug!(
                stage = stage,
                host = %format!("{}:{}", ip, port),
                raw_error = %error,
                friendly_error = %friendly_error,
                "diagnosis stage failed"
            );
            DiagnosisStage {
                stage: stage.to_string(),
                ok: false,
                latency_ms: None,
                error: Some(friendly_error),
            }
        }
    }
}

fn normalize_diagnosis_error(stage: &str, ip: &str, port: u16, raw_error: &str) -> String {
    let normalized = raw_error.to_ascii_lowercase();

    if normalized.contains("no route")
        || normalized.contains("network is unreachable")
        || normalized.contains("host is unreachable")
    {
        return "网络不可达，请确认与目标主机在同一局域网或已接入 VPN。".to_string();
    }

    if normalized.contains("connection refused") || normalized.contains("refused") {
        return "连接被拒绝，请确认目标主机已启动 LODOP 服务且端口开放。".to_string();
    }

    if normalized.contains("timeout") || normalized.contains("timed out") {
        return format!(
            "连接超时，无法连接到 {}:{}，请确认主机在线、端口正确、网络可达。",
            ip, port
        );
    }

    if normalized.contains("clodopfuncs.js") {
        return "LODOP 服务可达性异常，无法获取 CLodopfuncs.js。".to_string();
    }

    if stage == "websocket" || normalized.contains("websocket") {
        return "LODOP 通道建立失败，请确认目标服务支持 WebSocket。".to_string();
    }

    "连接失败，请检查网络和服务状态后重试。".to_string()
}

async fn check_tcp(ip: &str, port: u16, timeout_ms: u64) -> Result<u64, String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(200, 15_000));
    let started = Instant::now();
    match tokio::time::timeout(timeout, TcpStream::connect((ip, port))).await {
        Ok(Ok(_)) => Ok(started.elapsed().as_millis() as u64),
        Ok(Err(err)) => Err(format!("TCP connect failed: {}", err)),
        Err(_) => Err("TCP connect timeout".to_string()),
    }
}

async fn check_http(ip: &str, port: u16, endpoint: &str, timeout_ms: u64) -> Result<u64, String> {
    let timeout = Duration::from_millis((timeout_ms * 2).clamp(500, 20_000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|err| format!("HTTP client init failed: {}", err))?;

    let started = Instant::now();
    let url = format!("http://{}:{}/{}", ip, port, endpoint);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|err| format!("{} request failed: {}", endpoint, err))?;
    if !response.status().is_success() {
        return Err(format!("{} returned {}", endpoint, response.status()));
    }
    Ok(started.elapsed().as_millis() as u64)
}

async fn check_websocket(ip: &str, port: u16, path: &str, timeout_ms: u64) -> Result<u64, String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(200, 15_000));
    let started = Instant::now();
    let mut stream = tokio::time::timeout(timeout, TcpStream::connect((ip, port)))
        .await
        .map_err(|_| "WebSocket TCP timeout".to_string())?
        .map_err(|err| format!("WebSocket TCP connect failed: {}", err))?;

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        path, ip, port
    );
    tokio::time::timeout(timeout, stream.write_all(request.as_bytes()))
        .await
        .map_err(|_| "WebSocket handshake write timeout".to_string())?
        .map_err(|err| format!("WebSocket handshake write failed: {}", err))?;

    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 512];
    loop {
        let read = tokio::time::timeout(timeout, stream.read(&mut chunk))
            .await
            .map_err(|_| "WebSocket handshake read timeout".to_string())?
            .map_err(|err| format!("WebSocket handshake read failed: {}", err))?;
        if read == 0 {
            return Err("WebSocket closed during handshake".to_string());
        }
        buf.extend_from_slice(&chunk[..read]);
        if find_http_header_end(&buf).is_some() {
            break;
        }
        if buf.len() > 64 * 1024 {
            return Err("WebSocket handshake header too large".to_string());
        }
    }

    let header_end = find_http_header_end(&buf).ok_or_else(|| "Invalid handshake".to_string())?;
    let header = String::from_utf8_lossy(&buf[..header_end]);
    if !header.contains(" 101 ") {
        return Err(format!(
            "WebSocket handshake rejected: {}",
            header.lines().next().unwrap_or("unknown")
        ));
    }
    Ok(started.elapsed().as_millis() as u64)
}

fn find_http_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

#[cfg(test)]
mod tests {
    use super::normalize_diagnosis_error;

    #[test]
    fn maps_timeout_to_friendly_message() {
        let message = normalize_diagnosis_error("tcp", "10.123.40.4", 8000, "TCP connect timeout");
        assert!(message.contains("连接超时"));
        assert!(message.contains("10.123.40.4:8000"));
    }

    #[test]
    fn maps_connection_refused_to_friendly_message() {
        let message = normalize_diagnosis_error(
            "tcp",
            "10.0.0.1",
            8000,
            "TCP connect failed: connection refused",
        );
        assert_eq!(
            message,
            "连接被拒绝，请确认目标主机已启动 LODOP 服务且端口开放。"
        );
    }

    #[test]
    fn maps_unreachable_network_to_friendly_message() {
        let message = normalize_diagnosis_error(
            "tcp",
            "10.0.0.1",
            8000,
            "TCP connect failed: Network is unreachable",
        );
        assert_eq!(
            message,
            "网络不可达，请确认与目标主机在同一局域网或已接入 VPN。"
        );
    }

    #[test]
    fn maps_websocket_errors_to_friendly_message() {
        let message = normalize_diagnosis_error(
            "websocket",
            "10.0.0.1",
            8000,
            "WebSocket handshake rejected: HTTP/1.1 404 Not Found",
        );
        assert_eq!(
            message,
            "LODOP 通道建立失败，请确认目标服务支持 WebSocket。"
        );
    }

    #[test]
    fn maps_script_fetch_errors_to_friendly_message() {
        let message = normalize_diagnosis_error(
            "http_script",
            "10.0.0.1",
            8000,
            "CLodopfuncs.js request failed: connection reset",
        );
        assert_eq!(message, "LODOP 服务可达性异常，无法获取 CLodopfuncs.js。");
    }

    #[test]
    fn falls_back_to_generic_message_for_unknown_errors() {
        let message =
            normalize_diagnosis_error("tcp", "10.0.0.1", 8000, "something weird happened");
        assert_eq!(message, "连接失败，请检查网络和服务状态后重试。");
    }
}
