const React = require('react');
const { useState, useEffect } = React;

function HostDiscovery () {
  const [isScanning, setIsScanning] = useState(false);
  const [hosts, setHosts] = useState([]);
  const [progress, setProgress] = useState({ scanned: 0, total: 0, found: 0 });
  const [manualIP, setManualIP] = useState('');
  const [manualPort, setManualPort] = useState('8000');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [hostNotes, setHostNotes] = useState({});
  const [editingNote, setEditingNote] = useState(null);
  const [noteInput, setNoteInput] = useState('');

  useEffect(() => {
    if (!window.electronAPI) return;

    // 监听扫描进度
    window.electronAPI.onScanProgress((data) => {
      setProgress(data);
    });

    // 监听发现的主机
    window.electronAPI.onScanFound((host) => {
      setHosts(prev => {
        const key = `${host.ip}:${host.ports.join(',')}`;
        const exists = prev.some(h => `${h.ip}:${h.ports.join(',')}` === key);
        if (!exists) {
          return [...prev, host];
        }
        return prev;
      });
    });

    // 加载已有结果
    loadResults();
    // 加载备注
    loadHostNotes();

    return () => {
      window.electronAPI.removeScanListeners();
    };
  }, []);

  const loadResults = async () => {
    if (window.electronAPI) {
      const results = await window.electronAPI.getScanResults();
      setHosts(results);
    }
  };

  const loadHostNotes = async () => {
    if (window.electronAPI) {
      const notes = await window.electronAPI.getAllHostNotes();
      setHostNotes(notes || {});
    }
  };

  const getHostNote = (ip, port) => {
    const key = `${ip}:${port}`;
    return hostNotes[key] || '';
  };

  const handleEditNote = (host) => {
    const port = host.ports[0];
    const key = `${host.ip}:${port}`;
    setEditingNote(key);
    setNoteInput(getHostNote(host.ip, port));
  };

  const handleSaveNote = async (host) => {
    const port = host.ports[0];
    try {
      await window.electronAPI.setHostNote(host.ip, port, noteInput);
      const key = `${host.ip}:${port}`;
      setHostNotes(prev => ({
        ...prev,
        [key]: noteInput.trim()
      }));
      setEditingNote(null);
      setNoteInput('');
      setSuccess('备注已保存');
    } catch (err) {
      setError('保存备注失败: ' + err.message);
    }
  };

  const handleCancelEdit = () => {
    setEditingNote(null);
    setNoteInput('');
  };

  const handleStartScan = async () => {
    setIsScanning(true);
    setError(null);
    setSuccess(null);
    setHosts([]);
    setProgress({ scanned: 0, total: 0, found: 0 });

    try {
      await window.electronAPI.startScan();
    } catch (err) {
      setError(err.message);
      setIsScanning(false);
    }
  };

  const handleStopScan = async () => {
    await window.electronAPI.stopScan();
    setIsScanning(false);
  };

  const handleRescan = async () => {
    setHosts([]);
    await handleStartScan();
  };

  const handleAddHost = async () => {
    if (!manualIP || !manualPort) {
      setError('请输入 IP 和端口');
      return;
    }

    setError(null);
    setSuccess(null);

    try {
      const host = await window.electronAPI.addHost(manualIP, parseInt(manualPort));
      if (host) {
        setHosts(prev => {
          const key = `${host.ip}:${host.ports.join(',')}`;
          const exists = prev.some(h => `${h.ip}:${h.ports.join(',')}` === key);
          if (!exists) {
            return [...prev, host];
          }
          return prev;
        });
        setSuccess(`成功添加主机 ${manualIP}:${manualPort}`);
        setManualIP('');
      } else {
        setError('无法连接到该主机');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSelectHost = async (host) => {
    const port = host.ports[0];
    setError(null);
    setSuccess(null);

    try {
      const result = await window.electronAPI.bindHost({ ip: host.ip, port });
      if (result.success) {
        setSuccess(`成功绑定到 ${host.ip}:${port}`);
      } else {
        setError(result.error || '绑定失败');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>局域网扫描</h2>
        {error && <div className="error-message">{error}</div>}
        {success && <div className="success-message">{success}</div>}

        <div style={{ marginBottom: '16px' }}>
          <button
            className="button button-primary"
            onClick={handleStartScan}
            disabled={isScanning}
          >
            开始扫描
          </button>
          <button
            className="button button-secondary"
            onClick={handleStopScan}
            disabled={!isScanning}
          >
            停止扫描
          </button>
          <button
            className="button button-secondary"
            onClick={handleRescan}
            disabled={isScanning}
          >
            重新扫描
          </button>
        </div>

        {progress.total > 0 && (
          <div>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${(progress.scanned / progress.total) * 100}%` }}
              />
            </div>
            <div className="progress-text">
              已扫描: {progress.scanned} / {progress.total} | 发现: {progress.found}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>手动添加主机</h2>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <input
            type="text"
            className="input"
            placeholder="IP 地址"
            value={manualIP}
            onChange={(e) => setManualIP(e.target.value)}
            style={{ flex: 2 }}
          />
          <input
            type="text"
            className="input"
            placeholder="端口"
            value={manualPort}
            onChange={(e) => setManualPort(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            className="button button-primary"
            onClick={handleAddHost}
          >
            添加
          </button>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0 }}>发现的主机 ({hosts.length})</h2>
          <input
            type="text"
            className="input"
            placeholder="搜索 IP、主机名、备注或系统信息..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: '300px' }}
          />
        </div>
        {hosts.length === 0 ? (
          <p style={{ color: '#666', marginTop: '16px' }}>暂无发现的主机</p>
        ) : (() => {
          // 过滤主机列表
          const filteredHosts = hosts.filter(host => {
            if (!searchQuery.trim()) return true;
            const query = searchQuery.toLowerCase();
            const ip = host.ip.toLowerCase();
            const hostname = (host.hostname || '').toLowerCase();
            const os = (host.os || '').toLowerCase();
            const version = (host.version || '').toLowerCase();
            const ports = host.ports.join(', ');
            const port = host.ports[0];
            const note = getHostNote(host.ip, port).toLowerCase();

            return ip.includes(query) ||
              hostname.includes(query) ||
              os.includes(query) ||
              version.includes(query) ||
              ports.includes(query) ||
              note.includes(query);
          });

          return filteredHosts.length === 0 ? (
            <p style={{ color: '#666', marginTop: '16px' }}>没有找到匹配的主机</p>
          ) : (
            <ul className="host-list">
              {filteredHosts.map((host, index) => {
                const port = host.ports[0];
                const key = `${host.ip}:${port}`;
                const note = getHostNote(host.ip, port);
                const isEditing = editingNote === key;

                return (
                  <li key={index} className="host-item">
                    <div className="host-info" style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                        <strong>{host.ip}</strong>
                        {host.hostname && (
                          <span className="hostname-badge">
                            {host.hostname}
                          </span>
                        )}
                        {note && !isEditing && (
                          <span style={{
                            padding: '2px 8px',
                            backgroundColor: '#e3f2fd',
                            color: '#1976d2',
                            borderRadius: '4px',
                            fontSize: '12px',
                            fontWeight: '500'
                          }}>
                            📝 {note}
                          </span>
                        )}
                      </div>
                      {isEditing ? (
                        <div style={{ marginBottom: '8px' }}>
                          <input
                            type="text"
                            className="input"
                            placeholder="输入备注..."
                            value={noteInput}
                            onChange={(e) => setNoteInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                handleSaveNote(host);
                              } else if (e.key === 'Escape') {
                                handleCancelEdit();
                              }
                            }}
                            style={{ marginBottom: '4px', width: '100%' }}
                            autoFocus
                          />
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button
                              className="button button-primary"
                              onClick={() => handleSaveNote(host)}
                              style={{ fontSize: '12px', padding: '4px 8px' }}
                            >
                              保存
                            </button>
                            <button
                              className="button button-secondary"
                              onClick={handleCancelEdit}
                              style={{ fontSize: '12px', padding: '4px 8px' }}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : null}
                      <div className="meta" style={{ fontSize: '13px', color: '#666', lineHeight: '1.6' }}>
                        <div>
                          <span style={{ fontWeight: '500' }}>端口:</span> {host.ports.join(', ')} |
                          <span style={{ fontWeight: '500' }}> 延迟:</span> {host.rtt}ms |
                          <span style={{ fontWeight: '500' }}> 状态:</span> {host.status}
                        </div>
                        {(host.os || host.version) && (
                          <div style={{ marginTop: '4px', color: '#888' }}>
                            {host.os && <span>系统: {host.os}</span>}
                            {host.os && host.version && <span> | </span>}
                            {host.version && <span>版本: {host.version}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginLeft: '16px' }}>
                      <button
                        className="button button-secondary"
                        onClick={() => handleEditNote(host)}
                        style={{ fontSize: '12px', padding: '6px 12px' }}
                        title="编辑备注"
                      >
                        {note ? '✏️' : '📝'}
                      </button>
                      <button
                        className="button button-primary"
                        onClick={() => handleSelectHost(host)}
                      >
                        选择
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          );
        })()}
      </div>
    </div>
  );
}

module.exports = HostDiscovery;
module.exports.default = HostDiscovery;
