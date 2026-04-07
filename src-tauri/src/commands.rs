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
async fn try_start_deep_scan(
    app: &AppHandle,
    state: &State<'_, AppState>,
    reason: &str,
    bypass_cooldown: bool,
) -> Result<DeepScanDecision, String> {
    let scanner = state.scanner.clone();
    let scan_cancel = state.scan_cancel.clone();
    let storage = state.storage.clone();

    {
        let scanner_read = scanner.read().await;
        if scanner_read.is_scanning().await {
            return Ok(DeepScanDecision {
                started: false,
                skipped: true,
                cooldown_remaining_ms: None,
                skip_message: Some("扫描已在进行中".to_string()),
            });
        }
    }

    let settings = {
        let storage_read = storage.read().await;
        storage_read.get_settings().await
    };

    let now = chrono::Utc::now().timestamp_millis();
    if !bypass_cooldown {
        let last_scan = {
            let storage_read = storage.read().await;
            storage_read.get_discovery_last_deep_scan_at().await
        };
        if let Some(remaining) = deep_refresh_cooldown_remaining_ms(last_scan, now) {
            return Ok(DeepScanDecision {
                started: false,
                skipped: true,
                cooldown_remaining_ms: Some(remaining),
                skip_message: Some(format!(
                    "深度扫描冷却中，请在 {} 秒后重试",
                    (remaining + 999) / 1000
                )),
            });
        }
    }

    let app_clone = app.clone();
    let on_progress = Arc::new(move |scanned: usize, total: usize, found: usize| {
        let app = app_clone.clone();
        tokio::spawn(async move {
            let _ = app.emit(
                "scan-progress",
                serde_json::json!({
                    "scanned": scanned,
                    "total": total,
                    "found": found
                }),
            );
        });
    });

    let app_clone_host = app.clone();
    let on_host_found = Arc::new(move |host: HostInfo| {
        let app = app_clone_host.clone();
        tokio::spawn(async move {
            let _ = app.emit("host-found", serde_json::json!({ "host": host }));
        });
    });

    {
        let mut scanner_mut = scanner.write().await;
        scanner_mut.apply_settings(&settings);
        scanner_mut.set_callbacks(on_progress, on_host_found);
    }

    {
        let mut storage_write = storage.write().await;
        let _ = storage_write
            .set_discovery_last_deep_scan_at(chrono::Utc::now().timestamp_millis())
            .await;
    }

    scan_cancel.store(false, Ordering::Relaxed);
    let scanner_for_spawn = scanner.clone();
    let scan_cancel_for_spawn = scan_cancel.clone();
    let storage_for_spawn = storage.clone();
    let app_for_spawn = app.clone();
    let reason_owned = reason.to_string();

    tokio::spawn(async move {
        let result = {
            let mut scanner_mut = scanner_for_spawn.write().await;
            scanner_mut.start(scan_cancel_for_spawn.clone()).await
        };

        match result {
            Ok(found_count) => {
                let hosts = {
                    let scanner_read = scanner_for_spawn.read().await;
                    scanner_read.get_found_hosts().await
                };
                let now = chrono::Utc::now().timestamp_millis();
                let discovery_hosts = hosts
                    .iter()
                    .map(|host| discovery_host_from_scan_result(host, now, &reason_owned))
                    .collect::<Vec<_>>();
                {
                    let mut storage_write = storage_for_spawn.write().await;
                    if let Err(err) = storage_write.upsert_discovery_hosts(discovery_hosts).await {
                        tracing::warn!(
                            "Failed to persist discovery hosts after deep scan: {}",
                            err
                        );
                    }
                }
                let _ = app_for_spawn.emit(
                    "scan-complete",
                    serde_json::json!({
                        "found": found_count,
                        "hosts": hosts,
                        "cancelled": scan_cancel_for_spawn.load(Ordering::Relaxed)
                    }),
                );
            }
            Err(err) => {
                tracing::error!("Scan failed: {}", err);
                let _ = app_for_spawn.emit("scan-error", err);
            }
        }
    });

    Ok(DeepScanDecision {
        started: true,
        skipped: false,
        cooldown_remaining_ms: None,
        skip_message: None,
    })
}

async fn maybe_trigger_deep_scan_for_network_change(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Option<DeepScanDecision>, String> {
    let fingerprint = {
        let scanner = state.scanner.read().await;
        scanner.get_network_fingerprint().await
    };

    let previous = {
        let storage = state.storage.read().await;
        storage.get_discovery_network_fingerprint().await
    };

    if previous.is_none() {
        let mut storage = state.storage.write().await;
        let _ = storage.set_discovery_network_fingerprint(fingerprint).await;
        return Ok(None);
    }

    if previous.as_deref() == Some(fingerprint.as_str()) {
        return Ok(None);
    }

    {
        let mut storage = state.storage.write().await;
        let _ = storage.set_discovery_network_fingerprint(fingerprint).await;
    }

    let decision = try_start_deep_scan(app, state, "network-change", true).await?;
    Ok(Some(decision))
}

async fn run_quick_discovery_probe(state: &State<'_, AppState>) -> Result<(), String> {
    let Some(_guard) = QuickProbeGuard::try_acquire(state.quick_probe_running.clone()) else {
        return Ok(());
    };

    let (mut hosts, favorites) = {
        let storage = state.storage.read().await;
        (
            storage.get_discovery_hosts().await,
            storage.get_favorite_hosts().await,
        )
    };
    if hosts.is_empty() && favorites.is_empty() {
        return Ok(());
    }

    sort_discovery_hosts(&mut hosts);
    let targets = build_quick_probe_targets(hosts, favorites, chrono::Utc::now().timestamp_millis());
    if targets.is_empty() {
        return Ok(());
    }

    let now = chrono::Utc::now().timestamp_millis();

    let refreshed = stream::iter(targets)
        .map(|host| async move {
            let diagnosis =
                run_host_diagnosis(&host.ip, Some(host.port), DISCOVERY_QUICK_TIMEOUT_MS).await;

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
            let rtt = diagnosis
                .stages
                .iter()
                .find(|stage| stage.stage == "tcp")
                .and_then(|stage| stage.latency_ms);
            let is_online = diagnosis.summary.ok;

            DiscoveryHost {
                status: if is_online {
                    "online".to_string()
                } else {
                    "offline".to_string()
                },
                source: "quick_probe".to_string(),
                last_seen: now,
                last_ok: if is_online { Some(now) } else { host.last_ok },
                rtt,
                tcp_ok: Some(tcp_ok),
                script_ok: Some(script_ok),
                ..host
            }
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;

    if refreshed.is_empty() {
        return Ok(());
    }

    let mut storage = state.storage.write().await;
    storage.upsert_discovery_hosts(refreshed).await
}

struct QuickProbeGuard {
    flag: Arc<AtomicBool>,
}

impl QuickProbeGuard {
    fn try_acquire(flag: Arc<AtomicBool>) -> Option<Self> {
        if try_enter_quick_probe(flag.as_ref()) {
            Some(Self { flag })
        } else {
            None
        }
    }
}

impl Drop for QuickProbeGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

fn try_enter_quick_probe(flag: &AtomicBool) -> bool {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
        .is_ok()
}

fn build_quick_probe_targets(
    sorted_discovery_hosts: Vec<DiscoveryHost>,
    favorite_hosts: Vec<FavoriteHost>,
    now: i64,
) -> Vec<DiscoveryHost> {
    let favorite_targets = favorite_hosts
        .into_iter()
        .take(FAVORITE_HOSTS_MAX)
        .collect::<Vec<_>>();

    if favorite_targets.is_empty() {
        return sorted_discovery_hosts
            .into_iter()
            .take(DISCOVERY_QUICK_MAX_HOSTS)
            .collect();
    }

    let favorite_keys = favorite_targets
        .iter()
        .map(|host| host_key(&host.ip, host.port))
        .collect::<HashSet<_>>();
    let mut discovery_by_key = HashMap::new();
    let mut non_favorite_discovery = Vec::new();

    for host in sorted_discovery_hosts {
        let key = host_key(&host.ip, host.port);
        if favorite_keys.contains(&key) {
            discovery_by_key.entry(key).or_insert(host);
        } else {
            non_favorite_discovery.push(host);
        }
    }

    let mut targets = Vec::with_capacity(favorite_targets.len() + DISCOVERY_QUICK_MAX_HOSTS);
    for favorite in favorite_targets {
        let key = host_key(&favorite.ip, favorite.port);
        let target = discovery_by_key
            .remove(&key)
            .unwrap_or_else(|| seed_discovery_host_from_favorite(&favorite, now));
        targets.push(target);
    }

    targets.extend(non_favorite_discovery.into_iter().take(DISCOVERY_QUICK_MAX_HOSTS));
    targets
}

fn seed_discovery_host_from_favorite(host: &FavoriteHost, now: i64) -> DiscoveryHost {
    DiscoveryHost {
        ip: host.ip.clone(),
        port: host.port,
        hostname: None,
        os: None,
        version: None,
        rtt: None,
        tcp_ok: None,
        script_ok: None,
        status: "unknown".to_string(),
        source: "favorite_seed".to_string(),
        last_seen: now,
        last_ok: None,
    }
}

fn host_key(ip: &str, port: u16) -> String {
    format!("{}:{}", ip, port)
}

async fn record_diagnosis(state: &State<'_, AppState>, diagnosis: &HostDiagnosis) {
    let previous = { state.connection_state.read().await.clone() };
    let next = to_connection_state(diagnosis, &previous);
    {
        let mut cs = state.connection_state.write().await;
        *cs = next;
    }
    {
        let mut last = state.last_diagnosis.write().await;
        *last = Some(diagnosis.clone());
    }
}

fn discovery_host_from_scan_result(host: &HostInfo, now: i64, source: &str) -> DiscoveryHost {
    let is_online = host.tcp_ok.unwrap_or(false) && host.script_ok.unwrap_or(false);
    DiscoveryHost {
        ip: host.ip.clone(),
        port: host.port,
        hostname: host.hostname.clone(),
        os: host.os.clone(),
        version: host.version.clone(),
        rtt: host.rtt,
        tcp_ok: host.tcp_ok,
        script_ok: host.script_ok,
        status: if is_online {
            "online".to_string()
        } else {
            "offline".to_string()
        },
        source: source.to_string(),
        last_seen: now,
        last_ok: if is_online { Some(now) } else { None },
    }
}

fn deep_refresh_cooldown_remaining_ms(last_refresh_at: Option<i64>, now: i64) -> Option<i64> {
    let last = last_refresh_at?;
    let elapsed = now.saturating_sub(last);
    if elapsed >= DISCOVERY_DEEP_COOLDOWN_MS {
        None
    } else {
        Some(DISCOVERY_DEEP_COOLDOWN_MS - elapsed)
    }
}

fn compute_effective_status(status: &str, last_seen: i64, now: i64) -> String {
    if status == "online" && now.saturating_sub(last_seen) > DISCOVERY_STALE_MS {
        "stale".to_string()
    } else {
        status.to_string()
    }
}

fn normalize_discovery_hosts(mut hosts: Vec<DiscoveryHost>) -> Vec<DiscoveryHost> {
    let now = chrono::Utc::now().timestamp_millis();
    for host in &mut hosts {
        host.status = compute_effective_status(&host.status, host.last_seen, now);
    }
    sort_discovery_hosts(&mut hosts);
    hosts
}
