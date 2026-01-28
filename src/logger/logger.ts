import * as winston from 'winston';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import config from 'config';

const LOG_DIR = config.get<string>('logging.dir').replace('~', os.homedir());
const LOG_LEVEL = config.get<string>('logging.level');
const MAX_FILES = config.get<number>('logging.maxFiles');
const MAX_SIZE = config.get<string>('logging.maxSize');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Winston 日志配置
 */
export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'lodop-proxy' },
  transports: [
    // 错误日志文件
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: parseSize(MAX_SIZE),
      maxFiles: MAX_FILES,
    }),
    // 所有日志文件
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: parseSize(MAX_SIZE),
      maxFiles: MAX_FILES,
    }),
  ],
});

// 开发环境也输出到控制台
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
          return `${timestamp} [${level}]: ${message} ${metaStr}`;
        })
      ),
    })
  );
}

/**
 * 解析大小字符串（如 "10m" -> 字节数）
 */
function parseSize(sizeStr: string): number {
  const units: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };
  const match = sizeStr.toLowerCase().match(/^(\d+)([a-z]+)$/);
  if (!match) return 10 * 1024 * 1024; // 默认 10MB
  const [, value, unit] = match;
  return parseInt(value, 10) * (units[unit] || 1);
}
