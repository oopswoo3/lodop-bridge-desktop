use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl AppError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    pub fn no_host_bound() -> Self {
        Self::new("E001", "未绑定主机")
    }

    pub fn host_offline() -> Self {
        Self::new("E002", "主机离线")
    }

    pub fn port_unreachable() -> Self {
        Self::new("E003", "端口不通")
    }

    pub fn origin_rejected() -> Self {
        Self::new("E004", "Origin 被拒绝")
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        Self::new("INTERNAL", &err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
