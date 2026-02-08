use crate::storage::HostInfo;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashMap;

pub type Result<T> = std::result::Result<T, String>;

/// Playwright Bridge for interacting with C-Lodop servers
/// This module handles communication with remote C-Lodop servers via HTTP
pub struct PlaywrightBridge {
    bound_host: Option<HostInfo>,
    callback_registry: Arc<RwLock<HashMap<String, Value>>>,
    http_client: reqwest::Client,
}

impl PlaywrightBridge {
    pub fn new() -> Self {
        Self {
            bound_host: None,
            callback_registry: Arc::new(RwLock::new(HashMap::new())),
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        }
    }

    /// Initialize the bridge (placeholder for Playwright initialization)
    pub async fn init(&mut self) -> Result<()> {
        tracing::info!("Initializing Playwright Bridge...");

        // For now, we use HTTP-based communication
        // Full Playwright integration can be added later if needed

        tracing::info!("Playwright Bridge initialized");
        Ok(())
    }

    /// Bind to a C-Lodop server
    pub async fn bind_host(&mut self, host: &HostInfo) -> Result<()> {
        let url = format!("http://{}:{}/", host.ip, host.port);
        tracing::info!("Binding to C-Lodop server at {}", url);

        // Test connection by fetching the main page
        let test_url = format!("http://{}:{}/c_sysmessage", host.ip, host.port);
        match self.http_client.get(&test_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!("Successfully connected to C-Lodop server");
                self.bound_host = Some(host.clone());
                Ok(())
            }
            Ok(resp) => {
                let status = resp.status();
                Err(format!("Server returned status: {}", status))
            }
            Err(e) => {
                Err(format!("Failed to connect to server: {}", e))
            }
        }
    }

    /// Unbind from current host
    pub async fn unbind_host(&mut self) -> Result<()> {
        self.bound_host = None;

        // Clear callback registry
        let mut registry = self.callback_registry.write().await;
        registry.clear();

        tracing::info!("Unbound from host");

        Ok(())
    }

    /// Invoke a LODOP method via HTTP proxy
    pub async fn invoke(&self, method: &str, args: &[Value]) -> Result<InvokeResult> {
        let host = self.bound_host.as_ref()
            .ok_or_else(|| "Not bound to any host".to_string())?;

        // Build the request to send via proxy
        // The actual invocation will go through the proxy server
        let url = format!("http://127.0.0.1:8000/c_webskt/{}", method);

        let payload = serde_json::json!({
            "method": method,
            "args": args,
            "target": format!("{}:{}", host.ip, host.port)
        });

        match self.http_client.post(&url)
            .json(&payload)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let result: InvokeResult = resp.json().await
                    .map_err(|e| format!("Failed to parse response: {}", e))?;
                Ok(result)
            }
            Ok(resp) => {
                let status = resp.status();
                Err(format!("Request failed with status: {}", status))
            }
            Err(e) => {
                Err(format!("Request failed: {}", e))
            }
        }
    }

    /// Get pending callbacks
    pub async fn get_callbacks(&self) -> Vec<Value> {
        let registry = self.callback_registry.read().await;
        registry.values().cloned().collect()
    }

    /// Get list of available printers
    pub async fn get_printers(&self) -> Result<Vec<String>> {
        let host = self.bound_host.as_ref()
            .ok_or_else(|| "Not bound to any host".to_string())?;

        // For now, return a placeholder response
        // Real implementation would query the C-Lodop server
        tracing::warn!("get_printers: Returning placeholder printer list");
        Ok(vec![
            "Default Printer".to_string(),
            "Microsoft Print to PDF".to_string(),
        ])
    }

    /// Send test print command
    pub async fn test_print(&self, printer: Option<&str>) -> Result<()> {
        let host = self.bound_host.as_ref()
            .ok_or_else(|| "Not bound to any host".to_string())?;

        tracing::info!("Sending test print to printer: {:?}", printer);

        // Build test print command
        let url = format!("http://{}:{}/c_webskt/PRINT", host.ip, host.port);

        let payload = serde_json::json!({
            "printer": printer,
            "test": true
        });

        match self.http_client.post(&url)
            .json(&payload)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!("Test print sent successfully");
                Ok(())
            }
            Ok(resp) => {
                let status = resp.status();
                Err(format!("Test print failed with status: {}", status))
            }
            Err(e) => {
                Err(format!("Test print request failed: {}", e))
            }
        }
    }

    /// Check if bound to a host
    pub fn is_bound(&self) -> bool {
        self.bound_host.is_some()
    }

    /// Get current bound host
    pub fn get_bound_host(&self) -> Option<HostInfo> {
        self.bound_host.clone()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InvokeResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for PlaywrightBridge {
    fn default() -> Self {
        Self::new()
    }
}
