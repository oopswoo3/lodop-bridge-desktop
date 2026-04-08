use crate::diagnostics::HostDiagnosis;
use crate::storage::{default_local_proxy_ports, Storage};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

use super::server::ProxyServer;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortProcessInfo {
    pub pid: u32,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccupiedPortInfo {
    pub port: u16,
    pub error: String,
    pub processes: Vec<PortProcessInfo>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRuntimeSnapshot {
    pub configured_ports: Vec<u16>,
    pub active_ports: Vec<u16>,
    pub occupied_ports: Vec<OccupiedPortInfo>,
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Default)]
struct ProxyRuntimeState {
    configured_ports: Vec<u16>,
    running: BTreeMap<u16, JoinHandle<()>>,
    occupied_ports: Vec<OccupiedPortInfo>,
    last_error: Option<String>,
}

pub struct ProxyRuntime {
    storage: Arc<RwLock<Storage>>,
    last_diagnosis: Arc<RwLock<Option<HostDiagnosis>>>,
    state: RwLock<ProxyRuntimeState>,
}

impl ProxyRuntime {
    pub fn new(
        storage: Arc<RwLock<Storage>>,
        last_diagnosis: Arc<RwLock<Option<HostDiagnosis>>>,
    ) -> Self {
        Self {
            storage,
            last_diagnosis,
            state: RwLock::new(ProxyRuntimeState {
                configured_ports: default_local_proxy_ports(),
                ..ProxyRuntimeState::default()
            }),
        }
    }

    pub async fn snapshot(&self) -> ProxyRuntimeSnapshot {
        let state = self.state.read().await;
        snapshot_from_state(&state)
    }

    pub async fn reload(&self, ports: &[u16]) -> Result<ProxyRuntimeSnapshot, String> {
        let normalized_ports = normalize_local_proxy_ports(ports)?;
        let mut state = self.state.write().await;

        for (_, handle) in state.running.iter() {
            handle.abort();
        }
        state.running.clear();
        tokio::time::sleep(Duration::from_millis(120)).await;

        state.configured_ports = normalized_ports.clone();
        state.occupied_ports.clear();
        state.last_error = None;

        for port in normalized_ports {
            match ProxyServer::bind_on(port, self.storage.clone(), self.last_diagnosis.clone())
                .await
            {
                Ok(server) => {
                    let handle = tokio::spawn(async move {
                        if let Err(err) = server.run().await {
                            tracing::error!("Proxy server on port {} stopped: {}", port, err);
                        }
                    });
                    state.running.insert(port, handle);
                }
                Err(err) => {
                    state.occupied_ports.push(OccupiedPortInfo {
                        port,
                        error: err,
                        processes: list_port_processes(port),
                    });
                }
            }
        }

        if state.running.is_empty() {
            state.last_error = Some("代理未就绪：所有本地监听端口均不可用".to_string());
        } else if !state.occupied_ports.is_empty() {
            state.last_error = Some("部分本地监听端口不可用".to_string());
        }

        Ok(snapshot_from_state(&state))
    }

    pub async fn kill_port_process(
        &self,
        port: u16,
        pid: u32,
    ) -> Result<ProxyRuntimeSnapshot, String> {
        if port == 0 || pid == 0 {
            return Err("端口和 PID 必须为正整数".to_string());
        }
        terminate_process_on_port(port, pid).await?;
        let configured_ports = {
            let state = self.state.read().await;
            state.configured_ports.clone()
        };
        self.reload(&configured_ports).await
    }
}

fn normalize_local_proxy_ports(ports: &[u16]) -> Result<Vec<u16>, String> {
    let mut normalized = ports
        .iter()
        .copied()
        .filter(|port| *port > 0)
        .collect::<Vec<_>>();
    normalized.sort_unstable();
    normalized.dedup();
    if normalized.len() != 2 {
        return Err("本地监听端口必须配置为两个不重复端口".to_string());
    }
    Ok(normalized)
}

fn snapshot_from_state(state: &ProxyRuntimeState) -> ProxyRuntimeSnapshot {
    let mut active_ports = state.running.keys().copied().collect::<Vec<_>>();
    active_ports.sort_unstable();

    let mut occupied_ports = state.occupied_ports.clone();
    occupied_ports.sort_by_key(|item| item.port);

    ProxyRuntimeSnapshot {
        configured_ports: state.configured_ports.clone(),
        active_ports: active_ports.clone(),
        occupied_ports,
        ready: !active_ports.is_empty(),
        last_error: state.last_error.clone(),
    }
}

fn list_port_processes(port: u16) -> Vec<PortProcessInfo> {
    let pids = list_port_pids(port);
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for pid in pids {
        if seen.insert(pid) {
            output.push(query_process_info(pid));
        }
    }
    output.sort_by_key(|item| item.pid);
    output
}

#[cfg(not(target_os = "windows"))]
fn list_port_pids(port: u16) -> Vec<u32> {
    let output = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{}", port), "-sTCP:LISTEN", "-t"])
        .output();

    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect::<Vec<_>>()
}

#[cfg(target_os = "windows")]
fn list_port_pids(port: u16) -> Vec<u32> {
    let output = Command::new("netstat").args(["-ano", "-p", "tcp"]).output();

    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| parse_windows_netstat_pid(line, port))
        .collect::<Vec<_>>()
}

#[cfg(target_os = "windows")]
fn parse_windows_netstat_pid(line: &str, port: u16) -> Option<u32> {
    let cols = line.split_whitespace().collect::<Vec<_>>();
    if cols.len() < 5 {
        return None;
    }
    let local = cols.get(1)?;
    let state = cols
        .get(cols.len().saturating_sub(2))
        .copied()
        .unwrap_or("");
    if !(state.contains("LISTEN") || state.contains("侦听")) {
        return None;
    }
    if !local_address_matches_port(local, port) {
        return None;
    }
    cols.last()?.parse::<u32>().ok()
}

#[cfg(target_os = "windows")]
fn local_address_matches_port(local: &str, port: u16) -> bool {
    local.ends_with(&format!(":{}", port)) || local.ends_with(&format!("]:{}", port))
}

#[cfg(not(target_os = "windows"))]
fn query_process_info(pid: u32) -> PortProcessInfo {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm=", "-o", "args="])
        .output();

    let (name, command) = match output {
        Ok(output) if output.status.success() => {
            let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if line.is_empty() {
                ("unknown".to_string(), None)
            } else {
                let mut parts = line.split_whitespace();
                let program = parts.next().unwrap_or("unknown").to_string();
                (program, Some(line))
            }
        }
        _ => ("unknown".to_string(), None),
    };

    let path = command
        .as_ref()
        .and_then(|value| value.split_whitespace().next())
        .map(|value| value.to_string());

    PortProcessInfo {
        pid,
        name,
        command,
        path,
    }
}

#[cfg(target_os = "windows")]
fn query_process_info(pid: u32) -> PortProcessInfo {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .output();

    let name = match output {
        Ok(output) if output.status.success() => {
            parse_tasklist_name(&output.stdout).unwrap_or_else(|| "unknown".to_string())
        }
        _ => "unknown".to_string(),
    };

    PortProcessInfo {
        pid,
        name,
        command: None,
        path: None,
    }
}

#[cfg(target_os = "windows")]
fn parse_tasklist_name(raw: &[u8]) -> Option<String> {
    let line = String::from_utf8_lossy(raw)
        .lines()
        .next()?
        .trim()
        .to_string();
    if line.is_empty() || line.starts_with("INFO:") {
        return None;
    }
    let cleaned = line.trim_matches('"').to_string();
    cleaned.split("\",\"").next().map(|name| name.to_string())
}

async fn terminate_process_on_port(port: u16, pid: u32) -> Result<(), String> {
    if !is_pid_listening_on_port(port, pid) {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        run_os_command("taskkill", &["/PID", &pid.to_string()])?;
        if wait_port_release(port, pid, 10, Duration::from_millis(200)).await {
            return Ok(());
        }
        run_os_command("taskkill", &["/F", "/PID", &pid.to_string()])?;
        if wait_port_release(port, pid, 10, Duration::from_millis(200)).await {
            return Ok(());
        }
        return Err(format!("无法终止 PID {}，端口 {} 仍被占用", pid, port));
    }

    #[cfg(not(target_os = "windows"))]
    {
        run_os_command("kill", &["-TERM", &pid.to_string()])?;
        if wait_port_release(port, pid, 10, Duration::from_millis(200)).await {
            return Ok(());
        }
        run_os_command("kill", &["-KILL", &pid.to_string()])?;
        if wait_port_release(port, pid, 10, Duration::from_millis(200)).await {
            return Ok(());
        }
        return Err(format!("无法终止 PID {}，端口 {} 仍被占用", pid, port));
    }
}

fn run_os_command(bin: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(bin)
        .args(args)
        .output()
        .map_err(|err| format!("执行 {} 失败: {}", bin, err))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "未知错误".to_string()
    };
    Err(format!("{} 执行失败: {}", bin, message))
}

async fn wait_port_release(port: u16, pid: u32, retries: usize, interval: Duration) -> bool {
    for _ in 0..retries {
        if !is_pid_listening_on_port(port, pid) {
            return true;
        }
        tokio::time::sleep(interval).await;
    }
    !is_pid_listening_on_port(port, pid)
}

fn is_pid_listening_on_port(port: u16, pid: u32) -> bool {
    list_port_processes(port)
        .iter()
        .any(|process| process.pid == pid)
}

#[cfg(test)]
mod tests {
    use super::normalize_local_proxy_ports;

    #[test]
    fn normalizes_proxy_ports_and_sorts() {
        let ports = normalize_local_proxy_ports(&[18000, 8000]).expect("should be valid");
        assert_eq!(ports, vec![8000, 18000]);
    }

    #[test]
    fn rejects_invalid_proxy_ports() {
        assert!(normalize_local_proxy_ports(&[8000]).is_err());
        assert!(normalize_local_proxy_ports(&[8000, 8000]).is_err());
    }
}
