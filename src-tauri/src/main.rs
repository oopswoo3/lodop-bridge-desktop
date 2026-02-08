// Prevents additional console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod proxy;
mod scanner;
mod storage;
mod error;
mod playwright_bridge;

use proxy::ProxyServer;
use scanner::Scanner;
use storage::Storage;
use playwright_bridge::PlaywrightBridge;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AppState {
    pub storage: Arc<RwLock<Storage>>,
    pub scanner: Arc<RwLock<Scanner>>,
    pub playwright: Arc<RwLock<PlaywrightBridge>>,
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
    let playwright = Arc::new(RwLock::new(PlaywrightBridge::new()));

    // Initialize Playwright in background
    let pw_clone = playwright.clone();
    tokio::spawn(async move {
        let mut pw = pw_clone.write().await;
        if let Err(e) = pw.init().await {
            tracing::warn!("Playwright initialization failed: {}", e);
        }
    });

    // Start proxy server in background
    let proxy = ProxyServer::new(storage.clone()).await;
    let _port = proxy.get_port();
    let proxy_handle = tokio::spawn(async move {
        proxy.run().await.unwrap();
    });

    let app_state = AppState {
        storage,
        scanner,
        playwright,
    };

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::start_scan,
            commands::stop_scan,
            commands::get_scan_results,
            commands::add_host,
            commands::bind_host,
            commands::unbind_host,
            commands::get_status,
            commands::test_print,
            commands::get_printers,
            commands::get_settings,
            commands::update_settings,
            commands::get_host_note,
            commands::set_host_note,
            commands::get_all_host_notes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    // Cleanup
    proxy_handle.abort();
}
