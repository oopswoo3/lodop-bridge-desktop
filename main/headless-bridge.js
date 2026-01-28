const { chromium } = require('playwright');
const { execSync } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

class HeadlessBridge {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.boundHost = null;
    this.isReady = false;
    this.callbacks = new Map();
    this.installingBrowser = false;
    this.gettingPrinters = false; // 防止重复调用 getPrinters
  }

  // 检查并安装浏览器
  async ensureBrowserInstalled() {
    if (this.installingBrowser) {
      // 如果正在安装，等待安装完成
      while (this.installingBrowser) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return;
    }

    try {
      // 尝试启动浏览器来检测是否已安装
      const testBrowser = await chromium.launch({
        headless: true,
        args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process']
      });
      await testBrowser.close();
      return; // 浏览器已安装
    } catch (error) {
      // 浏览器未安装，尝试自动安装
      if (error.message && error.message.includes('Executable doesn\'t exist')) {
        console.log('检测到 Playwright 浏览器未安装，正在自动安装...');
        this.installingBrowser = true;
        
        try {
          // 使用 execSync 同步执行安装命令
          execSync('npx playwright install chromium', {
            stdio: 'inherit',
            cwd: path.join(__dirname, '..')
          });
          console.log('Playwright 浏览器安装完成');
        } catch (installError) {
          console.error('自动安装浏览器失败:', installError);
          throw new Error('无法自动安装 Playwright 浏览器。请手动运行: npx playwright install chromium');
        } finally {
          this.installingBrowser = false;
        }
      } else {
        throw error;
      }
    }
  }

  // 初始化浏览器
  async init() {
    if (this.browser) {
      return;
    }

    try {
      // 确保浏览器已安装
      await this.ensureBrowserInstalled();
      
      this.browser = await chromium.launch({
        headless: true,
        args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process']
      });
      this.context = await this.browser.newContext();
      this.isReady = true;
    } catch (error) {
      console.error('Failed to launch browser:', error);
      throw error;
    }
  }

  // 绑定主机
  async bindHost(host) {
    if (!this.isReady) {
      await this.init();
    }

    this.boundHost = host;
    const url = `http://${host.ip}:${host.port}/`;

    try {
      if (this.page) {
        await this.page.close();
      }

      this.page = await this.context.newPage();

      // 注入回调处理脚本
      await this.page.addInitScript(() => {
        // 保存原始的 On_Return
        window._originalOnReturn = window.On_Return;
        window._lodopCallbacks = [];
        window._lodopOpened = false;

        // 重写 On_Return 以捕获回调
        window.On_Return = function(TaskID, Value) {
          if (window._originalOnReturn) {
            window._originalOnReturn(TaskID, Value);
          }
          
          // 发送消息到页面上下文
          window._lodopCallbacks.push({ TaskID, Value });
          
          // 触发自定义事件
          if (window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('lodop-return', {
              detail: { TaskID, Value }
            }));
          }
        };

        // 监听 C-Lodop 打开事件
        const originalOnCLodopOpened = window.On_CLodop_Opened;
        window.On_CLodop_Opened = function() {
          window._lodopOpened = true;
          if (originalOnCLodopOpened) {
            originalOnCLodopOpened();
          }
          if (window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('lodop-opened'));
          }
        };
      });

      await this.page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });

      // 等待页面 DOM 完全加载
      await this.page.waitForFunction(() => {
        return document.body && document.readyState === 'complete';
      }, { timeout: 5000 });

      // 等待 LODOP 对象加载
      await this.page.waitForFunction(() => {
        const lodop = window.LODOP || (typeof window.getCLodop === 'function' ? window.getCLodop() : null);
        return lodop && typeof lodop === 'object';
      }, { timeout: 10000 });

      // 等待 C-Lodop 连接事件（On_CLodop_Opened）
      // 如果 5 秒内没有触发，继续执行（可能已经连接或使用其他方式）
      try {
        await this.page.waitForFunction(() => {
          return window._lodopOpened === true;
        }, { timeout: 5000 });
        console.log('C-Lodop 连接事件已触发');
      } catch (e) {
        console.log('等待 C-Lodop 连接事件超时，继续执行...');
      }

      // 等待一小段时间，确保 C-Lodop 内部初始化完成
      await this.page.waitForTimeout(1000);

      // 获取 LODOP 对象并验证
      const lodop = await this.page.evaluate(() => {
        if (typeof window.getCLodop === 'function') {
          return window.getCLodop();
        }
        return window.LODOP;
      });

      if (!lodop) {
        throw new Error('Failed to get LODOP object');
      }

      // 确保 LODOP 对象有基本方法
      const hasMethods = await this.page.evaluate(() => {
        const lodop = window.LODOP || (typeof window.getCLodop === 'function' ? window.getCLodop() : null);
        return lodop && typeof lodop === 'object';
      });

      if (!hasMethods) {
        console.warn('LODOP object may not be fully initialized');
      }

      return true;
    } catch (error) {
      console.error('Failed to bind host:', error);
      if (this.page) {
        await this.page.close().catch(() => {});
        this.page = null;
      }
      throw error;
    }
  }

  // 执行方法调用
  async invoke(method, args = [], clientCallId) {
    if (!this.page || !this.boundHost) {
      throw new Error('No host bound');
    }

    console.log(`[HeadlessBridge] 调用方法: ${method}`, args, `clientCallId: ${clientCallId}`);

    try {
      // 设置回调监听
      const callbackPromise = new Promise((resolve) => {
        this.callbacks.set(clientCallId, resolve);
      });

      // 在页面中执行方法
      const result = await this.page.evaluate(async ({ method, args, clientCallId }) => {
        return new Promise((resolve, reject) => {
          try {
            // 获取 LODOP 对象
            let lodop = null;
            if (typeof window.getCLodop === 'function') {
              lodop = window.getCLodop();
            } else if (typeof window.LODOP !== 'undefined') {
              lodop = window.LODOP;
            }
            
            if (!lodop) {
              reject(new Error('LODOP not available'));
              return;
            }

            // 监听回调（使用全局回调机制）
            let callbackFired = false;
            const originalOnReturn = window.On_Return;
            
            const callbackHandler = function(TaskID, Value) {
              if (TaskID === clientCallId || !callbackFired) {
                callbackFired = true;
                if (originalOnReturn) {
                  originalOnReturn(TaskID, Value);
                }
                resolve({
                  TaskID: TaskID || clientCallId,
                  Value: Value
                });
              }
            };

            // 临时设置 On_Return
            window.On_Return = callbackHandler;

            // 执行方法
            let methodFunc = lodop[method];
            if (typeof methodFunc !== 'function' && typeof method === 'string') {
              // 尝试小写方法名
              methodFunc = lodop[method.toLowerCase()];
            }

            if (typeof methodFunc !== 'function') {
              window.On_Return = originalOnReturn;
              reject(new Error(`Method ${method} not found`));
              return;
            }

            try {
              console.log(`执行方法: ${method}`, args);
              const returnValue = methodFunc.apply(lodop, args);
              console.log(`方法 ${method} 立即返回值:`, returnValue);

              // 对于 PREVIEW 和 PRINT 方法，它们可能不会触发 On_Return
              // 如果方法立即返回结果（非异步）
              if (returnValue !== undefined && returnValue !== null && !callbackFired) {
                window.On_Return = originalOnReturn;
                resolve({
                  TaskID: clientCallId,
                  Value: returnValue
                });
              } else if (!callbackFired) {
                // 对于 PREVIEW 和 PRINT，使用较短的超时时间
                const isActionMethod = method === 'PREVIEW' || method === 'PRINT' || method === 'PRINT_SETUP' || method === 'PRINT_DESIGN';
                const timeout = isActionMethod ? 1000 : 10000;
                
                // 设置超时，防止永远等待
                setTimeout(() => {
                  if (!callbackFired) {
                    callbackFired = true;
                    window.On_Return = originalOnReturn;
                    console.log(`方法 ${method} 超时返回（${timeout}ms）`);
                    resolve({
                      TaskID: clientCallId,
                      Value: returnValue !== undefined ? returnValue : (isActionMethod ? true : null)
                    });
                  }
                }, timeout);
              }
            } catch (execError) {
              console.error(`执行方法 ${method} 时出错:`, execError);
              window.On_Return = originalOnReturn;
              reject(execError);
            }
          } catch (error) {
            reject(error);
          }
        });
      }, { method, args, clientCallId });

      console.log(`[HeadlessBridge] 方法 ${method} 返回结果:`, result);
      return {
        type: 'return',
        clientCallId,
        TaskID: result.TaskID || clientCallId,
        Value: result.Value
      };
    } catch (error) {
      console.error(`[HeadlessBridge] 方法 ${method} 调用失败:`, error);
      return {
        type: 'error',
        clientCallId,
        error: error.message
      };
    }
  }

  // 获取打印机列表
  async getPrinters() {
    if (!this.page || !this.boundHost) {
      throw new Error('No host bound');
    }

    // 防止重复调用
    if (this.gettingPrinters) {
      console.log('getPrinters 正在执行中，跳过重复调用');
      // 等待当前调用完成
      while (this.gettingPrinters) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // 返回缓存的结果或空数组
      return this.cachedPrinters || [];
    }

    this.gettingPrinters = true;
    let result = [];

    try {
      // 确保页面和 DOM 完全就绪
      await this.page.waitForFunction(() => {
        return document.body && document.readyState === 'complete';
      }, { timeout: 5000 });

      // 等待 LODOP 对象完全就绪
      await this.page.waitForFunction(() => {
        const lodop = window.LODOP || (typeof window.getCLodop === 'function' ? window.getCLodop() : null);
        return lodop && typeof lodop === 'object';
      }, { timeout: 10000 });

      // 检查 C-Lodop 是否已连接
      const isConnected = await this.page.evaluate(() => {
        return window._lodopOpened === true;
      });

      if (!isConnected) {
        console.log('C-Lodop 可能未完全连接，等待连接...');
        try {
          await this.page.waitForFunction(() => {
            return window._lodopOpened === true;
          }, { timeout: 5000 });
        } catch (e) {
          console.log('等待 C-Lodop 连接超时，继续尝试...');
        }
      }

      // 先初始化 C-Lodop，这会创建必要的 DOM 结构
      const initClientCallId = `init-${Date.now()}`;
      try {
        await this.invoke('PRINT_INIT', ['初始化', initClientCallId], initClientCallId);
        // 等待初始化完成
        await this.page.waitForTimeout(1500);
      } catch (initError) {
        console.log('PRINT_INIT 初始化失败（可能已初始化）:', initError.message);
        // 继续尝试，可能已经初始化过了
      }

      // 等待 C-Lodop 内部 DOM 结构完全初始化
      // 检查是否有 C-Lodop 创建的 iframe 或容器元素
      await this.page.waitForFunction(() => {
        // 检查常见的 C-Lodop DOM 元素
        const hasLodopElements = 
          document.getElementById('LODOP_OB') !== null ||
          document.querySelector('iframe[name*="LODOP"]') !== null ||
          document.querySelector('div[id*="LODOP"]') !== null;
        
        const lodop = window.LODOP || (typeof window.getCLodop === 'function' ? window.getCLodop() : null);
        return lodop && (hasLodopElements || document.body);
      }, { timeout: 10000 }).catch(() => {
        // 如果等待超时，继续尝试（可能 C-Lodop 使用其他方式）
        console.log('等待 C-Lodop DOM 元素超时，继续尝试...');
      });

      // 额外等待，确保 DOM 完全就绪
      await this.page.waitForTimeout(1500);

      // 确保必要的 DOM 结构已创建
      await this.page.evaluate(() => {
        // 确保有必要的 DOM 容器
        if (!document.getElementById('LODOP_OB')) {
          const container = document.createElement('div');
          container.id = 'LODOP_OB';
          container.style.position = 'absolute';
          container.style.left = '-9999px';
          container.style.top = '-9999px';
          container.style.width = '1px';
          container.style.height = '1px';
          container.style.overflow = 'hidden';
          container.style.visibility = 'hidden';
          document.body.appendChild(container);
        }

        // 检查并创建 C-Lodop 可能需要的 iframe
        let lodopIframe = document.querySelector('iframe[name*="LODOP"]') || 
                         document.querySelector('iframe[id*="LODOP"]');
        
        if (!lodopIframe) {
          lodopIframe = document.createElement('iframe');
          lodopIframe.name = 'LODOP_IFRAME';
          lodopIframe.id = 'LODOP_IFRAME';
          lodopIframe.style.position = 'absolute';
          lodopIframe.style.left = '-9999px';
          lodopIframe.style.top = '-9999px';
          lodopIframe.style.width = '1px';
          lodopIframe.style.height = '1px';
          lodopIframe.style.border = 'none';
          lodopIframe.style.visibility = 'hidden';
          document.body.appendChild(lodopIframe);
        }
      });

      // 等待 iframe 加载（如果存在）
      await this.page.waitForTimeout(1000);

      // 尝试获取打印机列表，带重试机制
      // 首先尝试使用 GET_PRINTER_COUNT 和 GET_PRINTER_NAME（这些方法可能不会遇到 DOM 问题）
      let printers = [];
      
      // 方法1: 尝试使用 GET_PRINTER_COUNT 和 GET_PRINTER_NAME
      try {
        const countResult = await this.invoke('GET_PRINTER_COUNT', [], `get-count-${Date.now()}`);
        if (countResult && countResult.Value !== undefined && countResult.Value !== null) {
          const count = parseInt(countResult.Value, 10);
          if (count > 0) {
            console.log(`找到 ${count} 个打印机，正在获取名称...`);
            
            for (let i = 1; i <= count; i++) {
              try {
                const nameResult = await this.invoke('GET_PRINTER_NAME', [i], `get-name-${i}-${Date.now()}`);
                if (nameResult && nameResult.Value) {
                  printers.push(nameResult.Value);
                }
              } catch (nameError) {
                console.error(`获取第 ${i} 个打印机名称失败:`, nameError);
              }
            }
            
            if (printers.length > 0) {
              console.log(`成功获取 ${printers.length} 个打印机:`, printers);
              // 缓存结果
              this.cachedPrinters = printers;
              // 直接返回，不继续执行方法2
              result = printers;
              this.gettingPrinters = false;
              return printers;
            } else if (count > 0) {
              console.log(`警告: 找到 ${count} 个打印机，但无法获取名称`);
              // 如果无法获取名称，返回空数组，不尝试方法2（因为方法2会失败）
              result = [];
              this.cachedPrinters = [];
              this.gettingPrinters = false;
              return [];
            }
          } else {
            console.log('未找到打印机');
            result = [];
            this.cachedPrinters = [];
            this.gettingPrinters = false;
            return [];
          }
        } else {
          console.log('GET_PRINTER_COUNT 返回无效结果，尝试 Create_Printer_List');
        }
      } catch (countError) {
        console.log('使用 GET_PRINTER_COUNT 方法失败，尝试 Create_Printer_List:', countError.message);
        // 继续执行方法2
      }

      // 方法2: 如果方法1失败或返回空，尝试使用 Create_Printer_List（仅作为后备方案）
      // 注意：这个方法可能会失败，因为 C-Lodop 服务器端代码需要特定的 DOM 结构
      // 如果方法1已经成功返回，这段代码不会被执行
      // 由于 Create_Printer_List 有已知的 DOM 问题，我们只在确实需要时才尝试
      console.log('方法1未成功获取打印机列表，尝试方法2（Create_Printer_List）...');
      console.log('警告: Create_Printer_List 可能会因为 DOM 问题而失败');
      
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await this.page.evaluate(() => {
            // 再次检查 LODOP 对象
            const lodop = window.LODOP || (typeof window.getCLodop === 'function' ? window.getCLodop() : null);
            if (!lodop) {
              throw new Error('LODOP object not available');
            }

            if (typeof lodop.Create_Printer_List !== 'function') {
              throw new Error('Create_Printer_List method not available');
            }

            // 确保页面有完整的 DOM 结构
            if (!document.body) {
              throw new Error('Document body not ready');
            }

            // 验证必要的 DOM 元素存在
            const lodopOb = document.getElementById('LODOP_OB');
            if (!lodopOb) {
              throw new Error('LODOP_OB container not found');
            }

            // 确保容器有内容（C-Lodop 的 Create_Printer_List 可能需要访问 childNodes）
            if (lodopOb.childNodes.length === 0) {
              // 创建一个空的 div，确保 childNodes 不为空
              const emptyDiv = document.createElement('div');
              emptyDiv.style.display = 'none';
              lodopOb.appendChild(emptyDiv);
            }

            try {
              const result = lodop.Create_Printer_List();
              return result;
            } catch (e) {
              // 如果是 DOM 相关的错误，提供更详细的错误信息
              if (e.message && (e.message.includes('childNodes') || e.message.includes('undefined'))) {
                throw new Error(`DOM not ready: ${e.message}`);
              }
              throw e;
            }
          });

          // 如果成功获取到结果，返回
          if (result !== undefined && result !== null && Array.isArray(result) && result.length > 0) {
            this.cachedPrinters = result;
            this.gettingPrinters = false;
            return result;
          }
        } catch (error) {
          lastError = error;
          console.log(`获取打印机列表尝试 ${attempt + 1}/3 失败:`, error.message);
          
          // 如果不是最后一次尝试，等待后重试
          if (attempt < 2) {
            await this.page.waitForTimeout(2000);
            // 再次尝试初始化
            try {
              const retryInitId = `retry-init-${Date.now()}`;
              await this.invoke('PRINT_INIT', ['重试初始化', retryInitId], retryInitId);
              await this.page.waitForTimeout(1000);
            } catch (retryInitError) {
              // 忽略初始化错误
            }
            
            // 重新检查 LODOP 对象状态
            try {
              await this.page.waitForFunction(() => {
                const lodop = window.LODOP || (typeof window.getCLodop === 'function' ? window.getCLodop() : null);
                return lodop && typeof lodop.Create_Printer_List === 'function';
              }, { timeout: 5000 });
            } catch (waitError) {
              console.error('等待 LODOP 对象超时:', waitError);
            }
          }
        }
      }

      // 所有重试都失败
      if (lastError) {
        console.error('获取打印机列表失败（已重试3次）:', lastError.message);
        // 返回空数组而不是抛出错误，以便前端可以正常处理
        result = [];
      }

      // 缓存结果
      this.cachedPrinters = result;
      this.gettingPrinters = false;
      return result;
    } catch (error) {
      console.error('获取打印机列表时发生错误:', error);
      this.gettingPrinters = false;
      // 返回空数组而不是抛出错误，以便前端可以正常处理
      return [];
    }
  }

  // 测试打印
  async testPrint(printerName = null) {
    const clientCallId = `test-${Date.now()}`;
    
    return await this.invoke('PRINT_INIT', ['测试打印', clientCallId], clientCallId).then(() => {
      // 如果指定了打印机，设置打印机
      if (printerName) {
        // 使用缓存的打印机列表，避免重复调用
        const printers = this.cachedPrinters || [];
        const printerIndex = printers.findIndex(p => p === printerName);
        if (printerIndex >= 0) {
          // LODOP 的打印机索引从 1 开始
          return this.invoke('SET_PRINTER_INDEX', [printerIndex + 1], `test-${Date.now()}`);
        } else {
          console.warn(`未找到打印机: ${printerName}，使用默认打印机`);
          return Promise.resolve();
        }
      }
      return Promise.resolve();
    }).then(() => {
      return this.invoke('SET_PRINT_PAGESIZE', [1, 'A4', '', ''], `test-${Date.now()}`);
    }).then(() => {
      return this.invoke('ADD_PRINT_TEXT', [10, 10, 200, 30, '这是测试打印内容'], `test-${Date.now()}`);
    }).then(() => {
      return this.invoke('ADD_PRINT_TEXT', [10, 50, 200, 30, '测试中文多行文本'], `test-${Date.now()}`);
    }).then(() => {
      return this.invoke('ADD_PRINT_TEXT', [10, 90, 200, 30, '第二行测试内容'], `test-${Date.now()}`);
    }).then(() => {
      return this.invoke('PRINT', [], `test-${Date.now()}`);
    });
  }

  // 通过 WebSocket 测试打印（使用用户提供的消息格式）
  async testPrintViaWebSocket(proxyPort = 8000) {
    return new Promise((resolve, reject) => {
      const wsUrl = `ws://localhost:${proxyPort}/c_webskt/`;
      console.log(`[HeadlessBridge] 正在连接到 WebSocket: ${wsUrl}`);
      
      const ws = new WebSocket(wsUrl);
      
      // 用户提供的完整 WebSocket 消息
      const message = `post:charset=丂tid=08AAAC3141320_1act=printbrowseurl=https://gl-sino-dev-frontend.ztoky.cn/waybill/form?mode=view&ewbNo=VN000000009963companyname=上海丞风智能科技有限公司license=4CF0AC779D3B7FA74B07D2F896DA02A6licensea=licenseb=top=left=width=height=printtask=orient=1pagewidth=760pageheight=1000pagename=中通快运pos_baseon_paper=trueprintmodenames=;pos_baseon_paperitemcount=41_itemstylenames=;fontname;alignment;bold;fontsize;content1_beginpage=01_beginpagea=01_fontname=微软雅黑1_alignment=31_bold=11_fontsize=151_type=21_top=3mm1_left=23mm1_width=50mm1_height=7mm1_content=571-093-9992_itemstylenames=;fontname;alignment;bold;fontsize;content2_beginpage=02_beginpagea=02_fontname=微软雅黑2_alignment=32_bold=12_fontsize=152_type=62_top=10mm2_left=3mm2_width=70mm2_height=88mm2_content=<style>    * {        font-size: 10px;        line-height: 1.2;        font-family: 微软雅黑;    }    table {        width: 100%;        height: 100%;        border-collapse: collapse;    }    td {        border: 1px solid black;        text-align: center;        width: 25%;        padding: 0 3px;    }    table.inner {        height: 100%;    }    table.inner td {        border-top-width: 0;        border-left-width: 0;    }    table.inner td:last-child {        border-right: 0;    }    table.inner tr:last-child td,    table.inner td[rowspan] {        border-bottom-width: 0;    }    .s1 {        font-size: 14px;        font-weight: bold;        border-top-width: 0;        border-bottom-width: 0;    }    .s2 {        font-size: 14px;        font-weight: bold;    }    .s3 {        font-size: 13px;    }    .s4 {        font-size: 24px;        font-weight: bold;        border-top-width: 0;        border-bottom-width: 0;    }    .b1 {        background: black;        color: white;    }    .b2 {        border-right-color: white;    }    .f1 {        font-size: 18px;        border-left-color: white;    }    .b3 {        background: black;        color: white;    }    td.left {        text-align: left;    }    .b4 {        font-weight:bold;    }    .pieceDiv {        width:90%;        border-bottom:1px solid #000;        margin-left:4%;    }    .pieceName {        font-size:9px;        text-align:left;        display:inline-block;        width:20%;    }    .pieceNum {        text-align:center;        display:inline-block;        width:80%;    }    .pieceSmall {        font-size:9px;    }    .pieceBig {        font-size:16px;    }</style><table>    <tr style="height:18%;"><td colspan="4" style="vertical-align:bottom;font-size:15px;padding:0;border-top: 0;border-left: 0;border-right: 0;">ZY800006966834 0001 0001</td>    </tr>    <tr style="height:8%;">        <td class="s1">广州</td>        <td class="s1">杭州2</td>        <td class="s1"></td>        <td class="s1"></td>    </tr>    <tr style="height:8%;">        <td class="s4">A44</td>        <td class="s4">V01</td>        <td class="s4"></td>        <td class="s4"></td>    </tr>    <tr style="height:21%;">        <td colspan="4" style="font-size:12px;font-weight:lighter;text-align:left;vertical-align:top;padding-top: 2px;">【自提】浙江省嘉兴市海宁市海宁市康桥名城【收件人】测试余【送货方式】网点自提</td>    </tr>    <tr style="height:29%;">        <td colspan="4" style="padding:0;">            <table class="inner">                <tr style="height:60%">                    <td style="width:40%;" class="s2">海宁四部</td>                    <td rowspan="3" style="width: 35%;"></td>                    <td style="width: 25%;"></td>                </tr>                <tr style="height:20%">                    <td class="b4">1.0kg/0.01m³</td>                    <td rowspan="2" class="b4">                        <div>                           <div class="pieceDiv"><span class="pieceName">件：</span><span class="pieceNum pieceSmall">1</span></div>                           <div class="pieceDiv" style="border:none;"><span class="pieceName">数：</span><span class="pieceNum pieceBig">1</span></div>                        </div>                    </td>                </tr>                <tr style="height:20%">                    <td class="b4" style="border-right: 1px solid #000;">非标  |  快运小件</td>                </tr>            </table>        </td>    </tr>    <tr>        <td colspan="2" class=" b4">IT测试一级派件部W</td>        <td colspan="2">纸箱</td>    </tr>    <tr>        <td colspan="2" class="left" style="height:5%;">            郝几才 打印1次        </td>        <td colspan="2" rowspan="2"  style="text-align:left;vertical-align:top;padding-top: 2px;">测试</td>    </tr>    <tr>        <td colspan="2" class="left" >            2026-01-23 14:13:20        </td>    </tr></table>3_itemstylenames=;fontname;alignment;bold;fontsize;content;showbartext3_beginpage=03_beginpagea=03_fontname=128Auto3_alignment=33_bold=13_fontsize=153_type=93_top=11mm3_left=5mm3_width=68mm3_height=10mm3_content=ZY800006966834000100013_showbartext=04_itemstylenames=;fontname;alignment;bold;fontsize;content;qrcodeversion;datacharset4_beginpage=04_beginpagea=04_fontname=QRCode4_alignment=34_bold=14_fontsize=154_type=94_top=59mm4_left=31.4mm4_width=25mm4_height=25mm4_content=ZTOKY={"k1":"571","k2":"093","k3":"999","k4":"ZY80000696683400010001","k5":"快运小件"}4_qrcodeversion=74_datacharset=UTF-8count_itemstylenames=`;
      
      let messageSent = false;
      let responseReceived = false;
      
      ws.on('open', () => {
        console.log(`[HeadlessBridge] ✅ WebSocket 连接已建立: ${wsUrl}`);
        console.log(`[HeadlessBridge] 📤 准备发送打印消息...`);
        console.log(`[HeadlessBridge] 消息长度: ${message.length} 字符`);
        console.log(`[HeadlessBridge] 消息预览: ${message.substring(0, 200)}...`);
        
        // 检查消息格式
        if (message.startsWith('post:')) {
          console.log(`[HeadlessBridge] ✅ 消息格式正确：包含 "post:" 前缀`);
        } else {
          console.log(`[HeadlessBridge] ⚠️  消息格式异常：缺少 "post:" 前缀`);
        }
        
        // 检查分隔符
        const delimiterCount = (message.match(/\f\f/g) || []).length;
        console.log(`[HeadlessBridge] 🔍 检测到分隔符 \\f\\f: ${delimiterCount} 处`);
        
        // 解析关键参数
        const taskIdMatch = message.match(/tid=([A-Z0-9_]+)/);
        if (taskIdMatch) {
          console.log(`[HeadlessBridge] 🔍 检测到 TaskID: ${taskIdMatch[1]}`);
        }
        
        const actMatch = message.match(/act=([^\s\n\f&]+)/);
        if (actMatch) {
          console.log(`[HeadlessBridge] 🔍 检测到 act: ${actMatch[1]}`);
        }
        
        const browseurlMatch = message.match(/browseurl=([^\s\n\f]+)/);
        if (browseurlMatch) {
          console.log(`[HeadlessBridge] 🔍 检测到 browseurl: ${browseurlMatch[1]}`);
        }
        
        try {
          ws.send(message);
          messageSent = true;
          console.log(`[HeadlessBridge] ✅ 打印消息已发送到 WebSocket`);
        } catch (err) {
          console.error(`[HeadlessBridge] ❌ 发送消息失败:`, err);
          reject(err);
        }
      });
      
      ws.on('message', (data, isBinary) => {
        const responseStr = isBinary ? data.toString('utf8') : data.toString();
        responseReceived = true;
        console.log(`[HeadlessBridge] 📥 收到 WebSocket 响应:`);
        console.log(`[HeadlessBridge] 完整响应内容: ${responseStr}`);
        console.log(`[HeadlessBridge] 响应长度: ${responseStr.length} 字符`);
        console.log(`[HeadlessBridge] 是否为二进制: ${isBinary}`);
        
        // 检查响应格式
        if (responseStr.includes('=true')) {
          const taskIdMatch = responseStr.match(/([A-Z0-9_]+)=true/);
          if (taskIdMatch) {
            const taskId = taskIdMatch[1];
            console.log(`[HeadlessBridge] ⚠️  打印请求已收到 (TaskID: ${taskId})，返回 true 表示请求已接收`);
            console.log(`[HeadlessBridge] ⚠️  但 C-Lodop 还需要访问 browseurl 来获取打印内容`);
          }
        }
        
        // 等待一段时间后关闭连接并返回结果
        setTimeout(() => {
          ws.close();
          resolve({
            success: true,
            message: 'WebSocket 打印消息已发送',
            response: responseStr,
            messageSent,
            responseReceived
          });
        }, 2000);
      });
      
      ws.on('error', (error) => {
        console.error(`[HeadlessBridge] ❌ WebSocket 连接错误:`, error);
        reject(error);
      });
      
      ws.on('close', (code, reason) => {
        console.log(`[HeadlessBridge] WebSocket 连接已关闭: code=${code}, reason=${reason || 'no reason'}`);
        if (!responseReceived && messageSent) {
          // 如果消息已发送但没有收到响应，也认为成功（可能是异步响应）
          resolve({
            success: true,
            message: 'WebSocket 打印消息已发送（未收到响应）',
            messageSent,
            responseReceived: false
          });
        }
      });
      
      // 设置超时
      setTimeout(() => {
        if (!messageSent) {
          ws.close();
          reject(new Error('WebSocket 连接超时：无法建立连接'));
        } else if (!responseReceived) {
          ws.close();
          resolve({
            success: true,
            message: 'WebSocket 打印消息已发送（响应超时）',
            messageSent,
            responseReceived: false
          });
        }
      }, 10000);
    });
  }

  // 解绑
  async unbind() {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    this.boundHost = null;
  }

  // 关闭浏览器
  async close() {
    await this.unbind();
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.isReady = false;
  }

  // 检查连接状态
  async checkStatus() {
    if (!this.page || !this.boundHost) {
      return { online: false, error: 'No host bound' };
    }

    try {
      const response = await this.page.evaluate(() => {
        return typeof window.LODOP !== 'undefined';
      });
      return { online: response, error: null };
    } catch (error) {
      return { online: false, error: error.message };
    }
  }
}

module.exports = HeadlessBridge;
