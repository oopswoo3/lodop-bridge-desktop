import * as os from 'os';
import * as ipaddr from 'ipaddr.js';

/**
 * 网络接口信息
 */
export interface NetworkInterface {
  name: string;
  address: string;
  netmask: string;
  cidr: string;
}

/**
 * 获取所有网络接口的 CIDR 网段
 */
export function getNetworkInterfaces(): NetworkInterface[] {
  const interfaces = os.networkInterfaces();
  const result: NetworkInterface[] = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;

    for (const addr of addrs) {
      // 只处理 IPv4 且非内部地址
      if (addr.family === 'IPv4' && !addr.internal) {
        try {
          const ip = ipaddr.process(addr.address);
          const netmask = ipaddr.process(addr.netmask || '255.255.255.0');
          const cidr = calculateCIDR(addr.address, addr.netmask || '255.255.255.0');

          result.push({
            name,
            address: addr.address,
            netmask: addr.netmask || '255.255.255.0',
            cidr,
          });
        } catch (error) {
          // 忽略无效的 IP 地址
          continue;
        }
      }
    }
  }

  return result;
}

/**
 * 计算 CIDR 网段
 */
export function calculateCIDR(ip: string, netmask: string): string {
  try {
    const ipAddr = ipaddr.process(ip);
    const maskAddr = ipaddr.process(netmask);
    const ipBytes = ipAddr.toByteArray();
    const maskBytes = maskAddr.toByteArray();
    const bytes = ipBytes.map((b, i) => b & (maskBytes[i] ?? 0xff));
    const network = ipaddr.fromByteArray(bytes);
    const prefixLength = getPrefixLength(netmask);
    return `${network.toString()}/${prefixLength}`;
  } catch (error) {
    // 如果计算失败，返回默认 /24
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
}

/**
 * 从子网掩码计算前缀长度
 */
function getPrefixLength(netmask: string): number {
  try {
    const mask = ipaddr.process(netmask);
    const bytes = mask.toByteArray();
    let prefix = 0;

    for (const byte of bytes) {
      if (byte === 255) {
        prefix += 8;
      } else if (byte === 0) {
        break;
      } else {
        // 计算连续 1 的位数
        let count = 0;
        let temp = byte;
        while (temp > 0) {
          if (temp & 1) count++;
          temp >>= 1;
        }
        prefix += count;
        break;
      }
    }

    return prefix;
  } catch {
    return 24; // 默认 /24
  }
}

/**
 * 获取 CIDR 网段内的所有 IP 地址
 */
export function getIPsInCIDR(cidr: string): string[] {
  const [networkStr, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);

  if (isNaN(prefix) || prefix < 0 || prefix > 32) {
    return [];
  }

  try {
    const network = ipaddr.process(networkStr);
    const networkBytes = network.toByteArray();
    const hostBits = 32 - prefix;
    const hostCount = Math.pow(2, hostBits);

    // 对于 /24 网段，通常有 256 个地址（0-255），但 0 和 255 通常不用
    // 我们返回 1-254
    if (prefix === 24) {
      const baseIP = networkBytes.slice(0, 3).join('.');
      const ips: string[] = [];
      for (let i = 1; i <= 254; i++) {
        ips.push(`${baseIP}.${i}`);
      }
      return ips;
    }

    // 对于其他网段，计算所有可能的 IP
    const ips: string[] = [];
    const startIP = ipaddr.IPv4.parse(networkStr);
    const startBytes = startIP.toByteArray();

    // 计算网络地址和广播地址
    const networkNum = (startBytes[0] << 24) | (startBytes[1] << 16) | (startBytes[2] << 8) | startBytes[3];
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    const networkAddr = networkNum & mask;
    const broadcastAddr = networkAddr | (~mask >>> 0);

    // 生成所有 IP（排除网络地址和广播地址）
    for (let ipNum = networkAddr + 1; ipNum < broadcastAddr; ipNum++) {
      const ip = [
        (ipNum >>> 24) & 0xff,
        (ipNum >>> 16) & 0xff,
        (ipNum >>> 8) & 0xff,
        ipNum & 0xff,
      ].join('.');
      ips.push(ip);
    }

    return ips;
  } catch (error) {
    return [];
  }
}

/**
 * 验证 IP 地址格式
 */
export function isValidIP(ip: string): boolean {
  try {
    ipaddr.process(ip);
    return true;
  } catch {
    return false;
  }
}
