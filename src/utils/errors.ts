/**
 * 错误码定义
 */
export enum ErrorCode {
  E001 = 'E001', // 未绑定主机
  E002 = 'E002', // 主机离线
  E003 = 'E003', // 端口不通
  E004 = 'E004', // Origin 被拒绝
  E005 = 'E005', // Headless 未启动
  E006 = 'E006', // 扫描超时
  E007 = 'E007', // WebSocket 连接失败
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const ErrorMessages: Record<ErrorCode, string> = {
  [ErrorCode.E001]: '未绑定主机，请先扫描并选择 Windows C-Lodop 主机',
  [ErrorCode.E002]: '绑定的主机离线或无法访问',
  [ErrorCode.E003]: '目标端口不通，请检查 Windows C-Lodop 服务是否运行',
  [ErrorCode.E004]: '请求来源被拒绝，请检查 Origin 白名单配置',
  [ErrorCode.E005]: 'Headless 浏览器未启动，请检查服务状态',
  [ErrorCode.E006]: '扫描超时，请检查网络连接',
  [ErrorCode.E007]: 'WebSocket 连接失败，请检查服务是否运行',
};

export function createError(code: ErrorCode, details?: any): AppError {
  return new AppError(code, ErrorMessages[code], details);
}
