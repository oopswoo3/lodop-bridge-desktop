use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;

pub type Result<T> = std::result::Result<T, String>;
pub const FAVORITE_HOSTS_MAX: usize = 20;
pub const DEFAULT_SCAN_PORT: u16 = 8000;

pub fn default_local_proxy_ports() -> Vec<u16> {
    vec![8000, 18000]
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tcp_ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_ok: Option<bool>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryHost {
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tcp_ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_ok: Option<bool>,
    pub status: String,
    pub source: String,
    pub last_seen: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ok: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteHost {
    pub ip: String,
    pub port: u16,
    pub name: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_scan_concurrency")]
    pub scan_concurrency: usize,
    #[serde(default = "default_scan_timeout")]
    pub scan_timeout: u64,
    #[serde(default = "default_allowed_ports")]
    pub allowed_ports: Vec<u16>,
    #[serde(default = "default_allowed_origins")]
    pub allowed_origins: Vec<String>,
    #[serde(default = "default_local_proxy_ports")]
    pub local_proxy_ports: Vec<u16>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            scan_concurrency: default_scan_concurrency(),
            scan_timeout: default_scan_timeout(),
            // Keep legacy field for backward compatibility; scanner no longer reads this.
            allowed_ports: default_allowed_ports(),
            allowed_origins: default_allowed_origins(),
            local_proxy_ports: default_local_proxy_ports(),
        }
    }
}

fn default_scan_concurrency() -> usize {
    24
}

fn default_scan_timeout() -> u64 {
    600
}

fn default_allowed_ports() -> Vec<u16> {
    vec![DEFAULT_SCAN_PORT]
}

fn default_allowed_origins() -> Vec<String> {
    vec!["localhost".to_string(), "127.0.0.1".to_string()]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageData {
    pub bound_host: Option<HostInfo>,
    pub host_notes: HashMap<String, String>,
    #[serde(default)]
    pub favorite_hosts: HashMap<String, FavoriteHost>,
    pub settings: Settings,
    pub last_update: Option<i64>,
    #[serde(default)]
    pub discovery_hosts: HashMap<String, DiscoveryHost>,
    #[serde(default)]
    pub discovery_last_deep_scan_at: Option<i64>,
    #[serde(default)]
    pub discovery_network_fingerprint: Option<String>,
}

impl Default for StorageData {
    fn default() -> Self {
        Self {
            bound_host: None,
            host_notes: HashMap::new(),
            favorite_hosts: HashMap::new(),
            settings: Settings::default(),
            last_update: None,
            discovery_hosts: HashMap::new(),
            discovery_last_deep_scan_at: None,
            discovery_network_fingerprint: None,
        }
    }
}

pub struct Storage {
    path: PathBuf,
    data: StorageData,
}

impl Storage {
    fn discovery_key(ip: &str, port: u16) -> String {
        format!("{}:{}", ip, port)
    }

    fn favorite_key(ip: &str, _port: u16) -> String {
        ip.to_string()
    }

    pub async fn new() -> Self {
        let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        path.push(".lodop-bridge-desktop");
        path.push("config.json");

        // Create directory if not exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.unwrap_or_else(|e| {
                eprintln!("Failed to create config directory: {}", e);
            });
        }

        // Load or create default data
        let mut data = if path.exists() {
            fs::read_to_string(&path)
                .await
                .ok()
                .and_then(|content| serde_json::from_str(&content).ok())
                .unwrap_or_default()
        } else {
            StorageData::default()
        };

        normalize_loaded_data(&mut data);
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

    pub async fn get_favorite_hosts(&self) -> Vec<FavoriteHost> {
        let mut hosts = self
            .data
            .favorite_hosts
            .values()
            .cloned()
            .collect::<Vec<_>>();
        hosts.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then(left.ip.cmp(&right.ip))
                .then(left.port.cmp(&right.port))
        });
        hosts
    }

    pub async fn upsert_favorite_host(&mut self, ip: &str, port: u16, name: String) -> Result<()> {
        let key = Self::favorite_key(ip, port);
        if should_reject_new_favorite(
            self.data.favorite_hosts.len(),
            self.data.favorite_hosts.contains_key(&key),
        ) {
            return Err(format!(
                "收藏已达上限 {}，请先移除一个收藏",
                FAVORITE_HOSTS_MAX
            ));
        }
        let normalized_name = normalize_favorite_name(&name);

        self.data.favorite_hosts.insert(
            key,
            FavoriteHost {
                ip: ip.to_string(),
                port,
                name: normalized_name,
                updated_at: chrono::Utc::now().timestamp_millis(),
            },
        );

        self.save().await
    }

    pub async fn remove_favorite_host(&mut self, ip: &str, port: u16) -> Result<()> {
        let key = Self::favorite_key(ip, port);
        self.data.favorite_hosts.remove(&key);
        self.save().await
    }

    pub async fn get_discovery_hosts(&self) -> Vec<DiscoveryHost> {
        self.data.discovery_hosts.values().cloned().collect()
    }

    pub async fn upsert_discovery_hosts(&mut self, hosts: Vec<DiscoveryHost>) -> Result<()> {
        for host in hosts {
            let key = Self::discovery_key(&host.ip, host.port);
            self.data.discovery_hosts.insert(key, host);
        }
        self.save().await
    }

    pub async fn get_discovery_last_deep_scan_at(&self) -> Option<i64> {
        self.data.discovery_last_deep_scan_at
    }

    pub async fn set_discovery_last_deep_scan_at(&mut self, timestamp: i64) -> Result<()> {
        self.data.discovery_last_deep_scan_at = Some(timestamp);
        self.save().await
    }

    pub async fn get_discovery_network_fingerprint(&self) -> Option<String> {
        self.data.discovery_network_fingerprint.clone()
    }

    pub async fn set_discovery_network_fingerprint(&mut self, fingerprint: String) -> Result<()> {
        self.data.discovery_network_fingerprint = Some(fingerprint);
        self.save().await
    }
}

fn normalize_favorite_name(raw: &str) -> String {
    raw.trim().to_string()
}

fn should_reject_new_favorite(current_len: usize, key_exists: bool) -> bool {
    !key_exists && current_len >= FAVORITE_HOSTS_MAX
}

fn normalize_loaded_data(data: &mut StorageData) {
    // Security policy: keep local-only whitelist regardless of historical config.
    data.settings.allowed_origins = default_allowed_origins();
    data.settings.local_proxy_ports = default_local_proxy_ports();

    if data.favorite_hosts.is_empty() {
        return;
    }

    // Migrate legacy favorite keys (`ip:port`) to `ip` and keep the newest record.
    let mut normalized: HashMap<String, FavoriteHost> = HashMap::new();
    for favorite in data.favorite_hosts.values() {
        match normalized.get(&favorite.ip) {
            Some(existing) if existing.updated_at >= favorite.updated_at => {}
            _ => {
                normalized.insert(favorite.ip.clone(), favorite.clone());
            }
        }
    }
    data.favorite_hosts = normalized;
}

#[cfg(test)]
mod tests {
    use super::{
        default_local_proxy_ports, normalize_favorite_name, normalize_loaded_data,
        should_reject_new_favorite, FavoriteHost, StorageData, FAVORITE_HOSTS_MAX,
    };
    use std::collections::HashMap;

    #[test]
    fn keeps_empty_when_favorite_name_is_blank() {
        let value = normalize_favorite_name("   ");
        assert_eq!(value, "");
    }

    #[test]
    fn trims_non_blank_favorite_name() {
        let value = normalize_favorite_name("  财务打印机  ");
        assert_eq!(value, "财务打印机");
    }

    #[test]
    fn rejects_new_favorite_when_limit_reached() {
        assert!(should_reject_new_favorite(FAVORITE_HOSTS_MAX, false));
    }

    #[test]
    fn allows_updating_existing_favorite_when_limit_reached() {
        assert!(!should_reject_new_favorite(FAVORITE_HOSTS_MAX, true));
    }

    #[test]
    fn migrates_legacy_favorite_keys_to_ip_and_keeps_latest() {
        let mut data = StorageData::default();
        data.favorite_hosts = HashMap::from([
            (
                "10.0.0.8:8000".to_string(),
                FavoriteHost {
                    ip: "10.0.0.8".to_string(),
                    port: 8000,
                    name: "A".to_string(),
                    updated_at: 10,
                },
            ),
            (
                "10.0.0.8:18000".to_string(),
                FavoriteHost {
                    ip: "10.0.0.8".to_string(),
                    port: 18000,
                    name: "B".to_string(),
                    updated_at: 20,
                },
            ),
        ]);

        normalize_loaded_data(&mut data);

        assert_eq!(data.favorite_hosts.len(), 1);
        let item = data
            .favorite_hosts
            .get("10.0.0.8")
            .expect("missing favorite");
        assert_eq!(item.port, 18000);
        assert_eq!(item.name, "B");
    }

    #[test]
    fn normalizes_loaded_local_proxy_ports_to_defaults() {
        let mut data = StorageData::default();
        data.settings.local_proxy_ports = vec![3000, 4000];

        normalize_loaded_data(&mut data);

        assert_eq!(data.settings.local_proxy_ports, default_local_proxy_ports());
    }
}
