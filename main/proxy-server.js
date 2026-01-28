const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const HeadlessBridge = require('./headless-bridge');
const storage = require('./storage');

/**
 * 自定义 WebSocket 客户端，可以容忍非标准的 MASK 位
 * 用于连接不符合 WebSocket 协议规范的服务器
 */
const EventEmitter = require('events');

class TolerantWebSocketClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.socket = null;
    this.readyState = WebSocket.CONNECTING;
    this.buffer = Buffer.alloc(0);
    this.frameBuffer = null;
    
    // WebSocket 常量
    this.OPCODE_TEXT = 0x1;
    this.OPCODE_BINARY = 0x2;
    this.OPCODE_CLOSE = 0x8;
    this.OPCODE_PING = 0x9;
    this.OPCODE_PONG = 0xA;
    
    this.CONNECTING = WebSocket.CONNECTING;
    this.OPEN = WebSocket.OPEN;
    this.CLOSING = WebSocket.CLOSING;
    this.CLOSED = WebSocket.CLOSED;
  }
  
  connect() {
    return new Promise((resolve, reject) => {
      try {
        const urlObj = new URL(this.url);
        const host = urlObj.hostname;
        const port = parseInt(urlObj.port) || (urlObj.protocol === 'wss:' ? 443 : 80);
        const path = urlObj.pathname + (urlObj.search || '');
        
        // 生成 WebSocket key
        const key = crypto.randomBytes(16).toString('base64');
        
        // 创建 TCP 连接（添加超时和错误处理）
        this.socket = net.createConnection({ host, port }, () => {
          // 发送 WebSocket 握手请求
          const handshake = `GET ${path} HTTP/1.1\r\n` +
            `Host: ${host}:${port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n` +
            `\r\n`;
          
          this.socket.write(handshake);
        });
        
        // 设置连接超时（10秒）
        this.socket.setTimeout(10000);
        this.socket.on('timeout', () => {
          this.socket.destroy();
          const error = new Error('Connection timeout');
          this.readyState = WebSocket.CLOSED;
          this.emit('error', error);
          if (!handshakeComplete) {
            reject(error);
          }
        });
        
        let handshakeComplete = false;
        
        this.socket.on('data', (data) => {
          if (!handshakeComplete) {
            // 处理握手响应
            this.buffer = Buffer.concat([this.buffer, data]);
            const response = this.buffer.toString();
            
            if (response.includes('\r\n\r\n')) {
              const headers = response.split('\r\n\r\n')[0];
              const bodyStart = response.indexOf('\r\n\r\n') + 4;
              
              if (headers.includes('101 Switching Protocols')) {
                handshakeComplete = true;
                this.readyState = WebSocket.OPEN;
                // 保留握手后的数据（如果有）
                this.buffer = this.buffer.slice(bodyStart);
                this.emit('open');
                resolve();
                
                // 如果有剩余数据，处理它
                if (this.buffer.length > 0) {
                  this.processFrames();
                }
              } else {
                reject(new Error(`WebSocket handshake failed: ${headers}`));
              }
            }
          } else {
            // 处理 WebSocket 帧
            this.buffer = Buffer.concat([this.buffer, data]);
            this.processFrames();
          }
        });
        
        this.socket.on('error', (error) => {
          this.readyState = WebSocket.CLOSED;
          this.emit('error', error);
          if (!handshakeComplete) {
            reject(error);
          }
        });
        
        this.socket.on('close', () => {
          this.readyState = WebSocket.CLOSED;
          this.emit('close', { code: 1006, reason: '' });
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  processFrames() {
    try {
      while (this.buffer.length >= 2) {
        const firstByte = this.buffer[0];
        const secondByte = this.buffer[1];
        
        const fin = (firstByte & 0x80) !== 0;
        const opcode = firstByte & 0x0F;
        const masked = (secondByte & 0x80) !== 0;
        let payloadLength = secondByte & 0x7F;
        
        let offset = 2;
        
        // 读取扩展长度
        if (payloadLength === 126) {
          if (this.buffer.length < 4) return; // 等待更多数据
          payloadLength = this.buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLength === 127) {
          if (this.buffer.length < 10) return; // 等待更多数据
          payloadLength = Number(this.buffer.readBigUInt64BE(2));
          offset = 10;
        }
        
        // 读取 mask key（如果存在，即使不应该存在也容忍 - 这是关键！）
        let maskKey = null;
        if (masked) {
          if (this.buffer.length < offset + 4) return; // 等待更多数据
          maskKey = this.buffer.slice(offset, offset + 4);
          offset += 4;
        }
        
        // 读取 payload
        if (this.buffer.length < offset + payloadLength) return; // 等待更多数据
        
        let payload = this.buffer.slice(offset, offset + payloadLength);
        
        // 🔑 关键：如果设置了 mask，即使不应该也进行解码（容忍非标准行为）
        // 这是 C-Lodop 不符合标准的地方，我们需要容忍它
        if (masked && maskKey) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i % 4];
          }
        }
        
        // 移除已处理的帧
        this.buffer = this.buffer.slice(offset + payloadLength);
        
        // 处理不同类型的帧
        if (opcode === this.OPCODE_TEXT || opcode === this.OPCODE_BINARY) {
          const message = opcode === this.OPCODE_TEXT ? payload.toString('utf8') : payload;
          const isBinary = opcode === this.OPCODE_BINARY;
          this.emit('message', { data: message, isBinary });
        } else if (opcode === this.OPCODE_CLOSE) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          const reason = payload.length > 2 ? payload.slice(2).toString('utf8') : '';
          this.readyState = WebSocket.CLOSING;
          this.close(code, reason);
        } else if (opcode === this.OPCODE_PING) {
          this.sendFrame(this.OPCODE_PONG, payload);
        }
        // 忽略其他 opcode（如 CONTINUATION, PONG 等）
      }
    } catch (error) {
      console.error(`[TolerantWebSocketClient] 处理帧时出错:`, error);
      this.emit('error', error);
      // 清空 buffer，避免重复错误
      this.buffer = Buffer.alloc(0);
    }
  }
  
  sendFrame(opcode, payload) {
    if (this.readyState !== WebSocket.OPEN || !this.socket) return;
    
    const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const payloadLength = payloadBuffer.length;
    
    let frame = Buffer.alloc(2);
    frame[0] = 0x80 | opcode; // FIN + opcode
    
    if (payloadLength < 126) {
      frame[1] = payloadLength;
    } else if (payloadLength < 65536) {
      frame = Buffer.alloc(4);
      frame[0] = 0x80 | opcode;
      frame[1] = 126;
      frame.writeUInt16BE(payloadLength, 2);
    } else {
      frame = Buffer.alloc(10);
      frame[0] = 0x80 | opcode;
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(payloadLength), 2);
    }
    
    // 客户端必须设置 MASK 位
    frame[1] |= 0x80;
    
    // 生成 mask key
    const maskKey = crypto.randomBytes(4);
    frame = Buffer.concat([frame, maskKey]);
    
    // 对 payload 进行 mask
    const maskedPayload = Buffer.from(payloadBuffer);
    for (let i = 0; i < maskedPayload.length; i++) {
      maskedPayload[i] ^= maskKey[i % 4];
    }
    
    frame = Buffer.concat([frame, maskedPayload]);
    this.socket.write(frame);
  }
  
  send(data) {
    // 如果是 Buffer，根据内容判断是文本还是二进制
    // 但为了完全原封不动，我们总是按文本处理（C-Lodop 使用文本消息）
    if (Buffer.isBuffer(data)) {
      // 直接使用 Buffer，按文本帧发送
      this.sendFrame(this.OPCODE_TEXT, data);
    } else if (typeof data === 'string') {
      this.sendFrame(this.OPCODE_TEXT, data);
    } else {
      this.sendFrame(this.OPCODE_BINARY, data);
    }
  }
  
  close(code = 1000, reason = '') {
    if (this.readyState === WebSocket.CLOSED || this.readyState === WebSocket.CLOSING) return;
    
    this.readyState = WebSocket.CLOSING;
    
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
    payload.writeUInt16BE(code, 0);
    if (reason) {
      payload.write(reason, 2, 'utf8');
    }
    
    this.sendFrame(this.OPCODE_CLOSE, payload);
    
    setTimeout(() => {
      if (this.socket) {
        this.socket.end();
        this.socket = null;
      }
      this.readyState = WebSocket.CLOSED;
    }, 1000);
  }
  
}

class ProxyServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.wss = null;
    this.wssFile = null;
    this.wssCWebskt = null;
    this.bridge = new HeadlessBridge();
    this.port = 8000;
    this.portAlt = 18000;
    this.clients = new Map();
  }

  // 初始化服务器
  async init() {
    // 初始化 bridge
    await this.bridge.init();

    // 恢复绑定的主机
    const boundHost = storage.getBoundHost();
    if (boundHost) {
      try {
        await this.bridge.bindHost(boundHost);
      } catch (error) {
        console.error('Failed to restore bound host:', error);
      }
    }

    // 中间件：CORS 和安全检查
    this.app.use((req, res, next) => {
      // 检查是否是 WebSocket 升级请求，如果是则跳过 CORS 检查（由 WebSocket 服务器处理）
      const isWebSocketUpgrade = req.headers.upgrade && 
                                  req.headers.upgrade.toLowerCase() === 'websocket' &&
                                  req.headers.connection && 
                                  req.headers.connection.toLowerCase().includes('upgrade');
      
      if (isWebSocketUpgrade) {
        console.log(`[CORS] 检测到 WebSocket 升级请求: ${req.path}，跳过 CORS 检查`);
        return next();
      }
      
      const remoteAddr = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
      const origin = req.headers.origin || req.headers.referer;

      // 只允许 localhost 访问
      if (remoteAddr && !remoteAddr.includes('127.0.0.1') && !remoteAddr.includes('::1') && !remoteAddr.includes('localhost')) {
        return res.status(403).json({ error: 'Forbidden: Only localhost access allowed' });
      }

      // 检查 Origin（允许 null 和 localhost）
      const settings = storage.getSettings();
      if (origin && origin !== 'null') {
        try {
          const allowed = settings.allowedOrigins || ['localhost', '127.0.0.1'];
          const originHost = new URL(origin).hostname;
          if (!allowed.some(allowedOrigin => originHost.includes(allowedOrigin))) {
            return res.status(403).json({ error: 'Forbidden: Origin not allowed' });
          }
        } catch (e) {
          // 如果 origin 不是有效的 URL，忽略检查
        }
      }

      next();
    });

    // 静态文件：CLodopfuncs.js - 从绑定的远程主机获取并替换IP
    this.app.get('/CLodopfuncs.js', async (req, res) => {
      // 检查是否是 WebSocket 升级请求，如果是则跳过（由 WebSocket 服务器处理）
      const isWebSocketUpgrade = req.headers.upgrade && 
                                  req.headers.upgrade.toLowerCase() === 'websocket' &&
                                  req.headers.connection && 
                                  req.headers.connection.toLowerCase().includes('upgrade');
      
      if (isWebSocketUpgrade) {
        console.log(`[GET /CLodopfuncs.js] 检测到 WebSocket 升级请求，跳过 Express 处理，让 WebSocket 服务器处理`);
        // 不发送响应，让 WebSocket 服务器处理升级请求
        // 通过不调用 res.end() 或 res.send()，请求会继续传递
        return;
      }
      
      const boundHost = storage.getBoundHost();
      if (!boundHost) {
        return res.status(503).json({ 
          error: 'No host bound', 
          message: '请先绑定一个 C-Lodop 主机' 
        });
      }

      try {
        const targetUrl = `http://${boundHost.ip}:${boundHost.port}/CLodopfuncs.js`;
        console.log(`[Proxy] 获取 CLodopfuncs.js: ${targetUrl}`);

        // 从远程主机获取文件
        const proxyReq = http.request(targetUrl, {
          method: 'GET',
          headers: {
            'connection': 'close',
            'accept-encoding': 'identity' // 禁用压缩，方便处理文本
          },
          timeout: 10000
        }, (proxyRes) => {
          // 设置响应头
          res.statusCode = proxyRes.statusCode || 200;
          res.setHeader('Content-Type', 'application/javascript');
          
          // 如果状态码不是200，直接转发响应
          if (proxyRes.statusCode && proxyRes.statusCode !== 200) {
            proxyRes.pipe(res);
            return;
          }
          
          // 收集响应数据
          let data = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (chunk) => {
            data += chunk;
          });
          
          proxyRes.on('end', () => {
            // 将绑定的IP替换为localhost（支持所有协议格式）
            let modifiedData = data;
            
            // 获取当前代理服务器的端口（从请求头或使用默认值）
            const proxyPort = req.headers.host ? 
              (req.headers.host.includes(':') ? req.headers.host.split(':')[1] : (this.port || 8000)) :
              (this.port || 8000);
            
            const escapedIp = boundHost.ip.replace(/\./g, '\\.');
            let totalReplaceCount = 0;
            
            // 替换所有协议格式中的 IP:端口
            // 匹配: http://IP:端口, https://IP:端口, ws://IP:端口, wss://IP:端口
            const protocolIpPortPattern = new RegExp(`(https?|wss?)://${escapedIp}:${boundHost.port}`, 'gi');
            const protocolMatches = modifiedData.match(protocolIpPortPattern);
            if (protocolMatches) {
              totalReplaceCount += protocolMatches.length;
              modifiedData = modifiedData.replace(protocolIpPortPattern, (match) => {
                const protocol = match.split('://')[0];
                return `${protocol}://localhost:${proxyPort}`;
              });
            }
            
            // 替换不带协议的 IP:端口（在字符串中）
            const ipPortPattern = new RegExp(`${escapedIp}:${boundHost.port}`, 'g');
            const ipPortMatches = modifiedData.match(ipPortPattern);
            if (ipPortMatches) {
              totalReplaceCount += ipPortMatches.length;
              modifiedData = modifiedData.replace(ipPortPattern, `localhost:${proxyPort}`);
            }
            
            // 替换单独的 IP 地址（用于 strHostURI 等，但要避免替换已经替换过的）
            // 使用单词边界确保只替换独立的 IP 地址
            const ipPattern = new RegExp(`\\b${escapedIp}\\b`, 'g');
            const ipMatches = modifiedData.match(ipPattern);
            if (ipMatches) {
              totalReplaceCount += ipMatches.length;
              modifiedData = modifiedData.replace(ipPattern, 'localhost');
            }
            
            console.log(`[Proxy] CLodopfuncs.js 已替换 IP: ${boundHost.ip}:${boundHost.port} -> localhost:${proxyPort}`);
            console.log(`[Proxy] 替换统计: 总共替换 ${totalReplaceCount} 处`);
            res.send(modifiedData);
          });
        });

        proxyReq.on('error', (error) => {
          console.error(`[Proxy] 获取 CLodopfuncs.js 错误:`, error);
          if (!res.headersSent) {
            res.status(502).json({ 
              error: 'Proxy error', 
              message: `无法从远程主机获取 CLodopfuncs.js: ${error.message}` 
            });
          }
        });

        proxyReq.on('timeout', () => {
          console.error(`[Proxy] 获取 CLodopfuncs.js 超时`);
          proxyReq.destroy();
          if (!res.headersSent) {
            res.status(504).json({ 
              error: 'Proxy timeout', 
              message: '获取 CLodopfuncs.js 超时' 
            });
          }
        });

        proxyReq.end();
      } catch (error) {
        console.error(`[Proxy] 处理 CLodopfuncs.js 错误:`, error);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'Proxy error', 
            message: error.message 
          });
        }
      }
    });

    // API: 获取状态
    this.app.get('/api/status', (req, res) => {
      const boundHost = storage.getBoundHost();
      this.bridge.checkStatus().then(status => {
        res.json({
          boundHost,
          status,
          lastUpdate: storage.getAll().lastUpdate
        });
      }).catch(error => {
        res.json({
          boundHost,
          status: { online: false, error: error.message },
          lastUpdate: storage.getAll().lastUpdate
        });
      });
    });

    // API: 绑定主机
    this.app.post('/api/bind', express.json(), async (req, res) => {
      const { ip, port } = req.body;
      if (!ip || !port) {
        return res.status(400).json({ error: 'IP and port required' });
      }

      try {
        await this.bridge.bindHost({ ip, port });
        storage.setBoundHost({ ip, port });
        res.json({ success: true, host: { ip, port } });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: 解绑
    this.app.post('/api/unbind', async (req, res) => {
      try {
        await this.bridge.unbind();
        storage.clearBoundHost();
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: 获取扫描结果（通过 IPC 从主进程获取）
    this.app.get('/api/hosts', (req, res) => {
      // 这个需要从主进程获取，暂时返回空数组
      res.json({ hosts: [] });
    });

    // API: 测试调用
    this.app.post('/api/test', express.json(), async (req, res) => {
      const { method, args } = req.body;
      const clientCallId = `test-${Date.now()}-${Math.random()}`;

      try {
        const result = await this.bridge.invoke(method || 'PRINT_INIT', args || ['测试'], clientCallId);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: 获取打印机列表
    this.app.get('/api/printers', async (req, res) => {
      try {
        const printers = await this.bridge.getPrinters();
        res.json({ printers });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: 测试打印
    this.app.post('/api/test-print', async (req, res) => {
      try {
        const { printer } = req.body || {};
        await this.bridge.testPrint(printer);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: 通过 WebSocket 测试打印（使用用户提供的消息格式）
    this.app.post('/api/test-print-websocket', async (req, res) => {
      try {
        const proxyPort = this.port || 8000;
        const result = await this.bridge.testPrintViaWebSocket(proxyPort);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // 代理所有其他请求到绑定的远程主机（直接转发，不做定制处理）
    this.app.use((req, res, next) => {
      // 检查是否是 WebSocket 升级请求，如果是则跳过 Express 处理
      const isWebSocketUpgrade = req.headers.upgrade && 
                                  req.headers.upgrade.toLowerCase() === 'websocket' &&
                                  req.headers.connection && 
                                  req.headers.connection.toLowerCase().includes('upgrade');
      
      if (isWebSocketUpgrade) {
        console.log(`[Proxy] 检测到 WebSocket 升级请求: ${req.path}，跳过 Express 处理`);
        return next();
      }
      
      // 跳过 API 路由和 WebSocket 路径（CLodopfuncs.js 已单独处理）
      if (req.path.startsWith('/api/') || req.path === '/ws' || req.path === '/CLodopfuncs.js' || req.path.startsWith('/c_webskt/')) {
        return next();
      }

      // 获取绑定的主机
      const boundHost = storage.getBoundHost();
      if (!boundHost) {
        return res.status(503).json({ 
          error: 'No host bound', 
          message: '请先绑定一个 C-Lodop 主机' 
        });
      }

      try {
        // 构建目标 URL（req.url 已经包含路径和查询参数）
        const targetUrl = `http://${boundHost.ip}:${boundHost.port}${req.url}`;
        
        console.log(`[Proxy] 转发请求: ${req.method} ${req.url} -> ${targetUrl}`);

        // 准备请求头 - 直接复制，只修改 host
        const proxyHeaders = {};
        Object.keys(req.headers).forEach(key => {
          const lowerKey = key.toLowerCase();
          // 跳过一些不应该转发的头
          if (lowerKey !== 'host' && lowerKey !== 'connection') {
            proxyHeaders[key] = req.headers[key];
          }
        });
        // 设置正确的 host
        proxyHeaders.host = `${boundHost.ip}:${boundHost.port}`;

        // 创建代理请求
        const proxyReq = http.request(targetUrl, {
          method: req.method,
          headers: proxyHeaders,
          timeout: 30000
        }, (proxyRes) => {
          // 复制响应头
          res.statusCode = proxyRes.statusCode || 200;
          Object.keys(proxyRes.headers).forEach(key => {
            const lowerKey = key.toLowerCase();
            // 跳过一些不应该转发的头
            if (lowerKey !== 'connection' && 
                lowerKey !== 'transfer-encoding') {
              const headerValue = proxyRes.headers[key];
              if (headerValue) {
                res.setHeader(key, Array.isArray(headerValue) ? headerValue[0] : headerValue);
              }
            }
          });

          // 转发响应体
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (error) => {
          console.error(`[Proxy] 代理请求错误:`, error);
          if (!res.headersSent) {
            res.status(502).json({ 
              error: 'Proxy error', 
              message: `无法连接到远程主机 ${boundHost.ip}:${boundHost.port}: ${error.message}` 
            });
          }
        });

        proxyReq.on('timeout', () => {
          console.error(`[Proxy] 代理请求超时`);
          proxyReq.destroy();
          if (!res.headersSent) {
            res.status(504).json({ 
              error: 'Proxy timeout', 
              message: '连接远程主机超时' 
            });
          }
        });

        // 直接转发请求体（包括 POST 数据）- 使用 pipe 确保流式传输
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
          // 直接 pipe 请求流到代理请求
          req.pipe(proxyReq);
        } else {
          proxyReq.end();
        }
      } catch (error) {
        console.error(`[Proxy] 代理处理错误:`, error);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'Proxy error', 
            message: error.message 
          });
        }
      }
    });

    // 创建 HTTP 服务器
    this.server = http.createServer(this.app);

    // WebSocket 服务器 - 用于 API 调用
    this.wss = new WebSocket.Server({ 
      noServer: true, // 不自动处理 upgrade，手动处理
      verifyClient: (info) => {
        const remoteAddr = info.req.socket.remoteAddress || 
                          info.req.headers['x-forwarded-for'] || 
                          info.req.connection?.remoteAddress ||
                          'unknown';
        const origin = info.origin || info.req.headers.origin || '';
        const host = info.req.headers.host || '';
        
        console.log(`[WebSocket] 验证客户端连接: remoteAddr=${remoteAddr}, origin=${origin}, host=${host}`);
        
        // 允许 localhost 和 127.0.0.1 的连接
        const isLocalhost = remoteAddr.includes('127.0.0.1') || 
                          remoteAddr.includes('::1') || 
                          remoteAddr.includes('localhost') ||
                          host.includes('localhost') ||
                          host.includes('127.0.0.1') ||
                          origin.includes('localhost') ||
                          origin.includes('127.0.0.1');
        
        if (!isLocalhost) {
          console.warn(`[WebSocket] 拒绝非本地连接: ${remoteAddr}`);
        } else {
          console.log(`[WebSocket] 允许本地连接: ${remoteAddr}`);
        }
        
        return isLocalhost;
      }
    });
    
    console.log('[WebSocket] WebSocket 服务器已初始化，路径: /ws');

    // WebSocket 服务器 - 用于发送 CLodopfuncs.js 文件
    // 使用 noServer 选项，然后手动处理 upgrade 事件
    this.wssFile = new WebSocket.Server({ 
      noServer: true, // 不自动处理 upgrade，手动处理
      perMessageDeflate: false, // 禁用压缩，避免问题
      verifyClient: (info) => {
        const remoteAddr = info.req.socket.remoteAddress || 
                          info.req.headers['x-forwarded-for'] || 
                          info.req.connection?.remoteAddress ||
                          'unknown';
        const origin = info.origin || info.req.headers.origin || '';
        const host = info.req.headers.host || '';
        const url = info.req.url || '';
        
        console.log(`[WebSocket File] 验证客户端连接: remoteAddr=${remoteAddr}, origin=${origin}, host=${host}, url=${url}`);
        
        // 允许 localhost 和 127.0.0.1 的连接（放宽限制，允许所有本地连接）
        const isLocalhost = remoteAddr.includes('127.0.0.1') || 
                          remoteAddr.includes('::1') || 
                          remoteAddr.includes('localhost') ||
                          remoteAddr === 'unknown' || // 如果无法获取地址，也允许（可能是本地连接）
                          host.includes('localhost') ||
                          host.includes('127.0.0.1') ||
                          origin === 'null' || // 允许 null origin
                          origin.includes('localhost') ||
                          origin.includes('127.0.0.1') ||
                          !origin; // 如果没有 origin，也允许
        
        if (!isLocalhost) {
          console.warn(`[WebSocket File] 拒绝非本地连接: remoteAddr=${remoteAddr}, origin=${origin}`);
        } else {
          console.log(`[WebSocket File] 允许连接: remoteAddr=${remoteAddr}`);
        }
        
        return isLocalhost;
      }
    });
    
    // 添加错误处理
    this.wssFile.on('error', (error) => {
      console.error(`[WebSocket File] 服务器错误:`, error);
    });
    
    this.wssFile.on('headers', (headers, req) => {
      console.log(`[WebSocket File] WebSocket 升级请求头:`, req.url);
    });

    // 处理 CLodopfuncs.js 文件请求 - 从绑定的远程主机获取并替换IP
    this.wssFile.on('connection', async (ws, req) => {
      const remoteAddr = req.socket.remoteAddress || 'unknown';
      const url = req.url || '';
      const startTime = Date.now();
      console.log(`[WebSocket File] ===== 新客户端连接 ===== ${remoteAddr}, url=${url}, readyState=${ws.readyState}`);
      
      // 监听客户端消息（虽然这个连接主要用于发送文件，但也要处理可能的客户端消息）
      ws.on('message', (message) => {
        console.log(`[WebSocket File] 收到客户端消息 (${message.length} 字节):`, message.toString().substring(0, 100));
      });
      
      const boundHost = storage.getBoundHost();
      if (!boundHost) {
        console.error(`[WebSocket File] 没有绑定的主机`);
        ws.close(1008, 'No host bound');
        return;
      }

      // 发送文件的辅助函数
      const sendFile = (modifiedData) => {
        const elapsed = Date.now() - startTime;
        console.log(`[WebSocket File] 准备发送文件，已耗时: ${elapsed}ms`);
        
        // 确保 WebSocket 已打开
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(modifiedData);
            const sendTime = Date.now() - startTime;
            console.log(`[WebSocket File] ✅ 已发送 CLodopfuncs.js 文件 (${modifiedData.length} 字符)，总耗时: ${sendTime}ms`);
            console.log(`[WebSocket File] 注意: 此连接仅用于传输文件，文件传输完成后会关闭。`);
            const proxyPort = req.headers.host ? 
              (req.headers.host.includes(':') ? req.headers.host.split(':')[1] : (this.port || 8000)) :
              (this.port || 8000);
            console.log(`[WebSocket File] 实际的打印通信请查看 ws://localhost:${proxyPort}/c_webskt/ 连接`);
          } catch (sendError) {
            console.error(`[WebSocket File] 发送文件错误:`, sendError);
            ws.close(1011, `Send error: ${sendError.message}`);
          }
        } else {
          console.warn(`[WebSocket File] WebSocket 未打开，等待打开。当前状态: ${ws.readyState}`);
          // 如果还没打开，等待打开后再发送
          const checkAndSend = () => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(modifiedData);
                const sendTime = Date.now() - startTime;
                console.log(`[WebSocket File] ✅ WebSocket 打开后已发送文件 (${modifiedData.length} 字符)，总耗时: ${sendTime}ms`);
              } catch (sendError) {
                console.error(`[WebSocket File] 发送文件错误:`, sendError);
              }
            } else if (ws.readyState === WebSocket.CONNECTING) {
              // 还在连接中，继续等待
              setTimeout(checkAndSend, 10);
            } else {
              console.error(`[WebSocket File] WebSocket 状态异常，无法发送。状态: ${ws.readyState}`);
            }
          };
          checkAndSend();
        }
      };

      try {
        // 从远程主机获取 CLodopfuncs.js
        const targetUrl = `http://${boundHost.ip}:${boundHost.port}/CLodopfuncs.js`;
        console.log(`[WebSocket File] 开始获取 CLodopfuncs.js: ${targetUrl}`);

        const proxyReq = http.request(targetUrl, {
          method: 'GET',
          headers: {
            'connection': 'close',
            'accept-encoding': 'identity' // 禁用压缩，方便处理文本
          },
          timeout: 5000 // 减少超时时间，确保快速响应
        }, (proxyRes) => {
          const responseTime = Date.now() - startTime;
          console.log(`[WebSocket File] 收到远程主机响应，耗时: ${responseTime}ms, 状态码: ${proxyRes.statusCode}`);
          
          if (proxyRes.statusCode && proxyRes.statusCode !== 200) {
            console.error(`[WebSocket File] 远程主机返回错误状态码: ${proxyRes.statusCode}`);
            ws.close(1008, `Remote server error: ${proxyRes.statusCode}`);
            return;
          }

          // 收集响应数据
          let data = '';
          let chunkCount = 0;
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (chunk) => {
            data += chunk;
            chunkCount++;
            if (chunkCount % 10 === 0) {
              console.log(`[WebSocket File] 正在接收数据... 已接收 ${data.length} 字符`);
            }
          });

          proxyRes.on('end', () => {
            const receiveTime = Date.now() - startTime;
            console.log(`[WebSocket File] 数据接收完成，总共 ${data.length} 字符，耗时: ${receiveTime}ms`);
            
            if (!data || data.length === 0) {
              console.error(`[WebSocket File] 接收到的数据为空！`);
              ws.close(1008, 'Empty response from remote server');
              return;
            }
            
            // 将绑定的IP替换为localhost（支持所有协议格式）
            let modifiedData = data;
            
            // 获取当前代理服务器的端口
            const proxyPort = req.headers.host ? 
              (req.headers.host.includes(':') ? req.headers.host.split(':')[1] : (this.port || 8000)) :
              (this.port || 8000);
            
            const escapedIp = boundHost.ip.replace(/\./g, '\\.');
            let totalReplaceCount = 0;
            
            // 替换所有协议格式中的 IP:端口
            // 匹配: http://IP:端口, https://IP:端口, ws://IP:端口, wss://IP:端口
            const protocolIpPortPattern = new RegExp(`(https?|wss?)://${escapedIp}:${boundHost.port}`, 'gi');
            const protocolMatches = modifiedData.match(protocolIpPortPattern);
            if (protocolMatches) {
              totalReplaceCount += protocolMatches.length;
              modifiedData = modifiedData.replace(protocolIpPortPattern, (match) => {
                const protocol = match.split('://')[0];
                return `${protocol}://localhost:${proxyPort}`;
              });
            }
            
            // 替换不带协议的 IP:端口（在字符串中）
            const ipPortPattern = new RegExp(`${escapedIp}:${boundHost.port}`, 'g');
            const ipPortMatches = modifiedData.match(ipPortPattern);
            if (ipPortMatches) {
              totalReplaceCount += ipPortMatches.length;
              modifiedData = modifiedData.replace(ipPortPattern, `localhost:${proxyPort}`);
            }
            
            // 替换单独的 IP 地址（用于 strHostURI 等，但要避免替换已经替换过的）
            // 使用单词边界确保只替换独立的 IP 地址
            const ipPattern = new RegExp(`\\b${escapedIp}\\b`, 'g');
            const ipMatches = modifiedData.match(ipPattern);
            if (ipMatches) {
              totalReplaceCount += ipMatches.length;
              modifiedData = modifiedData.replace(ipPattern, 'localhost');
            }
            
            console.log(`[WebSocket File] IP 替换完成: 总共替换 ${totalReplaceCount} 处`);
            console.log(`[WebSocket File] 准备发送 CLodopfuncs.js (${modifiedData.length} 字符), 已替换 IP: ${boundHost.ip}:${boundHost.port} -> localhost:${proxyPort}`);
            
            // 发送文件
            sendFile(modifiedData);
          });
        });

        proxyReq.on('error', (error) => {
          const errorTime = Date.now() - startTime;
          console.error(`[WebSocket File] 获取 CLodopfuncs.js 错误 (耗时: ${errorTime}ms):`, error);
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1011, `Failed to fetch: ${error.message}`);
          }
        });

        proxyReq.on('timeout', () => {
          const timeoutTime = Date.now() - startTime;
          console.error(`[WebSocket File] 获取 CLodopfuncs.js 超时 (耗时: ${timeoutTime}ms)`);
          proxyReq.destroy();
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1008, 'Timeout');
          }
        });

        proxyReq.end();
      } catch (error) {
        const errorTime = Date.now() - startTime;
        console.error(`[WebSocket File] 处理错误 (耗时: ${errorTime}ms):`, error);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1011, `Internal error: ${error.message}`);
        }
      }

      ws.on('close', (code, reason) => {
        const closeTime = Date.now() - startTime;
        console.log(`[WebSocket File] 客户端断开: ${remoteAddr}, code=${code}, reason=${reason || 'no reason'}, 连接持续时间: ${closeTime}ms`);
        console.log(`[WebSocket File] 这是正常的，文件传输完成后连接会自动关闭`);
      });

      ws.on('error', (error) => {
        const errorTime = Date.now() - startTime;
        console.error(`[WebSocket File] 客户端错误 (耗时: ${errorTime}ms): ${remoteAddr}`, error);
      });
    });
    
    console.log('[WebSocket] WebSocket 文件服务器已初始化，路径: /CLodopfuncs.js');

    // WebSocket 服务器 - 用于 C-Lodop 的 c_webskt 路径
    this.wssCWebskt = new WebSocket.Server({ 
      noServer: true, // 不自动处理 upgrade，手动处理
      perMessageDeflate: false, // 禁用压缩，避免协议兼容性问题
      maxPayload: 100 * 1024 * 1024, // 100MB 最大负载
      verifyClient: (info) => {
        const remoteAddr = info.req.socket.remoteAddress || 
                          info.req.headers['x-forwarded-for'] || 
                          info.req.connection?.remoteAddress ||
                          'unknown';
        const origin = info.origin || info.req.headers.origin || '';
        const host = info.req.headers.host || '';
        
        const isLocalhost = remoteAddr.includes('127.0.0.1') || 
                          remoteAddr.includes('::1') || 
                          remoteAddr.includes('localhost') ||
                          remoteAddr === 'unknown' ||
                          host.includes('localhost') ||
                          host.includes('127.0.0.1') ||
                          origin === 'null' ||
                          origin.includes('localhost') ||
                          origin.includes('127.0.0.1') ||
                          !origin;
        
        return isLocalhost;
      }
    });
    

    this.wssCWebskt.on('connection', (ws, req) => {
      const boundHost = storage.getBoundHost();
      if (!boundHost) {
        ws.close(1008, 'No host bound');
        return;
      }

      const remoteWsUrl = `ws://${boundHost.ip}:${boundHost.port}/c_webskt/`;
      
      // 标记远程连接是否已建立
      let remoteWsReady = false;
      const pendingMessages = [];
      let remoteWs = null;
      let useTolerantClient = false;
      
      const forceTolerant = process.env.FORCE_TOLERANT_WS === '1';
      if (forceTolerant) {
        useTolerantClient = true;
      }
      
      // 尝试使用标准 WebSocket 连接
      const connectRemote = () => {
        if (useTolerantClient) {
          remoteWs = new TolerantWebSocketClient(remoteWsUrl);
          
          remoteWs.on('open', () => {
            remoteWsReady = true;
            while (pendingMessages.length > 0) {
              const { message } = pendingMessages.shift();
              // 完全原封不动：直接传递原始 Buffer
              remoteWs.send(message);
            }
          });
          
          remoteWs.on('error', (err) => {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(1011, `Remote connection failed: ${err.message || 'Unknown error'}`);
            }
          });
          
          remoteWs.on('close', (event) => {
            handleRemoteClose(event.code || 1006, event.reason || '');
          });
          
          remoteWs.on('message', (event) => {
            const data = event.data || event;
            const isBinary = event.isBinary !== undefined ? event.isBinary : false;
            handleRemoteMessage(data, isBinary);
          });
          
          remoteWs.connect().catch((err) => {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(1011, `Remote connection failed: ${err.message}`);
            }
          });
        } else {
          // 使用标准 WebSocket 连接
          remoteWs = new WebSocket(remoteWsUrl, {
            perMessageDeflate: false,
            maxPayload: 100 * 1024 * 1024,
          });
          
          remoteWs.on('open', () => {
            remoteWsReady = true;
            while (pendingMessages.length > 0) {
              const { message, isBinary } = pendingMessages.shift();
              remoteWs.send(message, { binary: isBinary });
            }
          });
          
          remoteWs.on('error', (error) => {
            const errorCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
            const errorMessage = error && typeof error === 'object' && 'message' in error ? error.message : String(error);
            
            if (errorCode === 'WS_ERR_UNEXPECTED_MASK' || 
                errorCode === 'WS_ERR_INVALID_OPCODE' ||
                (errorMessage && (errorMessage.includes('MASK') || errorMessage.includes('mask')))) {
              if (!useTolerantClient) {
                try {
                  remoteWs.removeAllListeners();
                  if (remoteWs.terminate) {
                    remoteWs.terminate();
                  } else if (remoteWs.close) {
                    remoteWs.close();
                  }
                } catch (e) {}
                
                useTolerantClient = true;
                remoteWsReady = false;
                remoteWs = null;
                setTimeout(() => {
                  connectRemote();
                }, 100);
                return;
              }
            }
            
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(1011, `Remote connection failed: ${errorMessage || 'Unknown error'}`);
            }
          });
          
          remoteWs.on('close', handleRemoteClose);
          remoteWs.on('message', handleRemoteMessage);
        }
      };
      
      const handleRemoteMessage = (message, isBinary) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message, { binary: isBinary });
        }
      };
      
      const handleRemoteClose = (code, reason) => {
        remoteWsReady = false;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          // 验证 code 是否为有效的数字
          // WebSocket 关闭代码：1000-1015 是标准代码，3000-4999 是自定义代码
          const validCode = (typeof code === 'number' && 
                            ((code >= 1000 && code <= 1015) || (code >= 3000 && code <= 4999)))
                           ? code 
                           : 1000; // 默认使用 1000 (正常关闭)
          ws.close(validCode, reason);
        }
      };
      
      connectRemote();
      
      
      ws.on('message', (message, isBinary) => {
        if (remoteWsReady && remoteWs) {
          if (useTolerantClient) {
            // 完全原封不动：直接传递原始 Buffer，不做任何转换
            remoteWs.send(message);
          } else if (remoteWs.readyState === WebSocket.OPEN) {
            remoteWs.send(message, { binary: isBinary });
          }
        } else {
          pendingMessages.push({ message, isBinary });
        }
      });
      
      
      ws.on('close', () => {
        if (remoteWs) {
          if (useTolerantClient) {
            try {
              remoteWs.close();
            } catch (e) {}
          } else if (remoteWs.readyState === WebSocket.OPEN || remoteWs.readyState === WebSocket.CONNECTING) {
            remoteWs.close();
          }
        }
        remoteWsReady = false;
        pendingMessages.length = 0;
      });
      
      ws.on('error', () => {
        if (remoteWs && (remoteWs.readyState === WebSocket.OPEN || remoteWs.readyState === WebSocket.CONNECTING)) {
          remoteWs.close();
        }
        remoteWsReady = false;
      });
    });
    
    console.log('[WebSocket] WebSocket c_webskt 服务器已初始化，路径: /c_webskt/');

    // 在所有 WebSocket 服务器创建后，手动处理 upgrade 事件
    this.server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
      console.log(`[Server] 收到 upgrade 请求: ${pathname}`);
      
      // 检查是否是 WebSocket 升级请求
      const isWebSocket = request.headers.upgrade && 
                          request.headers.upgrade.toLowerCase() === 'websocket';
      
      if (!isWebSocket) {
        console.log(`[Server] 不是 WebSocket 升级请求，销毁连接`);
        socket.destroy();
        return;
      }

      // 根据路径分发到不同的 WebSocket 服务器
      if (pathname === '/CLodopfuncs.js') {
        console.log(`[Server] 将 upgrade 请求传递给 wssFile: ${pathname}`);
        this.wssFile.handleUpgrade(request, socket, head, (ws) => {
          this.wssFile.emit('connection', ws, request);
        });
      } else if (pathname.startsWith('/c_webskt')) {
        console.log(`[Server] 将 upgrade 请求传递给 wssCWebskt: ${pathname}`);
        this.wssCWebskt.handleUpgrade(request, socket, head, (ws) => {
          this.wssCWebskt.emit('connection', ws, request);
        });
      } else if (pathname === '/ws') {
        console.log(`[Server] 将 upgrade 请求传递给 wss: ${pathname}`);
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      } else {
        console.log(`[Server] 未知的 WebSocket 路径: ${pathname}，销毁连接`);
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws, req) => {
      const clientId = `client-${Date.now()}-${Math.random()}`;
      const remoteAddr = req.socket.remoteAddress || 'unknown';
      console.log(`[WebSocket] 新客户端连接: ${clientId} from ${remoteAddr}`);
      this.clients.set(clientId, ws);

      ws.on('message', async (message) => {
        let data = null;
        try {
          data = JSON.parse(message.toString());
          console.log(`[ProxyServer] 收到 WebSocket 消息:`, data);
          
          if (data.type === 'invoke') {
            const { method, args, clientCallId } = data;
            console.log(`[ProxyServer] 调用方法: ${method}`, args);
            const result = await this.bridge.invoke(method, args, clientCallId);
            console.log(`[ProxyServer] 方法 ${method} 返回:`, result);
            ws.send(JSON.stringify(result));
          } else {
            console.warn(`[ProxyServer] 未知的消息类型: ${data?.type}`);
          }
        } catch (error) {
          console.error(`[ProxyServer] WebSocket 消息处理错误:`, error);
          ws.send(JSON.stringify({
            type: 'error',
            clientCallId: data?.clientCallId || null,
            error: error.message
          }));
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`[WebSocket] 客户端断开: ${clientId}, code=${code}, reason=${reason}`);
        this.clients.delete(clientId);
      });

      ws.on('error', (error) => {
        console.error(`[WebSocket] 客户端错误: ${clientId}`, error);
        this.clients.delete(clientId);
      });
    });

    // 启动服务器（尝试两个端口）
    return this.start();
  }

  // 启动服务器
  async start() {
    return new Promise((resolve, reject) => {
      const tryPort = (port) => {
        this.server.listen(port, '127.0.0.1', () => {
          this.port = port;
          console.log(`[ProxyServer] HTTP 服务器已启动: http://127.0.0.1:${port}`);
          console.log(`[ProxyServer] WebSocket 服务器已启动: ws://127.0.0.1:${port}/ws`);
          console.log(`[ProxyServer] WebSocket c_webskt 服务器已启动: ws://127.0.0.1:${port}/c_webskt/`);
          resolve(port);
        });

        this.server.on('error', (error) => {
          if (error.code === 'EADDRINUSE') {
            if (port === this.port && this.portAlt) {
              console.log(`Port ${port} in use, trying ${this.portAlt}...`);
              tryPort(this.portAlt);
            } else {
              reject(new Error(`Both ports ${this.port} and ${this.portAlt} are in use`));
            }
          } else {
            reject(error);
          }
        });
      };

      tryPort(this.port);
    });
  }

  // 停止服务器
  async stop() {
    return new Promise((resolve) => {
      // 关闭所有 WebSocket 连接
      this.clients.forEach(ws => {
        ws.close();
      });
      this.clients.clear();

      // 关闭 bridge
      this.bridge.close().catch(() => {});

      // 关闭服务器
      if (this.server) {
        this.server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // 获取端口
  getPort() {
    return this.port;
  }

  // 设置扫描结果（从主进程调用）
  setScanResults(hosts) {
    // 可以通过 WebSocket 广播给客户端
    const message = JSON.stringify({
      type: 'scan-results',
      hosts
    });
    this.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
}

module.exports = ProxyServer;
