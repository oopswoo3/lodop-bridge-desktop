const Store = require('electron-store');

const store = new Store({
  name: 'lodop-config',
  defaults: {
    boundHost: null, // { ip: string, port: number }
    lastUpdate: null,
    hostNotes: {}, // { "ip:port": "备注内容" }
    settings: {
      scanConcurrency: 64,
      scanTimeout: 800,
      allowedPorts: [8000, 18000],
      allowedOrigins: ['localhost', '127.0.0.1']
    }
  }
});

module.exports = {
  // 获取绑定的主机
  getBoundHost() {
    return store.get('boundHost');
  },

  // 保存绑定的主机
  setBoundHost(host) {
    store.set('boundHost', host);
    store.set('lastUpdate', Date.now());
  },

  // 清除绑定
  clearBoundHost() {
    store.delete('boundHost');
    store.delete('lastUpdate');
  },

  // 获取设置
  getSettings() {
    return store.get('settings');
  },

  // 更新设置
  updateSettings(newSettings) {
    const current = store.get('settings');
    store.set('settings', { ...current, ...newSettings });
  },

  // 获取所有配置
  getAll() {
    return store.store;
  },

  // 获取主机备注
  getHostNote(ip, port) {
    const key = `${ip}:${port}`;
    return store.get(`hostNotes.${key}`, '');
  },

  // 设置主机备注
  setHostNote(ip, port, note) {
    const key = `${ip}:${port}`;
    const hostNotes = store.get('hostNotes', {});
    if (note && note.trim()) {
      hostNotes[key] = note.trim();
    } else {
      delete hostNotes[key];
    }
    store.set('hostNotes', hostNotes);
  },

  // 获取所有主机备注
  getAllHostNotes() {
    return store.get('hostNotes', {});
  }
};
