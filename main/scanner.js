const os = require('os');
const http = require('http');
const { networkInterfaces } = require('os');

class NetworkScanner {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 64;
    this.timeout = options.timeout || 800;
    this.ports = options.ports || [8000, 18000];
    this.onProgress = options.onProgress || (() => {});
    this.onFound = options.onFound || (() => {});
    this.isScanning = false;
    this.scanQueue = [];
    this.activeScans = 0;
    this.foundHosts = new Map();
  }

  // 获取本机网卡 IPv4 和子网掩码，计算 CIDR
  getLocalNetworks() {
    const networks = [];
    const interfaces = networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      const ifaceList = interfaces[name];
      if (!ifaceList) continue;
      for (const iface of ifaceList) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const ip = iface.address;
          const netmask = iface.netmask;
          const cidr = this.netmaskToCIDR(netmask);
          if (cidr) {
            const baseIP = this.getNetworkBase(ip, netmask);
            networks.push({
              ip,
              netmask,
              cidr: `${baseIP}/${cidr}`, // 使用网络基址而不是本机 IP
              baseIP: baseIP
            });
            console.log(`[Scanner] 发现网卡: ${name}, IP: ${ip}, 子网掩码: ${netmask}, 网络基址: ${baseIP}, CIDR: ${baseIP}/${cidr}`);
          }
        }
      }
    }

    // 如果没有找到，使用常见的私有网段
    if (networks.length === 0) {
      console.log('[Scanner] 未找到网卡，使用默认网段');
      return [
        { baseIP: '192.168.0.0', cidr: '192.168.0.0/24', ip: '192.168.0.1' },
        { baseIP: '192.168.1.0', cidr: '192.168.1.0/24', ip: '192.168.1.1' },
        { baseIP: '10.0.0.0', cidr: '10.0.0.0/24', ip: '10.0.0.1' },
        { baseIP: '172.16.0.0', cidr: '172.16.0.0/24', ip: '172.16.0.1' }
      ];
    }

    return networks;
  }

  // 将子网掩码转换为 CIDR 前缀长度
  netmaskToCIDR(netmask) {
    const parts = netmask.split('.').map(Number);
    let cidr = 0;
    for (const part of parts) {
      let mask = part;
      while (mask) {
        if (mask & 1) cidr++;
        mask = mask >>> 1;
      }
    }
    return cidr;
  }

  // 获取网络基址
  getNetworkBase(ip, netmask) {
    const ipParts = ip.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);
    const baseParts = ipParts.map((part, i) => part & maskParts[i]);
    return baseParts.join('.');
  }

  // 生成 IP 地址列表
  generateIPs(network) {
    const ips = [];
    // 使用 baseIP 而不是从 cidr 中提取的 IP（cidr 中的 IP 是本机 IP，不是网络基址）
    const baseIP = network.baseIP || network.cidr.split('/')[0];
    const [_, prefix] = network.cidr.split('/');
    const prefixLen = parseInt(prefix, 10);
    const hostBits = 32 - prefixLen;
    
    const baseParts = baseIP.split('.').map(Number);
    const baseNum = (baseParts[0] << 24) + (baseParts[1] << 16) + (baseParts[2] << 8) + baseParts[3];
    
    // 计算子网的实际范围
    const totalHosts = Math.pow(2, hostBits);
    const maxHosts = totalHosts - 2; // 排除网络地址和广播地址
    
    // 根据子网大小决定扫描策略
    if (prefixLen >= 24) {
      // /24 及更小的子网：扫描所有主机
      for (let i = 1; i <= maxHosts; i++) {
        const ipNum = baseNum + i;
        const ip = [
          (ipNum >>> 24) & 0xff,
          (ipNum >>> 16) & 0xff,
          (ipNum >>> 8) & 0xff,
          ipNum & 0xff
        ].join('.');
        ips.push(ip);
      }
      console.log(`[Scanner] 扫描网段 ${network.cidr}，生成 ${ips.length} 个 IP（从 ${ips[0]} 到 ${ips[ips.length - 1]}）`);
    } else if (prefixLen >= 22) {
      // /22 和 /23：扫描整个子网（数量可接受：/23=512, /22=1024）
      for (let i = 1; i <= maxHosts; i++) {
        const ipNum = baseNum + i;
        const ip = [
          (ipNum >>> 24) & 0xff,
          (ipNum >>> 16) & 0xff,
          (ipNum >>> 8) & 0xff,
          ipNum & 0xff
        ].join('.');
        ips.push(ip);
      }
      console.log(`[Scanner] 扫描网段 ${network.cidr}，生成 ${ips.length} 个 IP（从 ${ips[0]} 到 ${ips[ips.length - 1]}）`);
    } else {
      // /21 及更大的子网：只扫描本机所在的 /24 子网（避免扫描过多 IP）
      const localIP = network.ip;
      const localParts = localIP.split('.').map(Number);
      const local24Base = `${localParts[0]}.${localParts[1]}.${localParts[2]}.0`;
      const local24BaseParts = local24Base.split('.').map(Number);
      const local24BaseNum = (local24BaseParts[0] << 24) + (local24BaseParts[1] << 16) + (local24BaseParts[2] << 8) + local24BaseParts[3];
      
      // 扫描本机所在的 /24 子网
      for (let i = 1; i <= 254; i++) {
        const ipNum = local24BaseNum + i;
        const ip = [
          (ipNum >>> 24) & 0xff,
          (ipNum >>> 16) & 0xff,
          (ipNum >>> 8) & 0xff,
          ipNum & 0xff
        ].join('.');
        ips.push(ip);
      }
      console.log(`[Scanner] 大子网 ${network.cidr}，基于本机 IP ${localIP} 扫描 /24 子网 ${local24Base}/24`);
    }

    return ips;
  }

  // 探测单个 IP 的端口
  async probeHost(ip) {
    const results = [];
    let hostInfo = null;
    
    for (const port of this.ports) {
      try {
        const result = await this.probePort(ip, port);
        if (result.success) {
          results.push({
            port,
            rtt: result.rtt,
            success: true
          });
          // 保存第一个成功的主机信息
          if (result.hostInfo && !hostInfo) {
            hostInfo = result.hostInfo;
          }
        }
      } catch (err) {
        // 忽略错误，继续下一个端口
      }
    }

    if (results.length > 0) {
      const host = {
        ip,
        ports: results.map(r => r.port),
        rtt: Math.min(...results.map(r => r.rtt)),
        status: 'success',
        timestamp: Date.now()
      };
      
      // 添加主机信息
      if (hostInfo) {
        host.hostname = hostInfo.hostname;
        host.os = hostInfo.os;
        host.version = hostInfo.version;
      }
      
      // 如果没有从 c_sysmessage 获取到主机名，尝试通过 DNS 反向查询
      if (!host.hostname) {
        try {
          const dns = require('dns');
          const { promisify } = require('util');
          const reverse = promisify(dns.reverse);
          const hostnames = await reverse(ip).catch(() => []);
          if (hostnames && hostnames.length > 0) {
            host.hostname = hostnames[0];
          }
        } catch (e) {
          // DNS 查询失败，忽略
        }
      }
      
      return host;
    }

    return null;
  }

  // 探测单个端口
  probePort(ip, port) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let resolved = false;
      let hostInfo = null;

      // 优先探测 c_sysmessage
      const req = http.get(`http://${ip}:${port}/c_sysmessage`, {
        timeout: this.timeout
      }, (res) => {
        if (resolved) return;
        const rtt = Date.now() - startTime;
        
        // 尝试读取系统信息
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        
        res.on('end', () => {
          // 解析系统信息（c_sysmessage 返回的是 JavaScript 代码）
          try {
            // 尝试多种方式提取主机名和系统信息
            // 匹配模式：hostname = "xxx" 或 hostname: "xxx" 或 var hostname = "xxx"
            const hostnamePatterns = [
              /(?:var\s+)?hostname\s*[:=]\s*['"]([^'"]+)['"]/i,
              /(?:var\s+)?HOSTNAME\s*[:=]\s*['"]([^'"]+)['"]/i,
              /计算机名\s*[:=]\s*['"]([^'"]+)['"]/i,
              /计算机名称\s*[:=]\s*['"]([^'"]+)['"]/i
            ];
            
            // 匹配操作系统信息
            const osPatterns = [
              /(?:var\s+)?OS\s*[:=]\s*['"]([^'"]+)['"]/i,
              /(?:var\s+)?os\s*[:=]\s*['"]([^'"]+)['"]/i,
              /操作系统\s*[:=]\s*['"]([^'"]+)['"]/i,
              /系统\s*[:=]\s*['"]([^'"]+)['"]/i,
              /Windows\s+[^'"]+/i,
              /Win\d+/i
            ];
            
            // 匹配版本信息
            const versionPatterns = [
              /(?:var\s+)?version\s*[:=]\s*['"]([^'"]+)['"]/i,
              /(?:var\s+)?VERSION\s*[:=]\s*['"]([^'"]+)['"]/i,
              /版本\s*[:=]\s*['"]([^'"]+)['"]/i,
              /CLodop[^'"]*['"]([^'"]+)['"]/i
            ];
            
            // 验证版本号格式的函数（过滤掉明显不是版本号的内容）
            const isValidVersion = (str) => {
              if (!str || str.length > 50) return false; // 版本号不应该太长
              // 过滤掉 URL、JavaScript 代码等
              if (str.startsWith('http://') || str.startsWith('https://')) return false;
              if (str.startsWith('/') && str.includes('?')) return false; // URL 路径
              if (str.startsWith('javascript:')) return false;
              if (str.includes('location.') || str.includes('reload')) return false;
              if (str.includes('://')) return false;
              // 版本号通常包含数字和点，或者类似 "6.5.8.0" 的格式
              // 允许字母数字、点、连字符的组合，但必须包含至少一个数字
              if (!/\d/.test(str)) return false; // 必须包含至少一个数字
              return /^[a-zA-Z0-9.\-_\s]+$/.test(str) && str.length > 0;
            };
            
            let hostname = null;
            let os = null;
            let version = null;
            
            // 提取主机名
            for (const pattern of hostnamePatterns) {
              const match = data.match(pattern);
              if (match && match[1]) {
                hostname = match[1].trim();
                break;
              }
            }
            
            // 提取操作系统
            for (const pattern of osPatterns) {
              const match = data.match(pattern);
              if (match && match[1]) {
                os = match[1].trim();
                break;
              } else if (pattern.test(data) && !match) {
                // 对于没有引号的模式（如 Windows 10）
                const fullMatch = data.match(pattern);
                if (fullMatch) {
                  os = fullMatch[0].trim();
                  break;
                }
              }
            }
            
            // 提取版本（添加验证）
            for (const pattern of versionPatterns) {
              const match = data.match(pattern);
              if (match && match[1]) {
                const candidate = match[1].trim();
                // 验证提取的内容是否是有效的版本号
                if (isValidVersion(candidate)) {
                  version = candidate;
                  break;
                }
              }
            }
            
            if (hostname || os || version) {
              hostInfo = {
                hostname: hostname,
                os: os,
                version: version
              };
            }
          } catch (e) {
            // 解析失败，忽略
            console.log(`[Scanner] 解析系统信息失败: ${e.message}`);
          }
        });
        
        // 二次确认 CLodopfuncs.js
        const confirmReq = http.get(`http://${ip}:${port}/CLodopfuncs.js`, {
          timeout: this.timeout
        }, (confirmRes) => {
          if (resolved) return;
          resolved = true;
          req.destroy();
          resolve({
            success: true,
            rtt,
            port,
            hostInfo: hostInfo
          });
        });

        confirmReq.on('error', () => {
          if (resolved) return;
          resolved = true;
          req.destroy();
          resolve({ success: false, rtt });
        });

        confirmReq.on('timeout', () => {
          if (resolved) return;
          resolved = true;
          confirmReq.destroy();
          resolve({ success: false, rtt });
        });
      });

      req.on('error', () => {
        if (resolved) return;
        resolved = true;
        const rtt = Date.now() - startTime;
        resolve({ success: false, rtt });
      });

      req.on('timeout', () => {
        if (resolved) return;
        resolved = true;
        req.destroy();
        const rtt = Date.now() - startTime;
        resolve({ success: false, rtt });
      });
    });
  }

  // 处理扫描队列
  async processQueue() {
    while (this.scanQueue.length > 0 || this.activeScans > 0) {
      if (!this.isScanning) break;

      while (this.activeScans < this.concurrency && this.scanQueue.length > 0) {
        if (!this.isScanning) break;
        
        const ip = this.scanQueue.shift();
        this.activeScans++;

        this.probeHost(ip).then((result) => {
          this.activeScans--;
          
          if (result) {
            const key = `${result.ip}:${result.ports.join(',')}`;
            if (!this.foundHosts.has(key)) {
              this.foundHosts.set(key, result);
              this.onFound(result);
            }
          }

          this.onProgress({
            scanned: (this.totalIPs || 0) - this.scanQueue.length - this.activeScans,
            total: this.totalIPs || 0,
            found: this.foundHosts.size
          });

          // 继续处理队列
          if (this.isScanning) {
            this.processQueue();
          }
        }).catch(() => {
          this.activeScans--;
          if (this.isScanning) {
            this.processQueue();
          }
        });
      }

      // 等待一段时间再检查
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (this.activeScans === 0 && this.scanQueue.length === 0) {
      this.isScanning = false;
    }
  }

  // 获取额外的扫描网段（基于本机 IP 的前两个字节）
  getAdditionalNetworks(baseNetworks) {
    const additionalNetworks = [];
    const scannedSegments = new Set();
    
    // 收集所有已扫描的网段（第三个字节）
    for (const network of baseNetworks) {
      const parts = network.ip.split('.').map(Number);
      const [_, prefix] = network.cidr.split('/');
      const prefixLen = parseInt(prefix, 10);
      
      if (prefixLen >= 24) {
        // 对于 /24 及以上，记录第三个字节
        scannedSegments.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      } else if (prefixLen === 23) {
        // 对于 /23，记录包含的两个 /24 子网
        const baseThird = Math.floor(parts[2] / 2) * 2;
        scannedSegments.add(`${parts[0]}.${parts[1]}.${baseThird}`);
        scannedSegments.add(`${parts[0]}.${parts[1]}.${baseThird + 1}`);
      }
    }
    
    // 对于每个发现的网段，扫描同网段的其他常见 /24 子网
    for (const network of baseNetworks) {
      const parts = network.ip.split('.').map(Number);
      const [_, prefix] = network.cidr.split('/');
      const prefixLen = parseInt(prefix, 10);
      
      // 如果本机在 10.x.x.x 网段
      if (parts[0] === 10) {
        // 对于 /23 子网，确保扫描整个 /23 内的所有 /24
        if (prefixLen === 23) {
          const baseThird = Math.floor(parts[2] / 2) * 2;
          for (let i = 0; i < 2; i++) {
            const third = baseThird + i;
            const segmentKey = `${parts[0]}.${parts[1]}.${third}`;
            if (!scannedSegments.has(segmentKey)) {
              const baseIP = `${parts[0]}.${parts[1]}.${third}.0`;
              additionalNetworks.push({
                ip: `${parts[0]}.${parts[1]}.${third}.1`,
                baseIP: baseIP,
                cidr: `${baseIP}/24`,
                netmask: '255.255.255.0'
              });
              scannedSegments.add(segmentKey);
            }
          }
        }
        
        // 额外扫描一些常见的 /24 子网（如 116, 100 等）
        const commonSegments = [116, 100, 101, 102, 103, 104, 105, 110, 120, 130];
        for (const third of commonSegments) {
          const segmentKey = `${parts[0]}.${parts[1]}.${third}`;
          if (!scannedSegments.has(segmentKey)) {
            const baseIP = `${parts[0]}.${parts[1]}.${third}.0`;
            additionalNetworks.push({
              ip: `${parts[0]}.${parts[1]}.${third}.1`,
              baseIP: baseIP,
              cidr: `${baseIP}/24`,
              netmask: '255.255.255.0'
            });
            scannedSegments.add(segmentKey);
          }
        }
      }
    }
    
    return additionalNetworks;
  }

  // 开始扫描
  async startScan() {
    if (this.isScanning) {
      return;
    }

    this.isScanning = true;
    this.foundHosts.clear();
    this.scanQueue = [];
    this.activeScans = 0;

    const baseNetworks = this.getLocalNetworks();
    const additionalNetworks = this.getAdditionalNetworks(baseNetworks);
    const allNetworks = [...baseNetworks, ...additionalNetworks];
    const allIPs = [];

    console.log(`[Scanner] 开始扫描，发现 ${baseNetworks.length} 个基础网段，${additionalNetworks.length} 个额外网段`);
    for (const network of allNetworks) {
      const ips = this.generateIPs(network);
      allIPs.push(...ips);
      console.log(`[Scanner] 网段 ${network.cidr} 生成 ${ips.length} 个 IP`);
    }

    this.totalIPs = allIPs.length;
    this.scanQueue = [...allIPs];
    
    // 检查目标 IP 是否在扫描列表中
    const targetIP = '10.202.116.206';
    if (allIPs.includes(targetIP)) {
      console.log(`[Scanner] ✓ 目标 IP ${targetIP} 在扫描列表中`);
    } else {
      console.log(`[Scanner] ✗ 目标 IP ${targetIP} 不在扫描列表中！`);
      if (allIPs.length > 0) {
        console.log(`[Scanner] 扫描范围: ${allIPs[0]} 到 ${allIPs[allIPs.length - 1]}`);
      }
    }

    this.onProgress({
      scanned: 0,
      total: this.totalIPs,
      found: 0
    });

    await this.processQueue();
  }

  // 停止扫描
  stopScan() {
    this.isScanning = false;
    this.scanQueue = [];
  }

  // 手动添加主机
  async addHost(ip, port) {
    const result = await this.probePort(ip, port);
    if (result.success) {
      const host = {
        ip,
        ports: [port],
        rtt: result.rtt,
        status: 'success',
        timestamp: Date.now()
      };
      this.foundHosts.set(`${ip}:${port}`, host);
      this.onFound(host);
      return host;
    }
    return null;
  }

  // 获取已发现的主机列表
  getFoundHosts() {
    return Array.from(this.foundHosts.values());
  }
}

module.exports = NetworkScanner;
