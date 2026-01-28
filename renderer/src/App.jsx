const React = require('react');
const { useState, useEffect } = React;
const HostDiscovery = require('./components/HostDiscovery').default || require('./components/HostDiscovery');
const CurrentBinding = require('./components/CurrentBinding').default || require('./components/CurrentBinding');
const Settings = require('./components/Settings').default || require('./components/Settings');
require('./styles/App.css');

function App() {
  const [activeTab, setActiveTab] = useState('discovery');
  const [status, setStatus] = useState(null);

  useEffect(() => {
    // 加载状态
    loadStatus();
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadStatus = async () => {
    if (window.electronAPI) {
      const result = await window.electronAPI.getStatus();
      setStatus(result);
    }
  };

  return (
    <div className="app">
      <div className="header">
        <h1>
          <img 
            src="../public/icon.png" 
            alt="C-Lodop Client" 
            className="app-icon"
            onError={(e) => {
              // 如果图标加载失败，隐藏图标元素
              e.target.style.display = 'none';
            }}
          />
          C-Lodop Client
        </h1>
        <nav className="tabs">
          <button
            className={activeTab === 'discovery' ? 'active' : ''}
            onClick={() => setActiveTab('discovery')}
          >
            主机发现
          </button>
          <button
            className={activeTab === 'binding' ? 'active' : ''}
            onClick={() => setActiveTab('binding')}
          >
            当前绑定
          </button>
          <button
            className={activeTab === 'settings' ? 'active' : ''}
            onClick={() => setActiveTab('settings')}
          >
            设置
          </button>
        </nav>
      </div>
      <div className="content">
        {activeTab === 'discovery' && <HostDiscovery />}
        {activeTab === 'binding' && <CurrentBinding status={status} onRefresh={loadStatus} />}
        {activeTab === 'settings' && <Settings />}
      </div>
    </div>
  );
}

module.exports = App;
module.exports.default = App;
