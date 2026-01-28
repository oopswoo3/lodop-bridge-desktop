const React = require('react');
const { useState, useEffect } = React;

function Settings() {
  const [settings, setSettings] = useState({
    scanConcurrency: 64,
    scanTimeout: 800,
    allowedPorts: [8000, 18000],
    allowedOrigins: ['localhost', '127.0.0.1']
  });
  const [portsText, setPortsText] = useState('8000,18000');
  const [originsText, setOriginsText] = useState('localhost,127.0.0.1');
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    if (window.electronAPI) {
      const result = await window.electronAPI.getSettings();
      setSettings(result);
      setPortsText(result.allowedPorts.join(','));
      setOriginsText(result.allowedOrigins.join(','));
    }
  };

  const handleSave = async () => {
    // 解析端口
    const ports = portsText.split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p));
    if (ports.length === 0) {
      alert('至少需要一个有效端口');
      return;
    }

    // 解析 Origin
    const origins = originsText.split(',').map(o => o.trim()).filter(o => o);

    const newSettings = {
      ...settings,
      allowedPorts: ports,
      allowedOrigins: origins
    };

    if (window.electronAPI) {
      await window.electronAPI.updateSettings(newSettings);
      setSettings(newSettings);
      setSuccess('设置已保存');
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>扫描设置</h2>
        {success && <div className="success-message">{success}</div>}

        <div style={{ marginBottom: '16px' }}>
          <label className="label">扫描并发数</label>
          <input
            type="number"
            className="input"
            value={settings.scanConcurrency}
            onChange={(e) => setSettings({ ...settings, scanConcurrency: parseInt(e.target.value) || 64 })}
            min="1"
            max="256"
          />
          <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
            建议值: 64-128，过高可能导致网络拥塞
          </p>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label className="label">扫描超时 (毫秒)</label>
          <input
            type="number"
            className="input"
            value={settings.scanTimeout}
            onChange={(e) => setSettings({ ...settings, scanTimeout: parseInt(e.target.value) || 800 })}
            min="100"
            max="5000"
          />
          <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
            每个 IP 的探测超时时间，建议值: 800-2000ms
          </p>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label className="label">允许的端口 (逗号分隔)</label>
          <input
            type="text"
            className="input"
            value={portsText}
            onChange={(e) => setPortsText(e.target.value)}
            placeholder="8000,18000"
          />
          <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
            C-Lodop 默认端口，多个端口用逗号分隔
          </p>
        </div>
      </div>

      <div className="card">
        <h2>安全设置</h2>

        <div style={{ marginBottom: '16px' }}>
          <label className="label">允许的 Origin (逗号分隔)</label>
          <input
            type="text"
            className="input"
            value={originsText}
            onChange={(e) => setOriginsText(e.target.value)}
            placeholder="localhost,127.0.0.1"
          />
          <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
            允许访问本地代理的域名，默认仅允许 localhost
          </p>
        </div>
      </div>

      <div className="card">
        <button
          className="button button-primary"
          onClick={handleSave}
        >
          保存设置
        </button>
      </div>
    </div>
  );
}

module.exports = Settings;
module.exports.default = Settings;
