use crate::diagnostics::{run_host_diagnosis, to_connection_state, HostDiagnosis};
use crate::storage::{DiscoveryHost, FavoriteHost, HostInfo, FAVORITE_HOSTS_MAX};
use crate::AppState;
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

const DISCOVERY_QUICK_TIMEOUT_MS: u64 = 1_000;
const DISCOVERY_QUICK_MAX_HOSTS: usize = 8;
const DISCOVERY_DEEP_COOLDOWN_MS: i64 = 120_000;
const DISCOVERY_STALE_MS: i64 = 300_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatePayload {
    pub online: bool,
    pub phase: String,
    pub error: Option<String>,
    pub active_host: Option<HostInfo>,
    pub last_success_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshDiscoveryRequest {
    pub mode: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshDiscoveryResponse {
    pub mode: String,
    pub started: bool,
    pub skipped: bool,
    pub cooldown_remaining_ms: Option<i64>,
    pub hosts: Vec<DiscoveryHost>,
}

#[derive(Debug, Clone, Default)]
struct DeepScanDecision {
    started: bool,
    skipped: bool,
    cooldown_remaining_ms: Option<i64>,
    skip_message: Option<String>,
}

#[tauri::command]
pub async fn start_scan(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let decision = try_start_deep_scan(&app, &state, "manual-scan", false).await?;
    if decision.started {
        return Ok(());
    }

    if let Some(message) = decision.skip_message {
        return Err(message);
    }

    Err("扫描未启动".to_string())
}

#[tauri::command]
pub async fn stop_scan(state: State<'_, AppState>) -> Result<(), String> {
    state.scan_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn get_scan_results(state: State<'_, AppState>) -> Result<HostMap, String> {
    let scanner = state.scanner.read().await;
    Ok(scanner.get_found_hosts().await)
}

#[tauri::command]
pub async fn get_discovery_hosts(state: State<'_, AppState>) -> Result<Vec<DiscoveryHost>, String> {
    let hosts = {
        let storage = state.storage.read().await;
        storage.get_discovery_hosts().await
    };
    Ok(normalize_discovery_hosts(hosts))
}

#[tauri::command]
pub async fn refresh_discovery(
    app: AppHandle,
    request: Option<RefreshDiscoveryRequest>,
    state: State<'_, AppState>,
) -> Result<RefreshDiscoveryResponse, String> {
    let mode = request
        .as_ref()
        .and_then(|item| item.mode.as_ref())
        .map(|item| item.trim().to_ascii_lowercase())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| "quick".to_string());
    let reason = request
        .as_ref()
        .and_then(|item| item.reason.as_ref())
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| format!("manual-{}", mode));

    let mut deep_decision = DeepScanDecision::default();
    if mode == "quick" {
        if let Some(decision) = maybe_trigger_deep_scan_for_network_change(&app, &state).await? {
            deep_decision = decision;
        }
        run_quick_discovery_probe(&state).await?;
    } else if mode == "deep" {
        deep_decision = try_start_deep_scan(&app, &state, &reason, false).await?;
    } else {
        return Err("refresh_discovery.mode 仅支持 quick 或 deep".to_string());
    }

    let hosts = {
        let storage = state.storage.read().await;
        storage.get_discovery_hosts().await
    };

    Ok(RefreshDiscoveryResponse {
        mode,
        started: deep_decision.started,
        skipped: deep_decision.skipped,
        cooldown_remaining_ms: deep_decision.cooldown_remaining_ms,
        hosts: normalize_discovery_hosts(hosts),
    })
}

#[tauri::command]
pub async fn add_host(ip: String, port: u16, state: State<'_, AppState>) -> Result<Value, String> {
    let mut scanner = state.scanner.write().await;
    let host_value = scanner.add_host(ip, port).await?;
    drop(scanner);

    if let Ok(host) = serde_json::from_value::<HostInfo>(host_value.clone()) {
        let now = chrono::Utc::now().timestamp_millis();
        let discovery_host = discovery_host_from_scan_result(&host, now, "manual_add");
        let mut storage = state.storage.write().await;
        let _ = storage.upsert_discovery_hosts(vec![discovery_host]).await;
    }

    Ok(host_value)
}

#[tauri::command]
pub async fn diagnose_host(
    app: AppHandle,
    ip: String,
    port: u16,
    state: State<'_, AppState>,
) -> Result<HostDiagnosis, String> {
    let ip = ip.trim().to_string();
    if ip.is_empty() {
        return Err("IP 不能为空".to_string());
    }
    validate_ipv4_input(&ip)?;

    let diagnosis = run_host_diagnosis(&ip, (port > 0).then_some(port), 1_500).await;
    for stage in &diagnosis.stages {
        let _ = app.emit("diagnose-progress", stage);
    }
    let _ = app.emit("diagnose-complete", &diagnosis);

    record_diagnosis(&state, &diagnosis).await;
    Ok(diagnosis)
}

#[tauri::command]
pub async fn bind_host(ip: String, port: u16, state: State<'_, AppState>) -> Result<(), String> {
    let ip = ip.trim().to_string();
    if ip.is_empty() || port == 0 {
        return Err("IP 和端口不能为空".to_string());
    }
    validate_ipv4_input(&ip)?;

    let diagnosis = run_host_diagnosis(&ip, Some(port), 1_500).await;
    let tcp_ok = diagnosis
        .stages
        .iter()
        .find(|stage| stage.stage == "tcp")
        .map(|stage| stage.ok)
        .unwrap_or(false);
    let script_ok = diagnosis
        .stages
        .iter()
        .find(|stage| stage.stage == "http_script")
        .map(|stage| stage.ok)
        .unwrap_or(false);

    if !tcp_ok || !script_ok {
        let err = diagnosis
            .summary
            .error
            .clone()
            .unwrap_or_else(|| "目标主机不可用于 C-Lodop".to_string());
        record_diagnosis(&state, &diagnosis).await;
        return Err(format!("绑定失败: {}", err));
    }

    let bind_port = diagnosis.recommended_port;
    let now = chrono::Utc::now().timestamp_millis();
    let bound_host = HostInfo {
        ip: ip.clone(),
        port: bind_port,
        hostname: None,
        os: None,
        version: None,
        rtt: None,
        timestamp: now,
        tcp_ok: Some(true),
        script_ok: Some(true),
    };
    let discovery_host = DiscoveryHost {
        ip: ip.clone(),
        port: bind_port,
        hostname: None,
        os: None,
        version: None,
        rtt: diagnosis
            .stages
            .iter()
            .find(|stage| stage.stage == "tcp")
            .and_then(|stage| stage.latency_ms),
        tcp_ok: Some(true),
        script_ok: Some(true),
        status: "online".to_string(),
        source: "manual_bind".to_string(),
        last_seen: now,
        last_ok: Some(now),
    };
    {
        let mut storage = state.storage.write().await;
        storage.set_bound_host(bound_host).await?;
        let _ = storage.upsert_discovery_hosts(vec![discovery_host]).await;
    }

    record_diagnosis(&state, &diagnosis).await;
    Ok(())
}

#[tauri::command]
pub async fn unbind_host(state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut storage = state.storage.write().await;
        storage.clear_bound_host().await?;
    }

    let prev = { state.connection_state.read().await.clone() };
    let mut next = prev;
    next.online = false;
    next.phase = "idle".to_string();
    next.error = None;
    {
        let mut cs = state.connection_state.write().await;
        *cs = next;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_connection_state(
    state: State<'_, AppState>,
) -> Result<ConnectionStatePayload, String> {
    let bound_host = {
        let storage = state.storage.read().await;
        storage.get_bound_host().await
    };

    let Some(host) = bound_host.clone() else {
        let last_success_at = state.connection_state.read().await.last_success_at;
        return Ok(ConnectionStatePayload {
            online: false,
            phase: "idle".to_string(),
            error: None,
            active_host: None,
            last_success_at,
        });
    };

    let diagnosis = run_host_diagnosis(&host.ip, Some(host.port), 1_500).await;
    record_diagnosis(&state, &diagnosis).await;
    let cs = state.connection_state.read().await.clone();
    Ok(ConnectionStatePayload {
        online: cs.online,
        phase: cs.phase,
        error: cs.error,
        active_host: Some(host),
        last_success_at: cs.last_success_at,
    })
}

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<Value, String> {
    let connection = get_connection_state(state).await?;
    Ok(serde_json::json!({
        "boundHost": connection.active_host,
        "status": {
            "online": connection.online,
            "error": connection.error,
            "phase": connection.phase,
            "lastSuccessAt": connection.last_success_at
        }
    }))
}

#[tauri::command]
pub async fn test_print(printer: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let connection = get_connection_state(state).await?;
    if !connection.online {
        return Err(connection
            .error
            .unwrap_or_else(|| "目标主机离线".to_string()));
    }

    tracing::info!("Test print requested for printer: {:?}", printer);
    Ok(())
}

#[tauri::command]
pub async fn get_printers(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let connection = get_connection_state(state).await?;
    if !connection.online {
        return Ok(vec![]);
    }
    Ok(vec![])
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<crate::storage::Settings, String> {
    let storage = state.storage.read().await;
    Ok(storage.get_settings().await)
}

#[tauri::command]
pub async fn update_settings(
    settings: crate::storage::Settings,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut storage = state.storage.write().await;
    storage.update_settings(settings).await
}

#[tauri::command]
pub async fn get_host_note(
    ip: String,
    port: u16,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let storage = state.storage.read().await;
    Ok(storage.get_host_note(&ip, port).await)
}

#[tauri::command]
pub async fn set_host_note(
    ip: String,
    port: u16,
    note: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut storage = state.storage.write().await;
    storage.set_host_note(&ip, port, note).await
}

#[tauri::command]
pub async fn get_all_host_notes(state: State<'_, AppState>) -> Result<std::collections::HashMap<String, String>, String> {
    let storage = state.storage.read().await;
    Ok(storage.get_all_host_notes().await)
}

type HostMap = Vec<Value>;
