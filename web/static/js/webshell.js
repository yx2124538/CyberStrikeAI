// WebShell 管理（类似冰蝎/蚁剑：虚拟终端、文件管理、命令执行）

const WEBSHELL_SIDEBAR_WIDTH_KEY = 'webshell_sidebar_width';
const WEBSHELL_DEFAULT_SIDEBAR_WIDTH = 360;
const WEBSHELL_PROMPT = 'shell> ';
let webshellConnections = [];
let currentWebshellId = null;
let webshellTerminalInstance = null;
let webshellTerminalFitAddon = null;
let webshellTerminalResizeObserver = null;
let webshellTerminalResizeContainer = null;
let webshellCurrentConn = null;
let webshellLineBuffer = '';
let webshellRunning = false;
// 按连接保存命令历史，用于上下键
let webshellHistoryByConn = {};
let webshellHistoryIndex = -1;
const WEBSHELL_HISTORY_MAX = 100;

// 从服务端（SQLite）拉取连接列表
function getWebshellConnections() {
    if (typeof apiFetch === 'undefined') {
        return Promise.resolve([]);
    }
    return apiFetch('/api/webshell/connections', { method: 'GET' })
        .then(function (r) { return r.json(); })
        .then(function (list) { return Array.isArray(list) ? list : []; })
        .catch(function (e) {
            console.warn('读取 WebShell 连接列表失败', e);
            return [];
        });
}

// 从服务端刷新连接列表并重绘侧栏
function refreshWebshellConnectionsFromServer() {
    return getWebshellConnections().then(function (list) {
        webshellConnections = list;
        renderWebshellList();
        return list;
    });
}

// 使用 wsT 避免与全局 window.t 冲突导致无限递归
function wsT(key) {
    var globalT = typeof window !== 'undefined' ? window.t : null;
    if (typeof globalT === 'function' && globalT !== wsT) return globalT(key);
    var fallback = {
        'webshell.title': 'WebShell 管理',
        'webshell.addConnection': '添加连接',
        'webshell.cmdParam': '命令参数名',
        'webshell.cmdParamPlaceholder': '不填默认为 cmd，如填 xxx 则请求为 xxx=命令',
        'webshell.connections': '连接列表',
        'webshell.noConnections': '暂无连接，请点击「添加连接」',
        'webshell.selectOrAdd': '请从左侧选择连接，或添加新的 WebShell 连接',
        'webshell.deleteConfirm': '确定要删除该连接吗？',
        'webshell.editConnection': '编辑',
        'webshell.editConnectionTitle': '编辑连接',
        'webshell.tabTerminal': '虚拟终端',
        'webshell.tabFileManager': '文件管理',
        'webshell.terminalWelcome': 'WebShell 虚拟终端 — 输入命令后按回车执行（Ctrl+L 清屏）',
        'webshell.quickCommands': '快捷命令',
        'webshell.downloadFile': '下载',
        'webshell.filePath': '当前路径',
        'webshell.listDir': '列出目录',
        'webshell.readFile': '读取',
        'webshell.editFile': '编辑',
        'webshell.deleteFile': '删除',
        'webshell.saveFile': '保存',
        'webshell.cancelEdit': '取消',
        'webshell.parentDir': '上级目录',
        'webshell.execError': '执行失败',
        'webshell.testConnectivity': '测试连通性',
        'webshell.testSuccess': '连通性正常，Shell 可访问',
        'webshell.testFailed': '连通性测试失败',
        'webshell.testNoExpectedOutput': 'Shell 返回了响应但未得到预期输出，请检查连接密码与命令参数名',
        'webshell.clearScreen': '清屏',
        'webshell.running': '执行中…',
        'webshell.waitFinish': '请等待当前命令执行完成',
        'webshell.newDir': '新建目录',
        'webshell.rename': '重命名',
        'webshell.upload': '上传',
        'webshell.newFile': '新建文件',
        'webshell.filterPlaceholder': '过滤文件名',
        'webshell.batchDelete': '批量删除',
        'webshell.batchDownload': '批量下载',
        'webshell.refresh': '刷新',
        'webshell.selectAll': '全选',
        'webshell.breadcrumbHome': '根',
        'common.delete': '删除',
        'common.refresh': '刷新'
    };
    return fallback[key] || key;
}

// 初始化 WebShell 管理页面（从 SQLite 拉取连接列表）
function initWebshellPage() {
    destroyWebshellTerminal();
    webshellCurrentConn = null;
    currentWebshellId = null;
    webshellConnections = [];
    renderWebshellList();
    applyWebshellSidebarWidth();
    initWebshellSidebarResize();
    const workspace = document.getElementById('webshell-workspace');
    if (workspace) {
        workspace.innerHTML = '<div class="webshell-workspace-placeholder" data-i18n="webshell.selectOrAdd">' + (wsT('webshell.selectOrAdd')) + '</div>';
    }
    getWebshellConnections().then(function (list) {
        webshellConnections = list;
        renderWebshellList();
    });
}

function getWebshellSidebarWidth() {
    try {
        const w = parseInt(localStorage.getItem(WEBSHELL_SIDEBAR_WIDTH_KEY), 10);
        if (!isNaN(w) && w >= 260 && w <= 800) return w;
    } catch (e) {}
    return WEBSHELL_DEFAULT_SIDEBAR_WIDTH;
}

function setWebshellSidebarWidth(px) {
    localStorage.setItem(WEBSHELL_SIDEBAR_WIDTH_KEY, String(px));
}

function applyWebshellSidebarWidth() {
    const sidebar = document.getElementById('webshell-sidebar');
    if (sidebar) sidebar.style.width = getWebshellSidebarWidth() + 'px';
}

function initWebshellSidebarResize() {
    const handle = document.getElementById('webshell-resize-handle');
    const sidebar = document.getElementById('webshell-sidebar');
    if (!handle || !sidebar || handle.dataset.resizeBound === '1') return;
    handle.dataset.resizeBound = '1';
    let startX = 0, startW = 0;
    function onMove(e) {
        const dx = e.clientX - startX;
        let w = Math.round(startW + dx);
        const min = 260;
        const max = Math.min(800, Math.floor((sidebar.parentElement && sidebar.parentElement.offsetWidth || 800) * 0.6));
        w = Math.max(min, Math.min(max, w));
        sidebar.style.width = w + 'px';
    }
    function onUp() {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        setWebshellSidebarWidth(parseInt(sidebar.style.width, 10) || WEBSHELL_DEFAULT_SIDEBAR_WIDTH);
    }
    handle.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        startX = e.clientX;
        startW = sidebar.offsetWidth;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// 销毁当前终端实例（切换连接或离开页面时）
function destroyWebshellTerminal() {
    if (webshellTerminalResizeObserver && webshellTerminalResizeContainer) {
        try { webshellTerminalResizeObserver.unobserve(webshellTerminalResizeContainer); } catch (e) {}
        webshellTerminalResizeObserver = null;
        webshellTerminalResizeContainer = null;
    }
    if (webshellTerminalInstance) {
        try {
            webshellTerminalInstance.dispose();
        } catch (e) {}
        webshellTerminalInstance = null;
    }
    webshellTerminalFitAddon = null;
    webshellLineBuffer = '';
    webshellRunning = false;
}

// 渲染连接列表
function renderWebshellList() {
    const listEl = document.getElementById('webshell-list');
    if (!listEl) return;

    if (!webshellConnections.length) {
        listEl.innerHTML = '<div class="webshell-empty" data-i18n="webshell.noConnections">' + (wsT('webshell.noConnections')) + '</div>';
        return;
    }

    listEl.innerHTML = webshellConnections.map(conn => {
        const remark = (conn.remark || conn.url || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const url = (conn.url || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const urlTitle = (conn.url || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const active = currentWebshellId === conn.id ? ' active' : '';
        const safeId = escapeHtml(conn.id);
        return (
            '<div class="webshell-item' + active + '" data-id="' + safeId + '">' +
            '<div class="webshell-item-remark" title="' + urlTitle + '">' + remark + '</div>' +
            '<div class="webshell-item-url" title="' + urlTitle + '">' + url + '</div>' +
            '<div class="webshell-item-actions">' +
            '<button type="button" class="btn-ghost btn-sm webshell-edit-conn-btn" data-id="' + safeId + '" title="' + wsT('webshell.editConnection') + '">' + wsT('webshell.editConnection') + '</button> ' +
            '<button type="button" class="btn-ghost btn-sm webshell-delete-btn" data-id="' + safeId + '" title="' + wsT('common.delete') + '">' + wsT('common.delete') + '</button>' +
            '</div>' +
            '</div>'
        );
    }).join('');

    listEl.querySelectorAll('.webshell-item').forEach(el => {
        el.addEventListener('click', function (e) {
            if (e.target.closest('.webshell-delete-btn') || e.target.closest('.webshell-edit-conn-btn')) return;
            selectWebshell(el.getAttribute('data-id'));
        });
    });
    listEl.querySelectorAll('.webshell-edit-conn-btn').forEach(btn => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            showEditWebshellModal(btn.getAttribute('data-id'));
        });
    });
    listEl.querySelectorAll('.webshell-delete-btn').forEach(btn => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            deleteWebshell(btn.getAttribute('data-id'));
        });
    });
}

function escapeHtml(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

// 选择连接：渲染终端 + 文件管理 Tab，并初始化终端
function selectWebshell(id) {
    currentWebshellId = id;
    renderWebshellList();
    const conn = webshellConnections.find(c => c.id === id);
    const workspace = document.getElementById('webshell-workspace');
    if (!workspace) return;
    if (!conn) {
        workspace.innerHTML = '<div class="webshell-workspace-placeholder">' + wsT('webshell.selectOrAdd') + '</div>';
        return;
    }

    destroyWebshellTerminal();
    webshellCurrentConn = conn;

    workspace.innerHTML =
        '<div class="webshell-tabs">' +
        '<button type="button" class="webshell-tab active" data-tab="terminal">' + wsT('webshell.tabTerminal') + '</button>' +
        '<button type="button" class="webshell-tab" data-tab="file">' + wsT('webshell.tabFileManager') + '</button>' +
        '</div>' +
        '<div id="webshell-pane-terminal" class="webshell-pane active">' +
        '<div class="webshell-terminal-toolbar">' +
        '<button type="button" class="btn-ghost btn-sm" id="webshell-terminal-clear" title="' + (wsT('webshell.clearScreen') || '清屏') + '">' + (wsT('webshell.clearScreen') || '清屏') + '</button> ' +
        '<span class="webshell-quick-label">' + (wsT('webshell.quickCommands') || '快捷命令') + ':</span> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="whoami">whoami</button> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="id">id</button> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="pwd">pwd</button> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="ls -la">ls -la</button> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="uname -a">uname -a</button> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="ifconfig">ifconfig</button> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="ip a">ip a</button> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="env">env</button> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="hostname">hostname</button> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="ps aux">ps aux</button> ' +
        '<button type="button" class="btn-ghost btn-sm webshell-quick-cmd" data-cmd="netstat -tulnp">netstat</button>' +
        '</div>' +
        '<div id="webshell-terminal-container" class="webshell-terminal-container"></div>' +
        '</div>' +
        '<div id="webshell-pane-file" class="webshell-pane">' +
        '<div class="webshell-file-toolbar">' +
        '<div class="webshell-file-breadcrumb" id="webshell-file-breadcrumb"></div>' +
        '<label><span>' + wsT('webshell.filePath') + '</span> <input type="text" id="webshell-file-path" class="form-control" value="." /></label>' +
        '<input type="text" id="webshell-file-filter" class="form-control webshell-file-filter" placeholder="' + (wsT('webshell.filterPlaceholder') || '过滤文件名') + '" />' +
        '<button type="button" class="btn-secondary" id="webshell-list-dir">' + wsT('webshell.listDir') + '</button> ' +
        '<button type="button" class="btn-ghost" id="webshell-parent-dir">' + wsT('webshell.parentDir') + '</button> ' +
        '<button type="button" class="btn-ghost" id="webshell-file-refresh" title="' + (wsT('webshell.refresh') || '刷新') + '">' + (wsT('webshell.refresh') || '刷新') + '</button> ' +
        '<button type="button" class="btn-ghost" id="webshell-mkdir-btn">' + (wsT('webshell.newDir') || '新建目录') + '</button> ' +
        '<button type="button" class="btn-ghost" id="webshell-newfile-btn">' + (wsT('webshell.newFile') || '新建文件') + '</button> ' +
        '<button type="button" class="btn-ghost" id="webshell-upload-btn">' + (wsT('webshell.upload') || '上传') + '</button> ' +
        '<button type="button" class="btn-ghost" id="webshell-batch-delete-btn">' + (wsT('webshell.batchDelete') || '批量删除') + '</button> ' +
        '<button type="button" class="btn-ghost" id="webshell-batch-download-btn">' + (wsT('webshell.batchDownload') || '批量下载') + '</button>' +
        '</div>' +
        '<div id="webshell-file-list" class="webshell-file-list"></div>' +
        '</div>';

    // Tab 切换
    workspace.querySelectorAll('.webshell-tab').forEach(btn => {
        btn.addEventListener('click', function () {
            const tab = btn.getAttribute('data-tab');
            workspace.querySelectorAll('.webshell-tab').forEach(b => b.classList.remove('active'));
            workspace.querySelectorAll('.webshell-pane').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const pane = document.getElementById('webshell-pane-' + tab);
            if (pane) pane.classList.add('active');
            if (tab === 'terminal' && webshellTerminalInstance && webshellTerminalFitAddon) {
                try { webshellTerminalFitAddon.fit(); } catch (e) {}
            }
        });
    });

    // 文件管理：列出目录、上级目录
    const pathInput = document.getElementById('webshell-file-path');
    document.getElementById('webshell-list-dir').addEventListener('click', function () {
        // 点击时用当前连接，编辑保存后立即生效
        webshellFileListDir(webshellCurrentConn, pathInput ? pathInput.value.trim() || '.' : '.');
    });
    document.getElementById('webshell-parent-dir').addEventListener('click', function () {
        const p = (pathInput && pathInput.value.trim()) || '.';
        if (p === '.' || p === '/') {
            pathInput.value = '..';
        } else {
            pathInput.value = p.replace(/\/[^/]+$/, '') || '.';
        }
        webshellFileListDir(webshellCurrentConn, pathInput.value || '.');
    });

    // 清屏
    var clearBtn = document.getElementById('webshell-terminal-clear');
    if (clearBtn) clearBtn.addEventListener('click', function () {
        if (webshellTerminalInstance) {
            webshellTerminalInstance.clear();
            webshellLineBuffer = '';
            webshellTerminalInstance.write(WEBSHELL_PROMPT);
        }
    });
    // 快捷命令：点击后执行并输出到终端
    workspace.querySelectorAll('.webshell-quick-cmd').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var cmd = btn.getAttribute('data-cmd');
            if (cmd) runQuickCommand(cmd);
        });
    });
    // 文件：刷新、新建目录、新建文件、上传、批量操作
    var filterInput = document.getElementById('webshell-file-filter');
    document.getElementById('webshell-file-refresh').addEventListener('click', function () {
        webshellFileListDir(webshellCurrentConn, pathInput ? pathInput.value.trim() || '.' : '.');
    });
    if (filterInput) filterInput.addEventListener('input', function () {
        webshellFileListApplyFilter();
    });
    document.getElementById('webshell-mkdir-btn').addEventListener('click', function () { webshellFileMkdir(webshellCurrentConn, pathInput); });
    document.getElementById('webshell-newfile-btn').addEventListener('click', function () { webshellFileNewFile(webshellCurrentConn, pathInput); });
    document.getElementById('webshell-upload-btn').addEventListener('click', function () { webshellFileUpload(webshellCurrentConn, pathInput); });
    document.getElementById('webshell-batch-delete-btn').addEventListener('click', function () { webshellBatchDelete(webshellCurrentConn, pathInput); });
    document.getElementById('webshell-batch-download-btn').addEventListener('click', function () { webshellBatchDownload(webshellCurrentConn, pathInput); });

    initWebshellTerminal(conn);
}

function getWebshellHistory(connId) {
    if (!connId) return [];
    if (!webshellHistoryByConn[connId]) webshellHistoryByConn[connId] = [];
    return webshellHistoryByConn[connId];
}
function pushWebshellHistory(connId, cmd) {
    if (!connId || !cmd) return;
    if (!webshellHistoryByConn[connId]) webshellHistoryByConn[connId] = [];
    var h = webshellHistoryByConn[connId];
    if (h[h.length - 1] === cmd) return;
    h.push(cmd);
    if (h.length > WEBSHELL_HISTORY_MAX) h.shift();
}

// 执行快捷命令并将输出写入当前终端
function runQuickCommand(cmd) {
    if (!webshellCurrentConn || !webshellTerminalInstance) return;
    if (webshellRunning) return;
    var term = webshellTerminalInstance;
    term.writeln('');
    pushWebshellHistory(webshellCurrentConn.id, cmd);
    webshellRunning = true;
    execWebshellCommand(webshellCurrentConn, cmd).then(function (out) {
        var s = String(out || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        s.split('\n').forEach(function (line) { term.writeln(line.replace(/\r/g, '')); });
        term.write(WEBSHELL_PROMPT);
    }).catch(function (err) {
        term.writeln('\x1b[31m' + (err && err.message ? err.message : wsT('webshell.execError')) + '\x1b[0m');
        term.write(WEBSHELL_PROMPT);
    }).finally(function () { webshellRunning = false; });
}

// ---------- 虚拟终端（xterm + 按行执行） ----------
function initWebshellTerminal(conn) {
    const container = document.getElementById('webshell-terminal-container');
    if (!container || typeof Terminal === 'undefined') {
        if (container) {
            container.innerHTML = '<p class="terminal-error">' + escapeHtml('未加载 xterm.js，请刷新页面') + '</p>';
        }
        return;
    }

    const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'underline',
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        lineHeight: 1.2,
        scrollback: 2000,
        theme: {
            background: '#0d1117',
            foreground: '#e6edf3',
            cursor: '#58a6ff',
            cursorAccent: '#0d1117',
            selection: 'rgba(88, 166, 255, 0.3)'
        }
    });

    let fitAddon = null;
    if (typeof FitAddon !== 'undefined') {
        const FitCtor = FitAddon.FitAddon || FitAddon;
        fitAddon = new FitCtor();
        term.loadAddon(fitAddon);
    }

    term.open(container);
    // 先 fit 再写内容，避免未计算尺寸时光标/画布错位挡住文字
    try {
        if (fitAddon) fitAddon.fit();
    } catch (e) {}
    // 不再输出欢迎行，避免占用空间、挡住输入
    term.write(WEBSHELL_PROMPT);

    // 按行写入输出，与系统设置终端 writeOutput 一致，避免 ls 等输出错位
    function writeWebshellOutput(term, text, isError) {
        if (!term || !text) return;
        var s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var lines = s.split('\n');
        var prefix = isError ? '\x1b[31m' : '';
        var suffix = isError ? '\x1b[0m' : '';
        term.write(prefix);
        for (var i = 0; i < lines.length; i++) {
            term.writeln(lines[i].replace(/\r/g, ''));
        }
        term.write(suffix);
    }

    term.onData(function (data) {
        // Ctrl+L 清屏
        if (data === '\x0c') {
            term.clear();
            webshellLineBuffer = '';
            webshellHistoryIndex = -1;
            term.write(WEBSHELL_PROMPT);
            return;
        }
        // 上/下键：命令历史
        if (data === '\x1b[A' || data === '\x1bOA') {
            var hist = getWebshellHistory(webshellCurrentConn ? webshellCurrentConn.id : '');
            if (hist.length === 0) return;
            webshellHistoryIndex = webshellHistoryIndex < 0 ? hist.length : Math.max(0, webshellHistoryIndex - 1);
            webshellLineBuffer = hist[webshellHistoryIndex] || '';
            term.write('\x1b[2K\r' + WEBSHELL_PROMPT + webshellLineBuffer);
            return;
        }
        if (data === '\x1b[B' || data === '\x1bOB') {
            var hist2 = getWebshellHistory(webshellCurrentConn ? webshellCurrentConn.id : '');
            if (hist2.length === 0) return;
            webshellHistoryIndex = webshellHistoryIndex < 0 ? -1 : Math.min(hist2.length - 1, webshellHistoryIndex + 1);
            if (webshellHistoryIndex < 0) webshellLineBuffer = '';
            else webshellLineBuffer = hist2[webshellHistoryIndex] || '';
            term.write('\x1b[2K\r' + WEBSHELL_PROMPT + webshellLineBuffer);
            return;
        }
        // 回车：发送当前行到后端执行
        if (data === '\r' || data === '\n') {
            term.writeln('');
            var cmd = webshellLineBuffer.trim();
            webshellLineBuffer = '';
            webshellHistoryIndex = -1;
            if (cmd) {
                if (webshellRunning) {
                    writeWebshellOutput(term, wsT('webshell.waitFinish'), true);
                    term.write(WEBSHELL_PROMPT);
                    return;
                }
                pushWebshellHistory(webshellCurrentConn ? webshellCurrentConn.id : '', cmd);
                webshellRunning = true;
                execWebshellCommand(webshellCurrentConn, cmd).then(function (out) {
                    webshellRunning = false;
                    if (out && out.length) writeWebshellOutput(term, out, false);
                    term.write(WEBSHELL_PROMPT);
                }).catch(function (err) {
                    webshellRunning = false;
                    writeWebshellOutput(term, err && err.message ? err.message : wsT('webshell.execError'), true);
                    term.write(WEBSHELL_PROMPT);
                });
            } else {
                term.write(WEBSHELL_PROMPT);
            }
            return;
        }
        // 多行粘贴：按行依次执行
        if (data.indexOf('\n') !== -1 || data.indexOf('\r') !== -1) {
            var full = (webshellLineBuffer + data).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            var lines = full.split('\n');
            webshellLineBuffer = lines.pop() || '';
            if (lines.length > 0 && !webshellRunning && webshellCurrentConn) {
                var runNext = function (idx) {
                    if (idx >= lines.length) {
                        term.write(WEBSHELL_PROMPT + webshellLineBuffer);
                        return;
                    }
                    var line = lines[idx].trim();
                    if (!line) { runNext(idx + 1); return; }
                    pushWebshellHistory(webshellCurrentConn.id, line);
                    webshellRunning = true;
                    execWebshellCommand(webshellCurrentConn, line).then(function (out) {
                        if (out && out.length) writeWebshellOutput(term, out, false);
                        webshellRunning = false;
                        runNext(idx + 1);
                    }).catch(function (err) {
                        writeWebshellOutput(term, err && err.message ? err.message : wsT('webshell.execError'), true);
                        webshellRunning = false;
                        runNext(idx + 1);
                    });
                };
                runNext(0);
            } else {
                term.write(data);
            }
            return;
        }
        // 退格
        if (data === '\x7f' || data === '\b') {
            if (webshellLineBuffer.length > 0) {
                webshellLineBuffer = webshellLineBuffer.slice(0, -1);
                term.write('\b \b');
            }
            return;
        }
        webshellLineBuffer += data;
        term.write(data);
    });

    webshellTerminalInstance = term;
    webshellTerminalFitAddon = fitAddon;
    // 延迟再次 fit，确保容器尺寸稳定后光标与文字不错位
    setTimeout(function () {
        try { if (fitAddon) fitAddon.fit(); } catch (e) {}
    }, 100);
    // 容器尺寸变化时重新 fit，避免光标/文字被遮挡
    if (fitAddon && typeof ResizeObserver !== 'undefined' && container) {
        webshellTerminalResizeContainer = container;
        webshellTerminalResizeObserver = new ResizeObserver(function () {
            try { fitAddon.fit(); } catch (e) {}
        });
        webshellTerminalResizeObserver.observe(container);
    }
}

// 调用后端执行命令
function execWebshellCommand(conn, command) {
    return new Promise(function (resolve, reject) {
        if (typeof apiFetch === 'undefined') {
            reject(new Error('apiFetch 未定义'));
            return;
        }
        apiFetch('/api/webshell/exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: conn.url,
                password: conn.password || '',
                type: conn.type || 'php',
                method: (conn.method || 'post').toLowerCase(),
                cmd_param: conn.cmdParam || '',
                command: command
            })
        }).then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.output !== undefined) resolve(data.output || '');
                else if (data && data.error) reject(new Error(data.error));
                else resolve('');
            })
            .catch(reject);
    });
}

// ---------- 文件管理 ----------
function webshellFileListDir(conn, path) {
    const listEl = document.getElementById('webshell-file-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="webshell-loading">' + wsT('common.refresh') + '...</div>';

    if (typeof apiFetch === 'undefined') {
        listEl.innerHTML = '<div class="webshell-file-error">apiFetch 未定义</div>';
        return;
    }

    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: conn.url,
            password: conn.password || '',
            type: conn.type || 'php',
            method: (conn.method || 'post').toLowerCase(),
            cmd_param: conn.cmdParam || '',
            action: 'list',
            path: path
        })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            if (!data.ok && data.error) {
                listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(data.error) + '</div><pre class="webshell-file-raw">' + escapeHtml(data.output || '') + '</pre>';
                return;
            }
            listEl.dataset.currentPath = path;
            listEl.dataset.rawOutput = data.output || '';
            renderFileList(listEl, path, data.output || '', conn);
        })
        .catch(function (err) {
            listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : wsT('webshell.execError')) + '</div>';
        });
}

function renderFileList(listEl, currentPath, rawOutput, conn, nameFilter) {
    var lines = rawOutput.split(/\n/).filter(function (l) { return l.trim(); });
    var items = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var m = line.match(/\s*(\S+)\s*$/);
        var name = m ? m[1].trim() : line.trim();
        if (name === '.' || name === '..') continue;
        var isDir = line.startsWith('d') || line.toLowerCase().indexOf('<dir>') !== -1;
        var size = '';
        var mode = '';
        if (line.startsWith('-') || line.startsWith('d')) {
            var parts = line.split(/\s+/);
            if (parts.length >= 5) { mode = parts[0]; size = parts[4]; }
        }
        items.push({ name: name, isDir: isDir, line: line, size: size, mode: mode });
    }
    if (nameFilter && nameFilter.trim()) {
        var f = nameFilter.trim().toLowerCase();
        items = items.filter(function (item) { return item.name.toLowerCase().indexOf(f) !== -1; });
    }
    // 面包屑
    var breadcrumbEl = document.getElementById('webshell-file-breadcrumb');
    if (breadcrumbEl) {
        var parts = (currentPath === '.' || currentPath === '') ? [] : currentPath.replace(/^\//, '').split('/');
        breadcrumbEl.innerHTML = '<a href="#" class="webshell-breadcrumb-item" data-path=".">' + (wsT('webshell.breadcrumbHome') || '根') + '</a>' +
            parts.map(function (p, idx) {
                var path = parts.slice(0, idx + 1).join('/');
                return ' / <a href="#" class="webshell-breadcrumb-item" data-path="' + escapeHtml(path) + '">' + escapeHtml(p) + '</a>';
            }).join('');
    }
    var html = '';
    if (items.length === 0 && rawOutput.trim() && !nameFilter) {
        html = '<pre class="webshell-file-raw">' + escapeHtml(rawOutput) + '</pre>';
    } else {
        html = '<table class="webshell-file-table"><thead><tr><th class="webshell-col-check"><input type="checkbox" id="webshell-file-select-all" title="' + (wsT('webshell.selectAll') || '全选') + '" /></th><th>' + wsT('webshell.filePath') + '</th><th class="webshell-col-size">大小</th><th></th></tr></thead><tbody>';
        if (currentPath !== '.' && currentPath !== '') {
            html += '<tr><td></td><td><a href="#" class="webshell-file-link" data-path="' + escapeHtml(currentPath.replace(/\/[^/]+$/, '') || '.') + '" data-isdir="1">..</a></td><td></td><td></td></tr>';
        }
        items.forEach(function (item) {
            var pathNext = currentPath === '.' ? item.name : currentPath + '/' + item.name;
            html += '<tr><td class="webshell-col-check">';
            if (!item.isDir) html += '<input type="checkbox" class="webshell-file-cb" data-path="' + escapeHtml(pathNext) + '" />';
            html += '</td><td><a href="#" class="webshell-file-link" data-path="' + escapeHtml(pathNext) + '" data-isdir="' + (item.isDir ? '1' : '0') + '">' + escapeHtml(item.name) + (item.isDir ? '/' : '') + '</a></td><td class="webshell-col-size">' + escapeHtml(item.size) + '</td><td>';
            if (item.isDir) {
                html += '<button type="button" class="btn-ghost btn-sm webshell-file-rename" data-path="' + escapeHtml(pathNext) + '" data-name="' + escapeHtml(item.name) + '">' + (wsT('webshell.rename') || '重命名') + '</button>';
            } else {
                html += '<button type="button" class="btn-ghost btn-sm webshell-file-read" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.readFile') + '</button> ';
                html += '<button type="button" class="btn-ghost btn-sm webshell-file-download" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.downloadFile') + '</button> ';
                html += '<button type="button" class="btn-ghost btn-sm webshell-file-edit" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.editFile') + '</button> ';
                html += '<button type="button" class="btn-ghost btn-sm webshell-file-rename" data-path="' + escapeHtml(pathNext) + '" data-name="' + escapeHtml(item.name) + '">' + (wsT('webshell.rename') || '重命名') + '</button> ';
                html += '<button type="button" class="btn-ghost btn-sm webshell-file-del" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.deleteFile') + '</button>';
            }
            html += '</td></tr>';
        });
        html += '</tbody></table>';
    }
    listEl.innerHTML = html;

    listEl.querySelectorAll('.webshell-file-link').forEach(function (a) {
        a.addEventListener('click', function (e) {
            e.preventDefault();
            const path = a.getAttribute('data-path');
            const isDir = a.getAttribute('data-isdir') === '1';
            const pathInput = document.getElementById('webshell-file-path');
            if (pathInput) pathInput.value = path;
            if (isDir) webshellFileListDir(webshellCurrentConn, path);
            else webshellFileRead(webshellCurrentConn, path, listEl);
        });
    });
    listEl.querySelectorAll('.webshell-file-read').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            webshellFileRead(webshellCurrentConn, btn.getAttribute('data-path'), listEl);
        });
    });
    listEl.querySelectorAll('.webshell-file-download').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            webshellFileDownload(webshellCurrentConn, btn.getAttribute('data-path'));
        });
    });
    listEl.querySelectorAll('.webshell-file-edit').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            webshellFileEdit(webshellCurrentConn, btn.getAttribute('data-path'), listEl);
        });
    });
    listEl.querySelectorAll('.webshell-file-del').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (!confirm(wsT('webshell.deleteConfirm'))) return;
            webshellFileDelete(webshellCurrentConn, btn.getAttribute('data-path'), function () {
                webshellFileListDir(webshellCurrentConn, document.getElementById('webshell-file-path').value.trim() || '.');
            });
        });
    });
    listEl.querySelectorAll('.webshell-file-rename').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            webshellFileRename(webshellCurrentConn, btn.getAttribute('data-path'), btn.getAttribute('data-name'), listEl);
        });
    });
    var selectAll = document.getElementById('webshell-file-select-all');
    if (selectAll) {
        selectAll.addEventListener('change', function () {
            listEl.querySelectorAll('.webshell-file-cb').forEach(function (cb) { cb.checked = selectAll.checked; });
        });
    }
    if (breadcrumbEl) {
        breadcrumbEl.querySelectorAll('.webshell-breadcrumb-item').forEach(function (a) {
            a.addEventListener('click', function (e) {
                e.preventDefault();
                var p = a.getAttribute('data-path');
                var pathInput = document.getElementById('webshell-file-path');
                if (pathInput) pathInput.value = p;
                webshellFileListDir(webshellCurrentConn, p);
            });
        });
    }
}

function webshellFileListApplyFilter() {
    var listEl = document.getElementById('webshell-file-list');
    var path = listEl && listEl.dataset.currentPath ? listEl.dataset.currentPath : (document.getElementById('webshell-file-path') && document.getElementById('webshell-file-path').value.trim()) || '.';
    var raw = listEl && listEl.dataset.rawOutput ? listEl.dataset.rawOutput : '';
    var filterInput = document.getElementById('webshell-file-filter');
    var filter = filterInput ? filterInput.value : '';
    if (!listEl || !raw) return;
    renderFileList(listEl, path, raw, webshellCurrentConn, filter);
}

function webshellFileMkdir(conn, pathInput) {
    if (!conn || typeof apiFetch === 'undefined') return;
    var base = (pathInput && pathInput.value.trim()) || '.';
    var name = prompt(wsT('webshell.newDir') || '新建目录', 'newdir');
    if (name == null || !name.trim()) return;
    var path = base === '.' ? name.trim() : base + '/' + name.trim();
    apiFetch('/api/webshell/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'mkdir', path: path }) })
        .then(function (r) { return r.json(); })
        .then(function () { webshellFileListDir(conn, base); })
        .catch(function () { webshellFileListDir(conn, base); });
}

function webshellFileNewFile(conn, pathInput) {
    if (!conn || typeof apiFetch === 'undefined') return;
    var base = (pathInput && pathInput.value.trim()) || '.';
    var name = prompt(wsT('webshell.newFile') || '新建文件', 'newfile.txt');
    if (name == null || !name.trim()) return;
    var path = base === '.' ? name.trim() : base + '/' + name.trim();
    var content = prompt('初始内容（可选）', '');
    if (content === null) return;
    var listEl = document.getElementById('webshell-file-list');
    webshellFileWrite(conn, path, content || '', function () { webshellFileListDir(conn, base); }, listEl);
}

function webshellFileUpload(conn, pathInput) {
    if (!conn || typeof apiFetch === 'undefined') return;
    var base = (pathInput && pathInput.value.trim()) || '.';
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = false;
    input.onchange = function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            var buf = reader.result;
            var bin = new Uint8Array(buf);
            var CHUNK = 32000;
            var base64Chunks = [];
            for (var i = 0; i < bin.length; i += CHUNK) {
                var slice = bin.subarray(i, Math.min(i + CHUNK, bin.length));
                var b64 = btoa(String.fromCharCode.apply(null, slice));
                base64Chunks.push(b64);
            }
            var path = base === '.' ? file.name : base + '/' + file.name;
            var listEl = document.getElementById('webshell-file-list');
            if (listEl) listEl.innerHTML = '<div class="webshell-loading">' + (wsT('webshell.upload') || '上传') + '...</div>';
            var idx = 0;
            function sendNext() {
                if (idx >= base64Chunks.length) {
                    webshellFileListDir(conn, base);
                    return;
                }
                apiFetch('/api/webshell/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'upload_chunk', path: path, content: base64Chunks[idx], chunk_index: idx }) })
                    .then(function (r) { return r.json(); })
                    .then(function () { idx++; sendNext(); })
                    .catch(function () { idx++; sendNext(); });
            }
            sendNext();
        };
        reader.readAsArrayBuffer(file);
    };
    input.click();
}

function webshellFileRename(conn, oldPath, oldName, listEl) {
    if (!conn || typeof apiFetch === 'undefined') return;
    var newName = prompt((wsT('webshell.rename') || '重命名') + ': ' + oldName, oldName);
    if (newName == null || newName.trim() === '') return;
    var parts = oldPath.split('/');
    var dir = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
    var newPath = dir + newName.trim();
    apiFetch('/api/webshell/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'rename', path: oldPath, target_path: newPath }) })
        .then(function (r) { return r.json(); })
        .then(function () { webshellFileListDir(conn, document.getElementById('webshell-file-path').value.trim() || '.'); })
        .catch(function () { webshellFileListDir(conn, document.getElementById('webshell-file-path').value.trim() || '.'); });
}

function webshellBatchDelete(conn, pathInput) {
    if (!conn) return;
    var listEl = document.getElementById('webshell-file-list');
    var checked = listEl ? listEl.querySelectorAll('.webshell-file-cb:checked') : [];
    var paths = [];
    checked.forEach(function (cb) { paths.push(cb.getAttribute('data-path')); });
    if (paths.length === 0) { alert(wsT('webshell.batchDelete') + '：请先勾选文件'); return; }
    if (!confirm(wsT('webshell.batchDelete') + '：确定删除 ' + paths.length + ' 个文件？')) return;
    var base = (pathInput && pathInput.value.trim()) || '.';
    var i = 0;
    function delNext() {
        if (i >= paths.length) { webshellFileListDir(conn, base); return; }
        webshellFileDelete(conn, paths[i], function () { i++; delNext(); });
    }
    delNext();
}

function webshellBatchDownload(conn, pathInput) {
    if (!conn) return;
    var listEl = document.getElementById('webshell-file-list');
    var checked = listEl ? listEl.querySelectorAll('.webshell-file-cb:checked') : [];
    var paths = [];
    checked.forEach(function (cb) { paths.push(cb.getAttribute('data-path')); });
    if (paths.length === 0) { alert(wsT('webshell.batchDownload') + '：请先勾选文件'); return; }
    paths.forEach(function (path) { webshellFileDownload(conn, path); });
}

// 下载文件到本地（读取内容后触发浏览器下载）
function webshellFileDownload(conn, path) {
    if (typeof apiFetch === 'undefined') return;
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'read', path: path })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            var content = (data && data.output) != null ? data.output : (data.error || '');
            var name = path.replace(/^.*[/\\]/, '') || 'download.txt';
            var blob = new Blob([content], { type: 'application/octet-stream' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            a.click();
            URL.revokeObjectURL(a.href);
        })
        .catch(function (err) { alert(wsT('webshell.execError') + ': ' + (err && err.message ? err.message : '')); });
}

function webshellFileRead(conn, path, listEl) {
    if (typeof apiFetch === 'undefined') return;
    listEl.innerHTML = '<div class="webshell-loading">' + wsT('webshell.readFile') + '...</div>';
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'read', path: path })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            const out = (data && data.output) ? data.output : (data.error || '');
            listEl.innerHTML = '<div class="webshell-file-content"><pre>' + escapeHtml(out) + '</pre><button type="button" class="btn-ghost" onclick="webshellFileListDir(webshellCurrentConn, document.getElementById(\'webshell-file-path\').value.trim() || \'.\')">' + wsT('webshell.listDir') + '</button></div>';
        })
        .catch(function (err) {
            listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : '') + '</div>';
        });
}

function webshellFileEdit(conn, path, listEl) {
    if (typeof apiFetch === 'undefined') return;
    listEl.innerHTML = '<div class="webshell-loading">' + wsT('webshell.editFile') + '...</div>';
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'read', path: path })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            const content = (data && data.output) ? data.output : (data.error || '');
            const pathInput = document.getElementById('webshell-file-path');
            const currentPath = pathInput ? pathInput.value.trim() || '.' : '.';
            listEl.innerHTML =
                '<div class="webshell-file-edit-wrap">' +
                '<div class="webshell-file-edit-path">' + escapeHtml(path) + '</div>' +
                '<textarea id="webshell-edit-textarea" class="webshell-file-edit-textarea" rows="18">' + escapeHtml(content) + '</textarea>' +
                '<div class="webshell-file-edit-actions">' +
                '<button type="button" class="btn-primary btn-sm" id="webshell-edit-save">' + wsT('webshell.saveFile') + '</button> ' +
                '<button type="button" class="btn-ghost btn-sm" id="webshell-edit-cancel">' + wsT('webshell.cancelEdit') + '</button>' +
                '</div></div>';
            document.getElementById('webshell-edit-save').addEventListener('click', function () {
                const textarea = document.getElementById('webshell-edit-textarea');
                const newContent = textarea ? textarea.value : '';
                webshellFileWrite(webshellCurrentConn, path, newContent, function () {
                    webshellFileListDir(webshellCurrentConn, currentPath);
                }, listEl);
            });
            document.getElementById('webshell-edit-cancel').addEventListener('click', function () {
                webshellFileListDir(webshellCurrentConn, currentPath);
            });
        })
        .catch(function (err) {
            listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : '') + '</div>';
        });
}

function webshellFileWrite(conn, path, content, onDone, listEl) {
    if (typeof apiFetch === 'undefined') return;
    if (listEl) listEl.innerHTML = '<div class="webshell-loading">' + wsT('webshell.saveFile') + '...</div>';
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'write', path: path, content: content })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            if (data && !data.ok && data.error && listEl) {
                listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(data.error) + '</div><pre class="webshell-file-raw">' + escapeHtml(data.output || '') + '</pre>';
                return;
            }
            if (onDone) onDone();
        })
        .catch(function (err) {
            if (listEl) listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : wsT('webshell.execError')) + '</div>';
        });
}

function webshellFileDelete(conn, path, onDone) {
    if (typeof apiFetch === 'undefined') return;
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'delete', path: path })
    }).then(function (r) { return r.json(); })
        .then(function () { if (onDone) onDone(); })
        .catch(function () { if (onDone) onDone(); });
}

// 删除连接（请求服务端删除后刷新列表）
function deleteWebshell(id) {
    if (!confirm(wsT('webshell.deleteConfirm'))) return;
    if (currentWebshellId === id) destroyWebshellTerminal();
    if (currentWebshellId === id) currentWebshellId = null;
    if (typeof apiFetch === 'undefined') return;
    apiFetch('/api/webshell/connections/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () {
            return refreshWebshellConnectionsFromServer();
        })
        .then(function () {
            const workspace = document.getElementById('webshell-workspace');
            if (workspace) {
                workspace.innerHTML = '<div class="webshell-workspace-placeholder">' + wsT('webshell.selectOrAdd') + '</div>';
            }
        })
        .catch(function (e) {
            console.warn('删除 WebShell 连接失败', e);
            refreshWebshellConnectionsFromServer();
        });
}

// 打开添加连接弹窗
function showAddWebshellModal() {
    var editIdEl = document.getElementById('webshell-edit-id');
    if (editIdEl) editIdEl.value = '';
    document.getElementById('webshell-url').value = '';
    document.getElementById('webshell-password').value = '';
    document.getElementById('webshell-type').value = 'php';
    document.getElementById('webshell-method').value = 'post';
    document.getElementById('webshell-cmd-param').value = '';
    document.getElementById('webshell-remark').value = '';
    var titleEl = document.getElementById('webshell-modal-title');
    if (titleEl) titleEl.textContent = wsT('webshell.addConnection');
    var modal = document.getElementById('webshell-modal');
    if (modal) modal.style.display = 'block';
}

// 打开编辑连接弹窗（预填当前连接信息）
function showEditWebshellModal(connId) {
    var conn = webshellConnections.find(function (c) { return c.id === connId; });
    if (!conn) return;
    var editIdEl = document.getElementById('webshell-edit-id');
    if (editIdEl) editIdEl.value = conn.id;
    document.getElementById('webshell-url').value = conn.url || '';
    document.getElementById('webshell-password').value = conn.password || '';
    document.getElementById('webshell-type').value = conn.type || 'php';
    document.getElementById('webshell-method').value = (conn.method || 'post').toLowerCase();
    document.getElementById('webshell-cmd-param').value = conn.cmdParam || '';
    document.getElementById('webshell-remark').value = conn.remark || '';
    var titleEl = document.getElementById('webshell-modal-title');
    if (titleEl) titleEl.textContent = wsT('webshell.editConnectionTitle');
    var modal = document.getElementById('webshell-modal');
    if (modal) modal.style.display = 'block';
}

// 关闭弹窗
function closeWebshellModal() {
    var editIdEl = document.getElementById('webshell-edit-id');
    if (editIdEl) editIdEl.value = '';
    var modal = document.getElementById('webshell-modal');
    if (modal) modal.style.display = 'none';
}

// 语言切换时刷新 WebShell 页面内所有由 JS 生成的文案（不重建终端）
function refreshWebshellUIOnLanguageChange() {
    var page = typeof window.currentPage === 'function' ? window.currentPage() : (window.currentPage || '');
    if (page !== 'webshell') return;

    renderWebshellList();

    var workspace = document.getElementById('webshell-workspace');
    if (workspace) {
        if (!currentWebshellId || !webshellCurrentConn) {
            workspace.innerHTML = '<div class="webshell-workspace-placeholder" data-i18n="webshell.selectOrAdd">' + wsT('webshell.selectOrAdd') + '</div>';
        } else {
            // 只更新标签文案，不重建终端
            var tabTerminal = workspace.querySelector('.webshell-tab[data-tab="terminal"]');
            var tabFile = workspace.querySelector('.webshell-tab[data-tab="file"]');
            if (tabTerminal) tabTerminal.textContent = wsT('webshell.tabTerminal');
            if (tabFile) tabFile.textContent = wsT('webshell.tabFileManager');

            var quickLabel = workspace.querySelector('.webshell-quick-label');
            if (quickLabel) quickLabel.textContent = (wsT('webshell.quickCommands') || '快捷命令') + ':';
            var pathLabel = workspace.querySelector('.webshell-file-toolbar label span');
            var listDirBtn = document.getElementById('webshell-list-dir');
            var parentDirBtn = document.getElementById('webshell-parent-dir');
            if (pathLabel) pathLabel.textContent = wsT('webshell.filePath');
            if (listDirBtn) listDirBtn.textContent = wsT('webshell.listDir');
            if (parentDirBtn) parentDirBtn.textContent = wsT('webshell.parentDir');
            // 文件管理工具栏按钮（红框区域）：切换语言时立即更新
            var refreshBtn = document.getElementById('webshell-file-refresh');
            var mkdirBtn = document.getElementById('webshell-mkdir-btn');
            var newFileBtn = document.getElementById('webshell-newfile-btn');
            var uploadBtn = document.getElementById('webshell-upload-btn');
            var batchDeleteBtn = document.getElementById('webshell-batch-delete-btn');
            var batchDownloadBtn = document.getElementById('webshell-batch-download-btn');
            var filterInput = document.getElementById('webshell-file-filter');
            if (refreshBtn) { refreshBtn.title = wsT('webshell.refresh') || '刷新'; refreshBtn.textContent = wsT('webshell.refresh') || '刷新'; }
            if (mkdirBtn) mkdirBtn.textContent = wsT('webshell.newDir') || '新建目录';
            if (newFileBtn) newFileBtn.textContent = wsT('webshell.newFile') || '新建文件';
            if (uploadBtn) uploadBtn.textContent = wsT('webshell.upload') || '上传';
            if (batchDeleteBtn) batchDeleteBtn.textContent = wsT('webshell.batchDelete') || '批量删除';
            if (batchDownloadBtn) batchDownloadBtn.textContent = wsT('webshell.batchDownload') || '批量下载';
            if (filterInput) filterInput.placeholder = wsT('webshell.filterPlaceholder') || '过滤文件名';

            var pathInput = document.getElementById('webshell-file-path');
            var fileListEl = document.getElementById('webshell-file-list');
            if (fileListEl && webshellCurrentConn && pathInput) {
                webshellFileListDir(webshellCurrentConn, pathInput.value.trim() || '.');
            }
        }
    }

    var modal = document.getElementById('webshell-modal');
    if (modal && modal.style.display === 'block') {
        var titleEl = document.getElementById('webshell-modal-title');
        var editIdEl = document.getElementById('webshell-edit-id');
        if (titleEl) {
            titleEl.textContent = (editIdEl && editIdEl.value) ? wsT('webshell.editConnectionTitle') : wsT('webshell.addConnection');
        }
        if (typeof window.applyTranslations === 'function') {
            window.applyTranslations(modal);
        }
    }
}

document.addEventListener('languagechange', function () {
    refreshWebshellUIOnLanguageChange();
});

// 测试连通性（不保存，仅用当前表单参数请求 Shell 执行 echo 1）
function testWebshellConnection() {
    var url = (document.getElementById('webshell-url') || {}).value;
    if (url && typeof url.trim === 'function') url = url.trim();
    if (!url) {
        alert(wsT('webshell.url') ? (wsT('webshell.url') + ' 必填') : '请填写 Shell 地址');
        return;
    }
    var password = (document.getElementById('webshell-password') || {}).value;
    if (password && typeof password.trim === 'function') password = password.trim(); else password = '';
    var type = (document.getElementById('webshell-type') || {}).value || 'php';
    var method = ((document.getElementById('webshell-method') || {}).value || 'post').toLowerCase();
    var cmdParam = (document.getElementById('webshell-cmd-param') || {}).value;
    if (cmdParam && typeof cmdParam.trim === 'function') cmdParam = cmdParam.trim(); else cmdParam = '';
    var btn = document.getElementById('webshell-test-btn');
    if (btn) { btn.disabled = true; btn.textContent = (typeof wsT === 'function' ? wsT('common.refresh') : '刷新') + '...'; }
    if (typeof apiFetch === 'undefined') {
        if (btn) { btn.disabled = false; btn.textContent = wsT('webshell.testConnectivity'); }
        alert(wsT('webshell.testFailed') || '连通性测试失败');
        return;
    }
    apiFetch('/api/webshell/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: url,
            password: password || '',
            type: type,
            method: method === 'get' ? 'get' : 'post',
            cmd_param: cmdParam || '',
            command: 'echo 1'
        })
    })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (btn) { btn.disabled = false; btn.textContent = wsT('webshell.testConnectivity'); }
            if (!data) {
                alert(wsT('webshell.testFailed') || '连通性测试失败');
                return;
            }
            // 仅 HTTP 200 不算通过，需校验是否真的执行了 echo 1（响应体 trim 后应为 "1"）
            var output = (data.output != null) ? String(data.output).trim() : '';
            var reallyOk = data.ok && output === '1';
            if (reallyOk) {
                alert(wsT('webshell.testSuccess') || '连通性正常，Shell 可访问');
            } else {
                var msg;
                if (data.ok && output !== '1')
                    msg = wsT('webshell.testNoExpectedOutput') || 'Shell 返回了响应但未得到预期输出，请检查连接密码与命令参数名';
                else
                    msg = (data.error) ? data.error : (wsT('webshell.testFailed') || '连通性测试失败');
                if (data.http_code) msg += ' (HTTP ' + data.http_code + ')';
                alert(msg);
            }
        })
        .catch(function (e) {
            if (btn) { btn.disabled = false; btn.textContent = wsT('webshell.testConnectivity'); }
            alert((wsT('webshell.testFailed') || '连通性测试失败') + ': ' + (e && e.message ? e.message : String(e)));
        });
}

// 保存连接（新建或更新，请求服务端写入 SQLite 后刷新列表）
function saveWebshellConnection() {
    var url = (document.getElementById('webshell-url') || {}).value;
    if (url && typeof url.trim === 'function') url = url.trim();
    if (!url) {
        alert('请填写 Shell 地址');
        return;
    }
    var password = (document.getElementById('webshell-password') || {}).value;
    if (password && typeof password.trim === 'function') password = password.trim(); else password = '';
    var type = (document.getElementById('webshell-type') || {}).value || 'php';
    var method = ((document.getElementById('webshell-method') || {}).value || 'post').toLowerCase();
    var cmdParam = (document.getElementById('webshell-cmd-param') || {}).value;
    if (cmdParam && typeof cmdParam.trim === 'function') cmdParam = cmdParam.trim(); else cmdParam = '';
    var remark = (document.getElementById('webshell-remark') || {}).value;
    if (remark && typeof remark.trim === 'function') remark = remark.trim(); else remark = '';

    var editIdEl = document.getElementById('webshell-edit-id');
    var editId = editIdEl ? editIdEl.value.trim() : '';
    var body = { url: url, password: password, type: type, method: method === 'get' ? 'get' : 'post', cmd_param: cmdParam, remark: remark || url };
    if (typeof apiFetch === 'undefined') return;

    var reqUrl = editId ? ('/api/webshell/connections/' + encodeURIComponent(editId)) : '/api/webshell/connections';
    var reqMethod = editId ? 'PUT' : 'POST';
    apiFetch(reqUrl, {
        method: reqMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
        .then(function (r) { return r.json(); })
        .then(function () {
            closeWebshellModal();
            return refreshWebshellConnectionsFromServer();
        })
        .then(function (list) {
            // 若编辑的是当前选中的连接，同步更新 webshellCurrentConn，使终端/文件管理立即使用新配置
            if (editId && currentWebshellId === editId && Array.isArray(list)) {
                var updated = list.find(function (c) { return c.id === editId; });
                if (updated) webshellCurrentConn = updated;
            }
        })
        .catch(function (e) {
            console.warn('保存 WebShell 连接失败', e);
            alert(e && e.message ? e.message : '保存失败');
        });
}
