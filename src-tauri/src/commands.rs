use crate::AppState;
use serde_json::Value;
use tauri::{State, AppHandle, Emitter};
use std::sync::Arc;

#[tauri::command]
pub async fn start_scan(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let scanner = state.scanner.clone();

    // Set up progress callback
    let app_clone = app.clone();
    let on_progress = Arc::new(move |scanned: usize, total: usize, found: usize| {
        let app = app_clone.clone();
        tokio::spawn(async move {
            let _ = app.emit("scan-progress", serde_json::json!({
                "scanned": scanned,
                "total": total,
                "found": found
            }));
        });
    });

    // Set up host-found callback
    let app_clone_host = app.clone();
    let on_host_found = Arc::new(move |host: crate::storage::HostInfo| {
        let app = app_clone_host.clone();
        tokio::spawn(async move {
            let _ = app.emit("host-found", serde_json::json!({
                "host": host
            }));
        });
    });

    // Set callbacks on scanner
    {
        let mut scanner_mut = scanner.write().await;
        scanner_mut.set_callbacks(on_progress, on_host_found);
    }

    // Spawn scanning in background
    let scanner_for_spawn = scanner.clone();
    tokio::spawn(async move {
        let mut scanner_mut = scanner_for_spawn.write().await;

        // Start scan
        let result = scanner_mut.start().await;

        match result {
            Ok(found_count) => {
                // Emit completion event with found hosts
                let hosts = scanner_mut.get_found_hosts().await;
                let _ = app.emit("scan-complete", serde_json::json!({
                    "found": found_count,
                    "hosts": hosts
                }));
            }
            Err(e) => {
                tracing::error!("Scan failed: {}", e);
                let _ = app.emit("scan-error", e);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_scan(state: State<'_, AppState>) -> Result<(), String> {
    let mut scanner = state.scanner.write().await;
    scanner.stop();
    Ok(())
}

#[tauri::command]
pub async fn get_scan_results(state: State<'_, AppState>) -> Result<HostMap, String> {
    let scanner = state.scanner.read().await;
    Ok(scanner.get_found_hosts().await)
}

#[tauri::command]
pub async fn add_host(
    ip: String,
    port: u16,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let mut scanner = state.scanner.write().await;
    scanner.add_host(ip, port).await
}

#[tauri::command]
pub async fn bind_host(
    ip: String,
    port: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut storage = state.storage.write().await;
    storage.set_bound_host(crate::storage::HostInfo {
        ip,
        port,
        hostname: None,
        os: None,
        version: None,
        rtt: None,
        timestamp: chrono::Utc::now().timestamp_millis(),
    }).await?;
    Ok(())
}

#[tauri::command]
pub async fn unbind_host(state: State<'_, AppState>) -> Result<(), String> {
    let mut storage = state.storage.write().await;
    storage.clear_bound_host().await?;
    Ok(())
}

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<Value, String> {
    let storage = state.storage.read().await;
    let bound_host = storage.get_bound_host().await;

    Ok(serde_json::json!({
        "boundHost": bound_host,
        "status": "online"
    }))
}

#[tauri::command]
pub async fn test_print(
    printer: Option<String>,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    tracing::info!("Test print requested for printer: {:?}", printer);
    Ok(())
}

#[tauri::command]
pub async fn get_printers(_state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(vec!["默认打印机".to_string()])
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
