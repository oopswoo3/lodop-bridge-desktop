use crate::storage::HostInfo;
use futures_util::stream::{self, StreamExt};
use if_addrs::{get_if_addrs, IfAddr};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
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
    usable_found_count: Arc<RwLock<usize>>,
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
            usable_found_count: Arc::new(RwLock::new(0)),
            scanned_count: Arc::new(RwLock::new(0)),
            total_count: Arc::new(RwLock::new(0)),
            on_progress: None,
            on_host_found: None,
        }
    }

    pub fn set_callbacks(
        &mut self,
        on_progress: OnProgressCallback,
        on_host_found: OnHostFoundCallback,
    ) {
        self.on_progress = Some(on_progress);
        self.on_host_found = Some(on_host_found);
    }

    pub fn apply_settings(&mut self, settings: &crate::storage::Settings) {
        self.concurrency = settings.scan_concurrency.clamp(1, 512);
        self.timeout = Duration::from_millis(settings.scan_timeout.clamp(100, 10_000));

        let mut ports = settings
            .allowed_ports
            .iter()
            .copied()
            .filter(|p| *p > 0)
            .collect::<Vec<u16>>();
        ports.sort_unstable();
        ports.dedup();

        self.ports = if ports.is_empty() {
            vec![8000, 18000]
        } else {
            ports
        };
    }

    pub async fn start(&self, cancel: Arc<AtomicBool>) -> Result<usize> {
        {
            let mut scanning = self.is_scanning.write().await;
            if *scanning {
                return Err("扫描已在进行中".to_string());
            }
            *scanning = true;
        }

        self.found_hosts.write().await.clear();
        *self.usable_found_count.write().await = 0;
        *self.scanned_count.write().await = 0;

        let base_networks = self.get_local_networks().await;
        let additional_networks = self.get_additional_networks(&base_networks);
        let mut all_networks = base_networks.clone();
        all_networks.extend(additional_networks.clone());

        tracing::info!(
            "扫描网段准备完成: 基础网段 {} 个, 额外网段 {} 个",
            base_networks.len(),
            additional_networks.len()
        );
        for network in &all_networks {
            tracing::info!("扫描网段: {}", network.cidr());
        }

        let all_ips = self.generate_ips(&all_networks);

        let total = all_ips.len();
        *self.total_count.write().await = total;

        tracing::info!("开始扫描，共 {} 个 IP", total);

        if let Some(ref cb) = self.on_progress {
            cb(0, total, 0);
        }

        self.scan_ips(all_ips, cancel.clone()).await;

        {
            let mut scanning = self.is_scanning.write().await;
            *scanning = false;
        }

        let found_count = *self.usable_found_count.read().await;
        if cancel.load(Ordering::Relaxed) {
            tracing::info!("扫描已停止，已发现 {} 个主机", found_count);
        } else {
            tracing::info!("扫描完成，发现 {} 个主机", found_count);
        }
        Ok(found_count)
    }

    async fn scan_ips(&self, all_ips: Vec<String>, cancel: Arc<AtomicBool>) {
        let concurrency = self.concurrency;
        let found_hosts = self.found_hosts.clone();
        let usable_found_count = self.usable_found_count.clone();
        let scanned_count = self.scanned_count.clone();
        let total_count = self.total_count.clone();
        let ports = self.ports.clone();
        let timeout = self.timeout;
        let on_progress = self.on_progress.clone();
        let on_host_found = self.on_host_found.clone();

        stream::iter(all_ips.into_iter())
            .for_each_concurrent(concurrency, move |ip| {
                let found_hosts = found_hosts.clone();
                let usable_found_count = usable_found_count.clone();
                let scanned_count = scanned_count.clone();
                let total_count = total_count.clone();
                let ports = ports.clone();
                let on_progress = on_progress.clone();
                let on_host_found = on_host_found.clone();
                let cancel = cancel.clone();

                async move {
                    if !cancel.load(Ordering::Relaxed) {
                        for port in ports {
                            if cancel.load(Ordering::Relaxed) {
                                break;
                            }

                            if let Some(host) = Self::probe_host(&ip, port, timeout).await {
                                let key = format!("{}:{}", ip, port);

                                let is_new = {
                                    let mut hosts = found_hosts.write().await;
                                    if hosts.contains_key(&key) {
                                        false
                                    } else {
                                        hosts.insert(key, host.clone());
                                        true
                                    }
                                };

                                if is_new {
                                    if Self::is_usable_host(&host) {
                                        let mut usable_count = usable_found_count.write().await;
                                        *usable_count += 1;
                                    }
                                    if let Some(ref cb) = on_host_found {
                                        cb(host);
                                    }
                                }
                                break;
                            }
                        }
                    }

                    let new_count = {
                        let mut count = scanned_count.write().await;
                        *count += 1;
                        *count
                    };
                    let total = *total_count.read().await;
                    let found = *usable_found_count.read().await;

                    if let Some(ref cb) = on_progress {
                        cb(new_count, total, found);
                    }
                }
            })
            .await;
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

    pub async fn get_found_hosts(&self) -> Vec<HostInfo> {
        self.found_hosts.read().await.values().cloned().collect()
    }

    pub async fn get_scanned_count(&self) -> usize {
        *self.scanned_count.read().await
    }

    pub async fn get_total_count(&self) -> usize {
        *self.total_count.read().await
    }

    pub async fn get_found_count(&self) -> usize {
        *self.usable_found_count.read().await
    }

    pub async fn is_scanning(&self) -> bool {
        *self.is_scanning.read().await
    }

    fn is_usable_host(host: &HostInfo) -> bool {
        host.tcp_ok.unwrap_or(false) && host.script_ok.unwrap_or(false)
    }

    pub async fn get_network_fingerprint(&self) -> String {
        let mut cidrs = self
            .get_local_networks()
            .await
            .into_iter()
            .map(|network| network.cidr())
            .collect::<Vec<_>>();
        cidrs.sort_unstable();
        cidrs.join(",")
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

        let url = format!("http://{}:{}/c_sysmessage", ip, port);
        let host_info = tokio::time::timeout(timeout, Self::get_c_lodop_info(&url)).await;

        let (hostname, os, version) = match host_info {
            Ok(Ok(info)) => info,
            _ => (None, None, None),
        };
        let script_ok = tokio::time::timeout(timeout, Self::check_script_endpoint(ip, port))
            .await
            .unwrap_or(false);

        Some(HostInfo {
            ip: ip.to_string(),
            port,
            hostname,
            os,
            version,
            rtt: Some(rtt),
            tcp_ok: Some(true),
            script_ok: Some(script_ok),
            timestamp: chrono::Utc::now().timestamp_millis(),
        })
    }

    async fn get_c_lodop_info(
        url: &str,
    ) -> std::result::Result<(Option<String>, Option<String>, Option<String>), ()> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| ())?;

        let resp = client
            .get(url)
            .header("User-Agent", "C-Lodop-Client")
            .send()
            .await
            .map_err(|_| ())?;

        if !resp.status().is_success() {
            return Err(());
        }

        let text = resp.text().await.map_err(|_| ())?;

        let hostname = Self::extract_field(
            &text,
            &[
                "hostname",
                "HOSTNAME",
                "computername",
                "计算机名",
                "计算机名称",
                "machine",
            ],
        );
        let os = Self::extract_field(&text, &["OS", "os", "操作系统", "system", "系统"]);
        let version = Self::extract_field(&text, &["version", "VERSION", "ver", "版本"]);

        Ok((hostname, os, version))
    }

    fn extract_field(data: &str, patterns: &[&str]) -> Option<String> {
        for pattern in patterns {
            let escaped = regex::escape(pattern);

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

    async fn check_script_endpoint(ip: &str, port: u16) -> bool {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
        {
            Ok(client) => client,
            Err(_) => return false,
        };

        match client
            .get(format!("http://{}:{}/CLodopfuncs.js", ip, port))
            .send()
            .await
        {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    async fn get_local_networks(&self) -> Vec<NetworkInfo> {
        let mut networks = Vec::new();
        let mut seen = HashSet::new();

        if let Ok(ifaces) = get_if_addrs() {
            for iface in ifaces {
                let IfAddr::V4(v4) = iface.addr else {
                    continue;
                };
                if v4.ip.is_loopback() {
                    continue;
                }

                let prefix_len = Self::netmask_to_cidr(v4.netmask);
                if prefix_len == 0 {
                    continue;
                }

                let base = Self::network_base(v4.ip, v4.netmask);
                let cidr = format!("{}/{}", base, prefix_len);
                if seen.insert(cidr.clone()) {
                    tracing::info!(
                        "发现网卡 {}: ip={}, netmask={}, cidr={}",
                        iface.name,
                        v4.ip,
                        v4.netmask,
                        cidr
                    );
                    networks.push(NetworkInfo::new(v4.ip, base, prefix_len));
                }
            }
        }

        if networks.is_empty() {
            tracing::warn!("未读取到本机网卡，使用默认私网段扫描");
            networks.extend([
                NetworkInfo::new(
                    Ipv4Addr::new(192, 168, 0, 1),
                    Ipv4Addr::new(192, 168, 0, 0),
                    24,
                ),
                NetworkInfo::new(
                    Ipv4Addr::new(192, 168, 1, 1),
                    Ipv4Addr::new(192, 168, 1, 0),
                    24,
                ),
                NetworkInfo::new(Ipv4Addr::new(10, 0, 0, 1), Ipv4Addr::new(10, 0, 0, 0), 24),
                NetworkInfo::new(
                    Ipv4Addr::new(172, 16, 0, 1),
                    Ipv4Addr::new(172, 16, 0, 0),
                    24,
                ),
            ]);
        }

        networks
    }

    fn get_additional_networks(&self, base_networks: &[NetworkInfo]) -> Vec<NetworkInfo> {
        let mut additional = Vec::new();
        let mut scanned_segments: HashSet<(u8, u8, u8)> = HashSet::new();

        for network in base_networks {
            let [a, b, c, _] = network.ip.octets();
            if network.prefix_len >= 24 {
                scanned_segments.insert((a, b, c));
            } else if network.prefix_len == 23 {
                let base_third = (c / 2) * 2;
                scanned_segments.insert((a, b, base_third));
                scanned_segments.insert((a, b, base_third.saturating_add(1)));
            }
        }

        const COMMON_THIRD_SEGMENTS: [u8; 10] = [116, 100, 101, 102, 103, 104, 105, 110, 120, 130];

        for network in base_networks {
            let [a, b, c, _] = network.ip.octets();
            if a != 10 {
                continue;
            }

            if network.prefix_len == 23 {
                let base_third = (c / 2) * 2;
                for third in [base_third, base_third.saturating_add(1)] {
                    if scanned_segments.insert((a, b, third)) {
                        additional.push(NetworkInfo::from_segment(a, b, third));
                    }
                }
            }

            for third in COMMON_THIRD_SEGMENTS {
                if scanned_segments.insert((a, b, third)) {
                    additional.push(NetworkInfo::from_segment(a, b, third));
                }
            }
        }

        additional
    }

    fn generate_ips(&self, networks: &[NetworkInfo]) -> Vec<String> {
        let mut ips = Vec::new();
        let mut seen = HashSet::new();

        for network in networks {
            let mut segment_count = 0usize;
            for ip in self.generate_ips_for_network(network) {
                if seen.insert(ip.clone()) {
                    segment_count += 1;
                    ips.push(ip);
                }
            }
            tracing::info!("网段 {} 生成 {} 个去重后 IP", network.cidr(), segment_count);
        }

        ips
    }

    fn generate_ips_for_network(&self, network: &NetworkInfo) -> Vec<String> {
        let mut ips = Vec::new();

        if network.prefix_len >= 22 {
            let host_bits = (32 - network.prefix_len) as u32;
            let total_hosts = 1u64 << host_bits;
            if total_hosts <= 2 {
                ips.push(network.ip.to_string());
                return ips;
            }

            let base_num = u32::from(network.base) as u64;
            for offset in 1..(total_hosts - 1) {
                let ip_num = (base_num + offset) as u32;
                ips.push(Ipv4Addr::from(ip_num).to_string());
            }
            return ips;
        }

        let [a, b, c, _] = network.ip.octets();
        let local24_base = Ipv4Addr::new(a, b, c, 0);
        let base_num = u32::from(local24_base);
        for offset in 1..=254 {
            ips.push(Ipv4Addr::from(base_num + offset).to_string());
        }
        ips
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

    fn netmask_to_cidr(netmask: Ipv4Addr) -> u8 {
        netmask
            .octets()
            .iter()
            .map(|octet| octet.count_ones() as u8)
            .sum()
    }
}

#[derive(Debug, Clone)]
struct NetworkInfo {
    ip: Ipv4Addr,
    base: Ipv4Addr,
    prefix_len: u8,
}

impl NetworkInfo {
    fn new(ip: Ipv4Addr, base: Ipv4Addr, prefix_len: u8) -> Self {
        Self {
            ip,
            base,
            prefix_len,
        }
    }

    fn from_segment(a: u8, b: u8, c: u8) -> Self {
        Self {
            ip: Ipv4Addr::new(a, b, c, 1),
            base: Ipv4Addr::new(a, b, c, 0),
            prefix_len: 24,
        }
    }

    fn cidr(&self) -> String {
        format!("{}/{}", self.base, self.prefix_len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn generates_full_hosts_for_24_and_23() {
        let scanner = Scanner::new();

        let net24 = NetworkInfo::new(
            Ipv4Addr::new(10, 202, 100, 5),
            Ipv4Addr::new(10, 202, 100, 0),
            24,
        );
        let net23 = NetworkInfo::new(
            Ipv4Addr::new(10, 202, 116, 10),
            Ipv4Addr::new(10, 202, 116, 0),
            23,
        );

        let ips24 = scanner.generate_ips_for_network(&net24);
        let ips23 = scanner.generate_ips_for_network(&net23);

        assert_eq!(ips24.len(), 254);
        assert_eq!(ips23.len(), 510);
        assert_eq!(ips24.first().map(String::as_str), Some("10.202.100.1"));
        assert_eq!(ips24.last().map(String::as_str), Some("10.202.100.254"));
    }

    #[test]
    fn large_subnet_falls_back_to_local_24() {
        let scanner = Scanner::new();
        let net16 = NetworkInfo::new(
            Ipv4Addr::new(10, 202, 88, 16),
            Ipv4Addr::new(10, 202, 0, 0),
            16,
        );

        let ips = scanner.generate_ips_for_network(&net16);
        assert_eq!(ips.len(), 254);
        assert_eq!(ips.first().map(String::as_str), Some("10.202.88.1"));
        assert_eq!(ips.last().map(String::as_str), Some("10.202.88.254"));
    }

    #[test]
    fn adds_main_compatible_common_segments_for_10_network() {
        let scanner = Scanner::new();
        let base = vec![NetworkInfo::new(
            Ipv4Addr::new(10, 202, 100, 12),
            Ipv4Addr::new(10, 202, 100, 0),
            24,
        )];

        let additional = scanner.get_additional_networks(&base);
        let cidrs = additional
            .iter()
            .map(NetworkInfo::cidr)
            .collect::<HashSet<_>>();

        assert!(cidrs.contains("10.202.116.0/24"));
        assert!(cidrs.contains("10.202.110.0/24"));
        assert!(!cidrs.contains("10.202.100.0/24"));
    }

    #[tokio::test]
    async fn scan_scheduler_does_not_stall_when_targets_exceed_concurrency() {
        let mut scanner = Scanner::new();
        scanner.concurrency = 2;
        scanner.timeout = Duration::from_millis(50);
        scanner.ports = vec![65534];

        let ip_count = 24usize;
        let ips = (0..ip_count)
            .map(|_| "127.0.0.1".to_string())
            .collect::<Vec<_>>();
        *scanner.total_count.write().await = ip_count;

        let cancel = Arc::new(AtomicBool::new(false));
        let run_result =
            tokio::time::timeout(Duration::from_secs(2), scanner.scan_ips(ips, cancel)).await;

        assert!(
            run_result.is_ok(),
            "scan scheduler stalled when targets exceed concurrency"
        );
        assert_eq!(scanner.get_scanned_count().await, ip_count);
    }

    #[tokio::test]
    async fn found_count_tracks_only_usable_hosts() {
        let scanner = Scanner::new();
        let now = chrono::Utc::now().timestamp_millis();

        {
            let mut hosts = scanner.found_hosts.write().await;
            hosts.insert(
                "10.0.0.1:8000".to_string(),
                HostInfo {
                    ip: "10.0.0.1".to_string(),
                    port: 8000,
                    hostname: None,
                    os: None,
                    version: None,
                    rtt: Some(1),
                    tcp_ok: Some(true),
                    script_ok: Some(true),
                    timestamp: now,
                },
            );
            hosts.insert(
                "10.0.0.2:8000".to_string(),
                HostInfo {
                    ip: "10.0.0.2".to_string(),
                    port: 8000,
                    hostname: None,
                    os: None,
                    version: None,
                    rtt: Some(1),
                    tcp_ok: Some(true),
                    script_ok: Some(false),
                    timestamp: now,
                },
            );
            hosts.insert(
                "10.0.0.3:8000".to_string(),
                HostInfo {
                    ip: "10.0.0.3".to_string(),
                    port: 8000,
                    hostname: None,
                    os: None,
                    version: None,
                    rtt: Some(1),
                    tcp_ok: Some(false),
                    script_ok: Some(false),
                    timestamp: now,
                },
            );
        }

        {
            let hosts = scanner.found_hosts.read().await;
            let usable = hosts.values().filter(|host| Scanner::is_usable_host(host)).count();
            *scanner.usable_found_count.write().await = usable;
        }

        assert_eq!(scanner.get_found_count().await, 1);
    }
}
