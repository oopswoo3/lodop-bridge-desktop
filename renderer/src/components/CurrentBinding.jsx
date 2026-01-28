const React = require('react');
const { useState, useEffect } = React;

// 无效打印机列表（参考 Vue 代码）
const invalidPrinterList = [
  '导出为WPS PDF',
  'OneNote for Windows 10',
  'Microsoft XPS Document Writer',
  'Microsoft Print to PDF',
  'Fax'
];

// 从 localStorage 读取保存的打印机选择
const CacheKey = 'print';
function getSavedPrinter() {
  try {
    const saved = JSON.parse(localStorage.getItem(CacheKey) || '{}');
    return saved.printer || null;
  } catch (err) {
    console.error('Failed to load saved printer:', err);
    return null;
  }
}

// 保存打印机选择到 localStorage
function savePrinter(printer) {
  try {
    const saved = JSON.parse(localStorage.getItem(CacheKey) || '{}');
    saved.printer = printer;
    localStorage.setItem(CacheKey, JSON.stringify(saved));
  } catch (err) {
    console.error('Failed to save printer:', err);
  }
}

function CurrentBinding ({ status, onRefresh }) {
  const [printers, setPrinters] = useState([]);
  const [selectedPrinter, setSelectedPrinter] = useState(null);
  // 独立的 loading 状态
  const [loadingTestConnection, setLoadingTestConnection] = useState(false);
  const [loadingTestPrint, setLoadingTestPrint] = useState(false);
  const [loadingTestPrintWebSocket, setLoadingTestPrintWebSocket] = useState(false);
  const [loadingUnbind, setLoadingUnbind] = useState(false);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [loadingNote, setLoadingNote] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [hostNote, setHostNote] = useState('');
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteInput, setNoteInput] = useState('');

  useEffect(() => {
    if (status?.boundHost) {
      // 使用 boundHost 的字符串标识作为依赖，避免对象引用变化导致重复调用
      const hostKey = `${status.boundHost?.ip}:${status.boundHost?.port}`;
      loadPrinters();
      // 延迟加载备注，确保状态已更新
      const timer = setTimeout(() => {
        loadHostNote();
      }, 100);
      return () => clearTimeout(timer);
    } else {
      // 如果没有绑定主机，清空备注
      setHostNote('');
      setNoteInput('');
    }
  }, [status?.boundHost?.ip, status?.boundHost?.port]);

  const loadHostNote = async () => {
    if (!window.electronAPI || !status?.boundHost) return;
    try {
      // 确保端口号是数字类型
      const port = typeof status.boundHost.port === 'string' 
        ? parseInt(status.boundHost.port, 10) 
        : status.boundHost.port;
      
      // 首先尝试通过 ip:port 获取备注
      let note = await window.electronAPI.getHostNote(status.boundHost.ip, port);
      
      // 如果没找到，尝试通过 IP 查找所有备注（因为同一 IP 的备注应该相同）
      if (!note) {
        const allNotes = await window.electronAPI.getAllHostNotes();
        if (allNotes) {
          // 查找该 IP 的所有备注（可能有不同端口）
          const ip = status.boundHost.ip;
          for (const [key, value] of Object.entries(allNotes)) {
            if (key.startsWith(`${ip}:`) && value) {
              note = value;
              break;
            }
          }
        }
      }
      
      const noteValue = note || '';
      setHostNote(noteValue);
      setNoteInput(noteValue);
    } catch (err) {
      console.error('Failed to load host note:', err);
    }
  };

  const handleEditNote = () => {
    setIsEditingNote(true);
    setNoteInput(hostNote);
  };

  const handleSaveNote = async () => {
    if (!window.electronAPI || !status?.boundHost) return;
    setLoadingNote(true);
    setError(null);
    setSuccess(null);
    try {
      // 确保端口号是数字类型
      const port = typeof status.boundHost.port === 'string' 
        ? parseInt(status.boundHost.port, 10) 
        : status.boundHost.port;
      
      await window.electronAPI.setHostNote(status.boundHost.ip, port, noteInput);
      const savedNote = noteInput.trim();
      setHostNote(savedNote);
      setIsEditingNote(false);
      setSuccess('备注已保存');
      // 3秒后自动消失
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError('保存备注失败: ' + err.message);
    } finally {
      setLoadingNote(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditingNote(false);
    setNoteInput(hostNote);
  };

  // 过滤无效打印机
  const validPrinters = printers.filter(printer => !invalidPrinterList.includes(printer));

  // 获取默认打印机（第一个有效打印机）
  const defaultPrinter = validPrinters.length > 0 ? validPrinters[0] : null;

  // 当打印机列表变化时，更新选中的打印机
  useEffect(() => {
    if (validPrinters.length > 0) {
      // 如果有保存的打印机选择，且该打印机仍然存在，则使用保存的
      const savedPrinter = getSavedPrinter();
      if (savedPrinter && validPrinters.includes(savedPrinter)) {
        if (selectedPrinter !== savedPrinter) {
          setSelectedPrinter(savedPrinter);
        }
      } else {
        // 否则使用默认打印机
        if (selectedPrinter !== defaultPrinter) {
          setSelectedPrinter(defaultPrinter);
          savePrinter(defaultPrinter);
        }
      }
    } else {
      if (selectedPrinter !== null) {
        setSelectedPrinter(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printers.length, validPrinters.join(',')]); // 使用长度和字符串来检测数组变化

  const loadPrinters = async () => {
    if (!window.electronAPI) return;

    // 防止重复调用
    if (loadingPrinters) {
      return;
    }

    setLoadingPrinters(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await window.electronAPI.getPrinters();
      if (result && result.printers) {
        setPrinters(result.printers);
        const validCount = result.printers.filter(p => !invalidPrinterList.includes(p)).length;
        if (validCount > 0) {
          setSuccess(`成功加载 ${validCount} 个有效打印机（共 ${result.printers.length} 个）`);
          setTimeout(() => setSuccess(null), 3000);
        }
      } else {
        setPrinters([]);
      }
    } catch (err) {
      console.error('Failed to load printers:', err);
      setError('获取打印机列表失败: ' + (err.message || '未知错误'));
      setPrinters([]);
    } finally {
      setLoadingPrinters(false);
    }
  };

  const handleTestConnection = async () => {
    setLoadingTestConnection(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await window.electronAPI.testConnection();
      if (result.status?.online) {
        setSuccess('连接测试成功');
        setTimeout(() => setSuccess(null), 3000);
      } else {
        setError(result.status?.error || '连接测试失败');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingTestConnection(false);
    }
  };

  const handleTestPrint = async () => {
    setLoadingTestPrint(true);
    setError(null);
    setSuccess(null);

    try {
      const printer = selectedPrinter || defaultPrinter;
      const result = await window.electronAPI.testPrint(printer);
      if (result.success) {
        setSuccess(`打印测试已发送${printer ? `（使用打印机: ${printer}）` : ''}`);
        setTimeout(() => setSuccess(null), 3000);
      } else {
        setError(result.error || '打印测试失败');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingTestPrint(false);
    }
  };

  const handlePrinterChange = (e) => {
    const printer = e.target.value || null;
    setSelectedPrinter(printer);
    savePrinter(printer);
  };

  const handleTestPrintWebSocket = async () => {
    setLoadingTestPrintWebSocket(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await window.electronAPI.testPrintWebSocket();
      if (result.success) {
        setSuccess(`WebSocket 打印测试已发送${result.responseReceived ? '（已收到响应）' : '（等待响应）'}`);
        setTimeout(() => setSuccess(null), 3000);
        if (result.response) {
          console.log('WebSocket 响应:', result.response);
        }
      } else {
        setError(result.error || 'WebSocket 打印测试失败');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingTestPrintWebSocket(false);
    }
  };

  const handleUnbind = async () => {
    if (!confirm('确定要解绑当前主机吗？')) {
      return;
    }

    setLoadingUnbind(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await window.electronAPI.unbindHost();
      if (result.success) {
        setSuccess('已解绑');
        setTimeout(() => setSuccess(null), 3000);
        setPrinters([]);
        if (onRefresh) {
          onRefresh();
        }
      } else {
        setError(result.error || '解绑失败');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingUnbind(false);
    }
  };

  const handleOpenDemo = () => {
    if (window.electronAPI) {
      window.electronAPI.openDemo();
    }
  };

  if (!status?.boundHost) {
    return (
      <div className="card">
        <h2>当前绑定</h2>
        <div className="info-message">
          未绑定任何主机，请在"主机发现"页面选择并绑定一个主机。
        </div>
      </div>
    );
  }

  const { boundHost, status: hostStatus, lastUpdate } = status;
  const isOnline = hostStatus?.online;

  return (
    <div>
      <div className="card">
        <h2>当前绑定</h2>
        {error && <div className="error-message">{error}</div>}
        {success && <div className="success-message">{success}</div>}

        <div className="host-info-section" style={{ marginBottom: '24px' }}>
          <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <strong style={{ fontSize: '16px' }}>主机地址:</strong>
              <span style={{ fontSize: '16px', color: '#333' }}>{boundHost.ip}:{boundHost.port}</span>
            </div>
            {hostNote && !isEditingNote && (
              <span className="note-badge" style={{
                padding: '4px 10px',
                backgroundColor: '#e3f2fd',
                color: '#1976d2',
                borderRadius: '4px',
                fontSize: '13px',
                fontWeight: '500'
              }}>
                📝 {hostNote}
              </span>
            )}
          </div>
          
          <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={`status-indicator ${isOnline ? 'online' : 'offline'}`} />
            <strong>状态:</strong>
            <span style={{ color: isOnline ? '#28a745' : '#dc3545', fontWeight: '500' }}>
              {isOnline ? '在线' : '离线'}
            </span>
          </div>

          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <strong>备注:</strong>
              {!isEditingNote && (
                <button
                  className="button button-secondary"
                  onClick={handleEditNote}
                  disabled={loadingNote}
                  style={{ fontSize: '12px', padding: '4px 8px' }}
                  title="编辑备注"
                >
                  {hostNote ? '✏️ 编辑' : '📝 添加备注'}
                </button>
              )}
            </div>
            {isEditingNote ? (
              <div>
                <input
                  type="text"
                  className="input"
                  placeholder="输入备注..."
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !loadingNote) {
                      handleSaveNote();
                    } else if (e.key === 'Escape') {
                      handleCancelEdit();
                    }
                  }}
                  disabled={loadingNote}
                  style={{ marginBottom: '4px', width: '100%', maxWidth: '400px' }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    className="button button-primary"
                    onClick={handleSaveNote}
                    disabled={loadingNote}
                    style={{ fontSize: '12px', padding: '4px 8px' }}
                  >
                    {loadingNote ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span className="loading-spinner" style={{ width: '12px', height: '12px' }}></span>
                        保存中...
                      </span>
                    ) : '保存'}
                  </button>
                  <button
                    className="button button-secondary"
                    onClick={handleCancelEdit}
                    disabled={loadingNote}
                    style={{ fontSize: '12px', padding: '4px 8px' }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              !hostNote && (
                <div style={{ color: '#999', fontStyle: 'italic', fontSize: '13px' }}>
                  暂无备注
                </div>
              )
            )}
          </div>
          
          {hostStatus?.error && (
            <div style={{ marginBottom: '12px', color: '#dc3545', fontSize: '13px' }}>
              <strong>错误:</strong> {hostStatus.error}
            </div>
          )}
          {lastUpdate && (
            <div style={{ marginBottom: '12px', color: '#666', fontSize: '12px' }}>
              最后更新: {new Date(lastUpdate).toLocaleString()}
            </div>
          )}
        </div>

        <div style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <strong>选择打印机:</strong>
            {loadingPrinters ? (
              <span style={{ color: '#666', fontSize: '13px' }}>加载中...</span>
            ) : validPrinters.length > 0 ? (
              <select
                className="input"
                value={selectedPrinter || ''}
                onChange={handlePrinterChange}
                style={{ minWidth: '250px', padding: '6px 8px' }}
                disabled={loadingTestPrint}
              >
                {validPrinters.map((printer, index) => (
                  <option key={index} value={printer}>
                    {printer}
                  </option>
                ))}
              </select>
            ) : (
              <span style={{ color: '#999', fontSize: '13px' }}>暂无可用打印机</span>
            )}
          </div>
          {selectedPrinter && (
            <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
              当前选择: <strong>{selectedPrinter}</strong>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '16px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', flex: 1 }}>
            <button
              className={`button button-primary ${loadingTestConnection ? 'button-loading' : ''}`}
              onClick={handleTestConnection}
              disabled={loadingTestConnection}
            >
              {loadingTestConnection ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="loading-spinner" style={{ width: '14px', height: '14px' }}></span>
                  测试中...
                </span>
              ) : '测试连接'}
            </button>
            <button
              className={`button button-primary ${loadingTestPrint ? 'button-loading' : ''}`}
              onClick={handleTestPrint}
              disabled={loadingTestPrint || !isOnline || validPrinters.length === 0}
            >
              {loadingTestPrint ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="loading-spinner" style={{ width: '14px', height: '14px' }}></span>
                  测试中...
                </span>
              ) : '测试打印'}
            </button>
            <button
              className={`button button-primary ${loadingTestPrintWebSocket ? 'button-loading' : ''}`}
              onClick={handleTestPrintWebSocket}
              disabled={loadingTestPrintWebSocket || !isOnline}
              style={{ backgroundColor: '#17a2b8', borderColor: '#17a2b8' }}
              title="通过 WebSocket 发送您提供的完整打印消息进行测试"
            >
              {loadingTestPrintWebSocket ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="loading-spinner" style={{ width: '14px', height: '14px' }}></span>
                  测试中...
                </span>
              ) : 'WebSocket 测试打印'}
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <button
              className="button button-secondary"
              onClick={handleOpenDemo}
            >
              打开 Demo 页
            </button>
            <button
              className={`button button-danger ${loadingUnbind ? 'button-loading' : ''}`}
              onClick={handleUnbind}
              disabled={loadingUnbind}
            >
              {loadingUnbind ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="loading-spinner" style={{ width: '14px', height: '14px' }}></span>
                  解绑中...
                </span>
              ) : '解绑'}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>打印机列表</h2>
        {loadingPrinters ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px', color: '#666' }}>
            <span className="loading-spinner" style={{ width: '16px', height: '16px' }}></span>
            <span>正在加载打印机列表...</span>
          </div>
        ) : validPrinters.length === 0 ? (
          <p style={{ color: '#666', marginTop: '16px' }}>暂无有效打印机</p>
        ) : (
          <ul className="host-list">
            {validPrinters.map((printer, index) => (
              <li key={index} className="host-item" style={{
                backgroundColor: printer === selectedPrinter ? '#e3f2fd' : 'transparent',
                borderLeft: printer === selectedPrinter ? '3px solid #1976d2' : 'none'
              }}>
                <div className="host-info">
                  <strong>{printer}</strong>
                  {printer === selectedPrinter && (
                    <span style={{ marginLeft: '8px', color: '#1976d2', fontSize: '12px' }}>✓ 已选择</span>
                  )}
                </div>
              </li>
            ))}
            {printers.length > validPrinters.length && (
              <li style={{ padding: '8px', color: '#999', fontSize: '12px', fontStyle: 'italic' }}>
                已过滤 {printers.length - validPrinters.length} 个无效打印机
              </li>
            )}
          </ul>
        )}
        <button
          className={`button button-secondary ${loadingPrinters ? 'button-loading' : ''}`}
          onClick={loadPrinters}
          disabled={loadingPrinters}
          style={{ marginTop: '16px' }}
        >
          {loadingPrinters ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span className="loading-spinner" style={{ width: '14px', height: '14px' }}></span>
              加载中...
            </span>
          ) : '刷新列表'}
        </button>
      </div>
    </div>
  );
}

module.exports = CurrentBinding;
module.exports.default = CurrentBinding;
