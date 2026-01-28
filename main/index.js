const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const ProxyServer = require('./proxy-server');
const NetworkScanner = require('./scanner');
const storage = require('./storage');

let mainWindow = null;
let proxyServer = null;
let scanner = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, '../public/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'C-Lodop Client'
  });

  // 加载 React 应用
  const isDev = process.argv.includes('--dev');
  if (isDev) {
    // 开发模式：加载本地文件并打开开发者工具
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 初始化代理服务器
async function initProxyServer() {
  proxyServer = new ProxyServer();
  try {
    await proxyServer.init();
    console.log('Proxy server initialized');
  } catch (error) {
    console.error('Failed to initialize proxy server:', error);
  }
}

// 初始化扫描器
function initScanner() {
  const settings = storage.getSettings();
  scanner = new NetworkScanner({
    concurrency: settings.scanConcurrency || 64,
    timeout: settings.scanTimeout || 800,
    ports: settings.allowedPorts || [8000, 18000],
    onProgress: (progress) => {
      if (mainWindow) {
        mainWindow.webContents.send('scan-progress', progress);
      }
    },
    onFound: (host) => {
      if (mainWindow) {
        mainWindow.webContents.send('scan-found', host);
      }
      if (proxyServer) {
        proxyServer.setScanResults(scanner.getFoundHosts());
      }
    }
  });
}

// IPC 处理
ipcMain.handle('start-scan', async () => {
  if (!scanner) {
    initScanner();
  }
  await scanner.startScan();
  return { success: true };
});

ipcMain.handle('stop-scan', () => {
  if (scanner) {
    scanner.stopScan();
  }
  return { success: true };
});

ipcMain.handle('get-scan-results', () => {
  if (scanner) {
    return scanner.getFoundHosts();
  }
  return [];
});

ipcMain.handle('add-host', async (event, ip, port) => {
  if (!scanner) {
    initScanner();
  }
  const host = await scanner.addHost(ip, port);
  return host;
});

ipcMain.handle('bind-host', async (event, host) => {
  return new Promise((resolve) => {
    const port = proxyServer ? proxyServer.getPort() : 8000;
    const data = JSON.stringify(host);
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/bind',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
    req.on('error', (error) => {
      resolve({ error: error.message });
    });
    req.write(data);
    req.end();
  });
});

ipcMain.handle('unbind-host', async () => {
  return new Promise((resolve) => {
    const port = proxyServer ? proxyServer.getPort() : 8000;
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/unbind',
      method: 'POST'
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
    req.on('error', (error) => {
      resolve({ error: error.message });
    });
    req.end();
  });
});

ipcMain.handle('get-status', async () => {
  return new Promise((resolve) => {
    const port = proxyServer ? proxyServer.getPort() : 8000;
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/status',
      method: 'GET'
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
    req.on('error', (error) => {
      resolve({ error: error.message });
    });
    req.end();
  });
});

ipcMain.handle('test-connection', async () => {
  return new Promise((resolve) => {
    const port = proxyServer ? proxyServer.getPort() : 8000;
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/status',
      method: 'GET'
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
    req.on('error', (error) => {
      resolve({ error: error.message });
    });
    req.end();
  });
});

ipcMain.handle('test-print', async (event, printer) => {
  return new Promise((resolve) => {
    const port = proxyServer ? proxyServer.getPort() : 8000;
    const data = JSON.stringify({ printer });
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/test-print',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
    req.on('error', (error) => {
      resolve({ error: error.message });
    });
    req.write(data);
    req.end();
  });
});

ipcMain.handle('test-print-websocket', async () => {
  return new Promise((resolve) => {
    const port = proxyServer ? proxyServer.getPort() : 8000;
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/test-print-websocket',
      method: 'POST'
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
    req.on('error', (error) => {
      resolve({ error: error.message });
    });
    req.end();
  });
});

ipcMain.handle('get-printers', async () => {
  return new Promise((resolve) => {
    const port = proxyServer ? proxyServer.getPort() : 8000;
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/printers',
      method: 'GET'
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
    req.on('error', (error) => {
      resolve({ error: error.message });
    });
    req.end();
  });
});

ipcMain.handle('get-settings', () => {
  return storage.getSettings();
});

ipcMain.handle('update-settings', (event, newSettings) => {
  storage.updateSettings(newSettings);
  // 重新初始化扫描器以应用新设置
  initScanner();
  return { success: true };
});

ipcMain.handle('open-demo', () => {
  const demoPath = path.join(__dirname, '../demo/index.html');
  const demoWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  demoWindow.loadFile(demoPath);
});

ipcMain.handle('get-host-note', (event, ip, port) => {
  return storage.getHostNote(ip, port);
});

ipcMain.handle('set-host-note', (event, ip, port, note) => {
  storage.setHostNote(ip, port, note);
  return { success: true };
});

ipcMain.handle('get-all-host-notes', () => {
  return storage.getAllHostNotes();
});

// 应用生命周期
app.whenReady().then(async () => {
  await initProxyServer();
  initScanner();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    if (proxyServer) {
      await proxyServer.stop();
    }
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (proxyServer) {
    await proxyServer.stop();
  }
});
