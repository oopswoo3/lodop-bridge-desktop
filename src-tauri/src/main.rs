// Prevents additional console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod diagnostics;
mod proxy;
mod scanner;
mod storage;

use diagnostics::{ConnectionState, HostDiagnosis};
use proxy::ProxyServer;
use scanner::Scanner;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use storage::Storage;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AppState {
    pub storage: Arc<RwLock<Storage>>,
    pub scanner: Arc<RwLock<Scanner>>,
    pub scan_cancel: Arc<AtomicBool>,
    pub quick_probe_running: Arc<AtomicBool>,
    pub proxy_port: u16,
    pub connection_state: Arc<RwLock<ConnectionState>>,
    pub last_diagnosis: Arc<RwLock<Option<HostDiagnosis>>>,
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // Initialize storage
    let storage = Arc::new(RwLock::new(Storage::new().await));
    let scanner = Arc::new(RwLock::new(Scanner::new()));
    let scan_cancel = Arc::new(AtomicBool::new(false));
    let quick_probe_running = Arc::new(AtomicBool::new(false));
    let connection_state = Arc::new(RwLock::new(ConnectionState {
        online: false,
        phase: "idle".to_string(),
        error: None,
        last_success_at: None,
    }));
    let last_diagnosis = Arc::new(RwLock::new(None));

    // Start proxy server in background
    let proxy = ProxyServer::new(storage.clone(), last_diagnosis.clone())
        .await
        .expect("failed to start proxy server");
    let proxy_port = proxy.get_port();

    let proxy_handle = tokio::spawn(async move {
        if let Err(err) = proxy.run().await {
            tracing::error!("Proxy server stopped unexpectedly: {}", err);
        }
    });

    let app_state = AppState {
        storage,
        scanner,
        scan_cancel,
        quick_probe_running,
        proxy_port,
        connection_state,
        last_diagnosis,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::start_scan,
            commands::stop_scan,
            commands::get_scan_results,
            commands::get_scan_status,
            commands::get_discovery_hosts,
            commands::refresh_discovery,
            commands::add_host,
            commands::bind_host,
            commands::unbind_host,
            commands::get_status,
            commands::get_connection_state,
            commands::diagnose_host,
            commands::test_print,
            commands::get_printers,
            commands::get_settings,
            commands::update_settings,
            commands::get_host_note,
            commands::set_host_note,
            commands::get_all_host_notes,
            commands::get_favorite_hosts,
            commands::upsert_favorite_host,
            commands::remove_favorite_host,
            commands::get_proxy_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    // Cleanup
    proxy_handle.abort();
}
