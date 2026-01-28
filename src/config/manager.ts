import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AppConfig, BoundHost } from './schema';
import { logger } from '../logger/logger';

const CONFIG_DIR = path.join(os.homedir(), '.lodop-proxy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * 配置管理器
 */
export class ConfigManager {
  private config: AppConfig = {};

  constructor() {
    this.ensureConfigDir();
    this.load();
  }

  private ensureConfigDir(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  /**
   * 加载配置
   */
  load(): void {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
        this.config = JSON.parse(content);
        logger.info('配置加载成功', { configFile: CONFIG_FILE });
      } else {
        this.config = {};
        logger.info('使用默认配置');
      }
    } catch (error) {
      logger.error('加载配置失败', { error, configFile: CONFIG_FILE });
      this.config = {};
    }
  }

  /**
   * 保存配置
   */
  private save(): void {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
      logger.debug('配置已保存', { configFile: CONFIG_FILE });
    } catch (error) {
      logger.error('保存配置失败', { error, configFile: CONFIG_FILE });
      throw error;
    }
  }

  /**
   * 获取绑定的主机
   */
  getBoundHost(): BoundHost | undefined {
    return this.config.boundHost;
  }

  /**
   * 绑定主机
   */
  bindHost(ip: string, port: number, scheme: 'http' | 'https' = 'http'): void {
    this.config.boundHost = {
      ip,
      port,
      scheme,
      boundAt: Date.now(),
    };
    this.save();
    logger.info('主机已绑定', { ip, port, scheme });
  }

  /**
   * 解绑主机
   */
  unbindHost(): void {
    const oldHost = this.config.boundHost;
    this.config.boundHost = undefined;
    this.save();
    logger.info('主机已解绑', { oldHost });
  }

  /**
   * 获取允许的 Origin 列表
   */
  getAllowedOrigins(): string[] {
    return this.config.allowedOrigins || [];
  }

  /**
   * 设置允许的 Origin 列表
   */
  setAllowedOrigins(origins: string[]): void {
    this.config.allowedOrigins = origins;
    this.save();
    logger.info('Origin 白名单已更新', { origins });
  }
}

// 单例
export const configManager = new ConfigManager();
