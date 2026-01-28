/**
 * 配置 Schema 定义
 */

export interface BoundHost {
  ip: string;
  port: number;
  scheme: 'http' | 'https';
  boundAt: number; // 绑定时间戳
}

export interface AppConfig {
  boundHost?: BoundHost;
  allowedOrigins?: string[];
}
