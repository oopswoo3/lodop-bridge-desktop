const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 扫描相关
  startScan: () => ipcRenderer.invoke('start-scan'),
  stopScan: () => ipcRenderer.invoke('stop-scan'),
  getScanResults: () => ipcRenderer.invoke('get-scan-results'),
  addHost: (ip, port) => ipcRenderer.invoke('add-host', ip, port),
  onScanProgress: (callback) => {
    ipcRenderer.on('scan-progress', (event, data) => callback(data));
  },
  onScanFound: (callback) => {
    ipcRenderer.on('scan-found', (event, data) => callback(data));
  },
  removeScanListeners: () => {
    ipcRenderer.removeAllListeners('scan-progress');
    ipcRenderer.removeAllListeners('scan-found');
  },

  // 主机绑定相关
  bindHost: (host) => ipcRenderer.invoke('bind-host', host),
  unbindHost: () => ipcRenderer.invoke('unbind-host'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  testConnection: () => ipcRenderer.invoke('test-connection'),
  testPrint: (printer) => ipcRenderer.invoke('test-print', printer),
  testPrintWebSocket: () => ipcRenderer.invoke('test-print-websocket'),
  getPrinters: () => ipcRenderer.invoke('get-printers'),

  // 设置相关
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),

  // 备注相关
  getHostNote: (ip, port) => ipcRenderer.invoke('get-host-note', ip, port),
  setHostNote: (ip, port, note) => ipcRenderer.invoke('set-host-note', ip, port, note),
  getAllHostNotes: () => ipcRenderer.invoke('get-all-host-notes'),

  // 其他
  openDemo: () => ipcRenderer.invoke('open-demo')
});
