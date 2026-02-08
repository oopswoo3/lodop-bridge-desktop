use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostInfo {
    pub ip: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rtt: Option<u64>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub scan_concurrency: usize,
    pub scan_timeout: u64,
    pub allowed_ports: Vec<u16>,
    pub allowed_origins: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            scan_concurrency: 64,
            scan_timeout: 800,
            allowed_ports: vec![8000, 18000],
            allowed_origins: vec!["localhost".to_string(), "127.0.0.1".to_string()],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageData {
    pub bound_host: Option<HostInfo>,
    pub host_notes: HashMap<String, String>,
    pub settings: Settings,
    pub last_update: Option<i64>,
}

impl Default for StorageData {
    fn default() -> Self {
        Self {
            bound_host: None,
            host_notes: HashMap::new(),
            settings: Settings::default(),
            last_update: None,
        }
    }
}

pub struct Storage {
    path: PathBuf,
    data: StorageData,
}

impl Storage {
    pub async fn new() -> Self {
        let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        path.push(".lodop-tauri");
        path.push("config.json");

        // Create directory if not exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.unwrap_or_else(|e| {
                eprintln!("Failed to create config directory: {}", e);
            });
        }

        // Load or create default data
        let data = if path.exists() {
            fs::read_to_string(&path)
                .await
                .ok()
                .and_then(|content| serde_json::from_str(&content).ok())
                .unwrap_or_default()
        } else {
            StorageData::default()
        };

        Self { path, data }
    }

    async fn save(&self) -> Result<()> {
        let content = serde_json::to_string_pretty(&self.data)
            .map_err(|e| format!("Storage error: {}", e))?;
        fs::write(&self.path, content)
            .await
            .map_err(|e| format!("Storage error: {}", e))?;
        Ok(())
    }

    pub async fn get_bound_host(&self) -> Option<HostInfo> {
        self.data.bound_host.clone()
    }

    pub async fn set_bound_host(&mut self, host: HostInfo) -> Result<()> {
        self.data.bound_host = Some(host);
        self.data.last_update = Some(chrono::Utc::now().timestamp_millis());
        self.save().await
    }

    pub async fn clear_bound_host(&mut self) -> Result<()> {
        self.data.bound_host = None;
        self.data.last_update = None;
        self.save().await
    }

    pub async fn get_settings(&self) -> Settings {
        self.data.settings.clone()
    }

    pub async fn update_settings(&mut self, settings: Settings) -> Result<()> {
        self.data.settings = settings;
        self.save().await
    }

    pub async fn get_host_note(&self, ip: &str, port: u16) -> Option<String> {
        let key = format!("{}:{}", ip, port);
        self.data.host_notes.get(&key).cloned()
    }

    pub async fn set_host_note(&mut self, ip: &str, port: u16, note: String) -> Result<()> {
        let key = format!("{}:{}", ip, port);
        if note.trim().is_empty() {
            self.data.host_notes.remove(&key);
        } else {
            self.data.host_notes.insert(key, note.trim().to_string());
        }
        self.save().await
    }

    pub async fn get_all_host_notes(&self) -> HashMap<String, String> {
        self.data.host_notes.clone()
    }
}
