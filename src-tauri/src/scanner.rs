use crate::storage::HostInfo;
use futures_util::stream::{FuturesUnordered, StreamExt};
use local_ip_address::local_ip;
use regex::Regex;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::RwLock;

pub type Result<T> = std::result::Result<T, String>;

pub type OnProgressCallback = Arc<dyn Fn(usize, usize, usize) + Send + Sync>;
pub type OnHostFoundCallback = Arc<dyn Fn(HostInfo) + Send + Sync>;

pub struct Scanner {
    concurrency: usize,
    timeout: Duration,
    ports: Vec<u16>,
    is_scanning: Arc<RwLock<bool>>,
    found_hosts: Arc<RwLock<HashMap<String, HostInfo>>>,
    scanned_count: Arc<RwLock<usize>>,
    total_count: Arc<RwLock<usize>>,
    on_progress: Option<OnProgressCallback>,
    on_host_found: Option<OnHostFoundCallback>,
}

impl Scanner {
    pub fn new() -> Self {
        Self {
            concurrency: 64,
            timeout: Duration::from_millis(800),
            ports: vec![8000, 18000],
            is_scanning: Arc::new(RwLock::new(false)),
            found_hosts: Arc::new(RwLock::new(HashMap::new())),
            scanned_count: Arc::new(RwLock::new(0)),
            total_count: Arc::new(RwLock::new(0)),
            on_progress: None,
            on_host_found: None,
        }
    }

    pub fn set_callbacks(&mut self, on_progress: OnProgressCallback, on_host_found: OnHostFoundCallback) {
        self.on_progress = Some(on_progress);
        self.on_host_found = Some(on_host_found);
    }

    pub async fn start(&mut self) -> Result<usize> {
        {
            let mut scanning = self.is_scanning.write().await;
            if *scanning {
                return Err("扫描已在进行中".to_string());
            }
            *scanning = true;
        }

        self.found_hosts.write().await.clear();
        *self.scanned_count.write().await = 0;

        let networks = self.get_local_networks().await;
        let all_ips = self.generate_ips(&networks);

        let total = all_ips.len();
        *self.total_count.write().await = total;

        tracing::info!("开始扫描，共 {} 个 IP", total);

        // Emit initial progress
        if let Some(ref cb) = self.on_progress {
            cb(0, total, 0);
        }

        let mut scan_futures = FuturesUnordered::new();
        let semaphore = Arc::new(tokio::sync::Semaphore::new(self.concurrency));

        for ip in all_ips {
            let permit = semaphore.clone().acquire_owned().await.unwrap();
            let found_hosts = self.found_hosts.clone();
            let scanned_count = self.scanned_count.clone();
            let total_count = self.total_count.clone();
            let ports = self.ports.clone();
            let timeout = self.timeout;
            let on_progress = self.on_progress.clone();
            let on_host_found = self.on_host_found.clone();

            let future = async move {
                let _permit = permit;
                for port in ports {
                    if let Some(host) = Self::probe_host(&ip, port, timeout).await {
                        let key = format!("{}:{}", ip, port);

                        // Check if host already exists
                        let is_new = {
                            let mut hosts = found_hosts.write().await;
                            if hosts.contains_key(&key) {
                                false
                            } else {
                                hosts.insert(key.clone(), host.clone());
                                true
                            }
                        };

                        // Emit host-found event for new hosts
                        if is_new {
                            if let Some(ref cb) = on_host_found {
                                cb(host);
                            }
                        }
                        break;
                    }
                }

                // Update progress
                let count = { *scanned_count.read().await };
                *scanned_count.write().await = count + 1;
                let new_count = count + 1;
                let total = *total_count.read().await;
                let found = found_hosts.read().await.len();

                // Emit progress event
                if let Some(ref cb) = on_progress {
                    cb(new_count, total, found);
                }
            };

            scan_futures.push(future);
        }

        while scan_futures.next().await.is_some() {}

        {
            let mut scanning = self.is_scanning.write().await;
            *scanning = false;
        }

        let found_count = self.found_hosts.read().await.len();
        tracing::info!("扫描完成，发现 {} 个主机", found_count);
        Ok(found_count)
    }

    pub fn stop(&mut self) {
        let rt = tokio::runtime::Handle::current();
        rt.spawn(async move {});
    }

    pub async fn add_host(&mut self, ip: String, port: u16) -> Result<serde_json::Value> {
        if let Some(host) = Self::probe_host(&ip, port, self.timeout).await {
            let key = format!("{}:{}", ip, port);
            let host_json = serde_json::to_value(&host).unwrap();
            self.found_hosts.write().await.insert(key, host);
            Ok(host_json)
        } else {
            Err("端口不可达".to_string())
        }
    }

    pub async fn get_found_hosts(&self) -> Vec<serde_json::Value> {
        self.found_hosts
            .read()
            .await
            .values()
            .map(|h| serde_json::to_value(h).unwrap())
            .collect()
    }

    pub async fn get_scanned_count(&self) -> usize {
        *self.scanned_count.read().await
    }

    pub async fn is_scanning(&self) -> bool {
        *self.is_scanning.read().await
    }

    async fn probe_host(ip: &str, port: u16, timeout: Duration) -> Option<HostInfo> {
        let start = Instant::now();

        let addr = format!("{}:{}", ip, port);
        let socket = tokio::time::timeout(timeout, TcpStream::connect(&addr)).await;

        let _socket = match socket {
            Ok(Ok(s)) => s,
            _ => return None,
        };

        let rtt = start.elapsed().as_millis() as u64;

        // Try HTTP GET to c_sysmessage to get host info
        let url = format!("http://{}:{}/c_sysmessage", ip, port);
        let host_info = tokio::time::timeout(timeout, Self::get_c_lodop_info(&url)).await;

        let (hostname, os, version) = match host_info {
            Ok(Ok(info)) => info,
            _ => (None, None, None),
        };

        Some(HostInfo {
            ip: ip.to_string(),
            port,
            hostname,
            os,
            version,
            rtt: Some(rtt),
            timestamp: chrono::Utc::now().timestamp_millis(),
        })
    }

    async fn get_c_lodop_info(url: &str) -> std::result::Result<(Option<String>, Option<String>, Option<String>), ()> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| ())?;

        let resp = client.get(url)
            .header("User-Agent", "C-Lodop-Client")
            .send()
            .await
            .map_err(|_| ())?;

        if !resp.status().is_success() {
            return Err(());
        }

        let text = resp.text().await.map_err(|_| ())?;

        // Parse c_sysmessage response - look for various patterns
        let hostname = Self::extract_field(&text, &["hostname", "HOSTNAME", "computername", "计算机名", "计算机名称", "machine"]);
        let os = Self::extract_field(&text, &["OS", "os", "操作系统", "system", "系统"]);
        let version = Self::extract_field(&text, &["version", "VERSION", "ver", "版本"]);

        Ok((hostname, os, version))
    }

    fn extract_field(data: &str, patterns: &[&str]) -> Option<String> {
        for pattern in patterns {
            let escaped = regex::escape(pattern);

            // Pattern 1: var name = "value";
            let pattern1 = format!(r#"var\s+{}\s*=\s*["']([^"']+)["']"#, escaped);
            if let Ok(re) = Regex::new(&pattern1) {
                if let Some(caps) = re.captures(data) {
                    if let Some(value) = caps.get(1).map(|m| m.as_str()) {
                        if !value.is_empty() && value.len() < 100 {
                            return Some(value.to_string());
                        }
                    }
                }
            }

            // Pattern 2: JSON style
            let pattern2 = format!(r#"["']{}["']\s*:\s*["']([^"']+)["']"#, escaped);
            if let Ok(re) = Regex::new(&pattern2) {
                if let Some(caps) = re.captures(data) {
                    if let Some(value) = caps.get(1).map(|m| m.as_str()) {
                        if !value.is_empty() && value.len() < 100 {
                            return Some(value.to_string());
                        }
                    }
                }
            }

            // Pattern 3: name: value
            let pattern3 = format!(r#"{}\s*:\s*["']?([^"'\r\n]+)["']?"#, escaped);
            if let Ok(re) = Regex::new(&pattern3) {
                if let Some(caps) = re.captures(data) {
                    if let Some(value) = caps.get(1).map(|m| m.as_str()) {
                        let trimmed = value.trim();
                        if !trimmed.is_empty() && trimmed.len() < 100 && !trimmed.starts_with('{') {
                            return Some(trimmed.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    async fn get_local_networks(&self) -> Vec<NetworkInfo> {
        let mut networks = Vec::new();

        if let Ok(local_ip) = local_ip() {
            if let IpAddr::V4(ipv4) = local_ip {
                for prefix_len in [24u8, 23, 22, 16] {
                    let mask = Self::cidr_to_netmask(prefix_len);
                    let base = Self::network_base(ipv4, mask);
                    networks.push(NetworkInfo {
                        ip: local_ip.to_string(),
                        netmask: mask.to_string(),
                        cidr: format!("{}/{}", base, prefix_len),
                        base_ip: base.to_string(),
                    });
                }
            }
        }

        if networks.is_empty() {
            networks.push(NetworkInfo {
                ip: "127.0.0.1".to_string(),
                netmask: "255.255.255.0".to_string(),
                cidr: "192.168.1.0/24".to_string(),
                base_ip: "192.168.1.0".to_string(),
            });
        }

        networks
    }

    fn generate_ips(&self, networks: &[NetworkInfo]) -> Vec<String> {
        let mut ips = Vec::new();

        for network in networks {
            let parts: Vec<&str> = network.cidr.split('/').collect();
            if parts.len() != 2 {
                continue;
            }

            let base_ip = parts[0];
            let prefix_len: u8 = parts[1].parse().unwrap_or(24);

            if prefix_len >= 24 {
                let base_parts: Vec<u8> = base_ip
                    .split('.')
                    .map(|p| p.parse().unwrap_or(0))
                    .collect();

                for i in 1..=254 {
                    ips.push(format!("{}.{}.{}.{}", base_parts[0], base_parts[1], base_parts[2], i));
                }
            }
        }

        ips
    }

    fn cidr_to_netmask(cidr: u8) -> Ipv4Addr {
        let mask = if cidr == 0 {
            0u32
        } else {
            !0u32 << (32 - cidr)
        };
        Ipv4Addr::new(
            ((mask >> 24) & 0xFF) as u8,
            ((mask >> 16) & 0xFF) as u8,
            ((mask >> 8) & 0xFF) as u8,
            (mask & 0xFF) as u8,
        )
    }

    fn network_base(ip: Ipv4Addr, netmask: Ipv4Addr) -> Ipv4Addr {
        let ip_bytes = ip.octets();
        let mask_bytes = netmask.octets();
        Ipv4Addr::new(
            ip_bytes[0] & mask_bytes[0],
            ip_bytes[1] & mask_bytes[1],
            ip_bytes[2] & mask_bytes[2],
            ip_bytes[3] & mask_bytes[3],
        )
    }
}

struct NetworkInfo {
    ip: String,
    netmask: String,
    cidr: String,
    base_ip: String,
}
