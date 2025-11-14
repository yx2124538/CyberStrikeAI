const AUTH_STORAGE_KEY = 'cyberstrike-auth';
let authToken = null;
let authTokenExpiry = null;
let authPromise = null;
let authPromiseResolvers = [];
let isAppInitialized = false;

// 当前对话ID
let currentConversationId = null;
// 进度ID与任务信息映射
const progressTaskState = new Map();
// 活跃任务刷新定时器
let activeTaskInterval = null;
const ACTIVE_TASK_REFRESH_INTERVAL = 10000; // 10秒检查一次，提供更实时的任务状态反馈

function isTokenValid() {
    return !!authToken && authTokenExpiry instanceof Date && authTokenExpiry.getTime() > Date.now();
}

function saveAuth(token, expiresAt) {
    const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    authToken = token;
    authTokenExpiry = expiry;
    try {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
            token,
            expiresAt: expiry.toISOString(),
        }));
    } catch (error) {
        console.warn('无法持久化认证信息:', error);
    }
}

function clearAuthStorage() {
    authToken = null;
    authTokenExpiry = null;
    try {
        localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch (error) {
        console.warn('无法清除认证信息:', error);
    }
}

function loadAuthFromStorage() {
    try {
        const raw = localStorage.getItem(AUTH_STORAGE_KEY);
        if (!raw) {
            return false;
        }
        const stored = JSON.parse(raw);
        if (!stored.token || !stored.expiresAt) {
            clearAuthStorage();
            return false;
        }
        const expiry = new Date(stored.expiresAt);
        if (Number.isNaN(expiry.getTime())) {
            clearAuthStorage();
            return false;
        }
        authToken = stored.token;
        authTokenExpiry = expiry;
        return isTokenValid();
    } catch (error) {
        console.error('读取认证信息失败:', error);
        clearAuthStorage();
        return false;
    }
}

function resolveAuthPromises(success) {
    authPromiseResolvers.forEach(resolve => resolve(success));
    authPromiseResolvers = [];
    authPromise = null;
}

function showLoginOverlay(message = '') {
    const overlay = document.getElementById('login-overlay');
    const errorBox = document.getElementById('login-error');
    const passwordInput = document.getElementById('login-password');
    if (!overlay) {
        return;
    }
    overlay.style.display = 'flex';
    if (errorBox) {
        if (message) {
            errorBox.textContent = message;
            errorBox.style.display = 'block';
        } else {
            errorBox.textContent = '';
            errorBox.style.display = 'none';
        }
    }
    setTimeout(() => {
        if (passwordInput) {
            passwordInput.focus();
        }
    }, 100);
}

function hideLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    const errorBox = document.getElementById('login-error');
    const passwordInput = document.getElementById('login-password');
    if (overlay) {
        overlay.style.display = 'none';
    }
    if (errorBox) {
        errorBox.textContent = '';
        errorBox.style.display = 'none';
    }
    if (passwordInput) {
        passwordInput.value = '';
    }
}

function ensureAuthPromise() {
    if (!authPromise) {
        authPromise = new Promise(resolve => {
            authPromiseResolvers.push(resolve);
        });
    }
    return authPromise;
}

async function ensureAuthenticated() {
    if (isTokenValid()) {
        return true;
    }
    showLoginOverlay();
    await ensureAuthPromise();
    return true;
}

function handleUnauthorized({ message = '认证已过期，请重新登录', silent = false } = {}) {
    clearAuthStorage();
    authPromise = null;
    authPromiseResolvers = [];
    if (!silent) {
        showLoginOverlay(message);
    } else {
        showLoginOverlay();
    }
    return false;
}

async function apiFetch(url, options = {}) {
    await ensureAuthenticated();
    const opts = { ...options };
    const headers = new Headers(options && options.headers ? options.headers : undefined);
    if (authToken && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${authToken}`);
    }
    opts.headers = headers;

    const response = await fetch(url, opts);
    if (response.status === 401) {
        handleUnauthorized();
        throw new Error('未授权访问');
    }
    return response;
}

async function submitLogin(event) {
    event.preventDefault();
    const passwordInput = document.getElementById('login-password');
    const errorBox = document.getElementById('login-error');
    const submitBtn = document.querySelector('.login-submit');

    if (!passwordInput) {
        return;
    }

    const password = passwordInput.value.trim();
    if (!password) {
        if (errorBox) {
            errorBox.textContent = '请输入密码';
            errorBox.style.display = 'block';
        }
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
    }

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ password }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.token) {
            if (errorBox) {
                errorBox.textContent = result.error || '登录失败，请检查密码';
                errorBox.style.display = 'block';
            }
            return;
        }

        saveAuth(result.token, result.expires_at);
        hideLoginOverlay();
        resolveAuthPromises(true);
        if (!isAppInitialized) {
            await bootstrapApp();
        } else {
            await refreshAppData();
        }
    } catch (error) {
        console.error('登录失败:', error);
        if (errorBox) {
            errorBox.textContent = '登录失败，请稍后重试';
            errorBox.style.display = 'block';
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
        }
    }
}

async function refreshAppData(showTaskErrors = false) {
    await Promise.allSettled([
        loadConversations(),
        loadActiveTasks(showTaskErrors),
    ]);
}

async function bootstrapApp() {
    if (!isAppInitialized) {
        initializeChatUI();
        isAppInitialized = true;
    }
    await refreshAppData();
}

function initializeChatUI() {
    const chatInputEl = document.getElementById('chat-input');
    if (chatInputEl) {
        chatInputEl.style.height = '44px';
    }

    const messagesDiv = document.getElementById('chat-messages');
    if (messagesDiv && messagesDiv.childElementCount === 0) {
        addMessage('assistant', '系统已就绪。请输入您的测试需求，系统将自动执行相应的安全测试。');
    }

    loadActiveTasks(true);
    if (activeTaskInterval) {
        clearInterval(activeTaskInterval);
    }
    activeTaskInterval = setInterval(() => loadActiveTasks(), ACTIVE_TASK_REFRESH_INTERVAL);
}

function setupLoginUI() {
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', submitLogin);
    }
}

async function initializeApp() {
    setupLoginUI();
    const hasStoredAuth = loadAuthFromStorage();
    if (hasStoredAuth && isTokenValid()) {
        try {
            const response = await apiFetch('/api/auth/validate', {
                method: 'GET',
            });
            if (response.ok) {
                hideLoginOverlay();
                resolveAuthPromises(true);
                await bootstrapApp();
                return;
            }
        } catch (error) {
            console.warn('本地会话已失效，需重新登录');
        }
    }

    clearAuthStorage();
    showLoginOverlay();
}

document.addEventListener('DOMContentLoaded', initializeApp);


function registerProgressTask(progressId, conversationId = null) {
    const state = progressTaskState.get(progressId) || {};
    state.conversationId = conversationId !== undefined && conversationId !== null
        ? conversationId
        : (state.conversationId ?? currentConversationId);
    state.cancelling = false;
    progressTaskState.set(progressId, state);

    const progressElement = document.getElementById(progressId);
    if (progressElement) {
        progressElement.dataset.conversationId = state.conversationId || '';
    }
}

function updateProgressConversation(progressId, conversationId) {
    if (!conversationId) {
        return;
    }
    registerProgressTask(progressId, conversationId);
}

function markProgressCancelling(progressId) {
    const state = progressTaskState.get(progressId);
    if (state) {
        state.cancelling = true;
    }
}

function finalizeProgressTask(progressId, finalLabel = '已完成') {
    const stopBtn = document.getElementById(`${progressId}-stop-btn`);
    if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.textContent = finalLabel;
    }
    progressTaskState.delete(progressId);
}

async function requestCancel(conversationId) {
    const response = await apiFetch('/api/agent-loop/cancel', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ conversationId }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || '取消失败');
    }
    return result;
}

// 发送消息
async function sendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    
    if (!message) {
        return;
    }
    
    // 显示用户消息
    addMessage('user', message);
    input.value = '';
    
    // 创建进度消息容器（使用详细的进度展示）
    const progressId = addProgressMessage();
    const progressElement = document.getElementById(progressId);
    registerProgressTask(progressId, currentConversationId);
    loadActiveTasks();
    let assistantMessageId = null;
    let mcpExecutionIds = [];
    
    try {
        const response = await apiFetch('/api/agent-loop/stream', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                message: message,
                conversationId: currentConversationId 
            }),
        });
        
        if (!response.ok) {
            throw new Error('请求失败: ' + response.status);
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保留最后一个不完整的行
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const eventData = JSON.parse(line.slice(6));
                        handleStreamEvent(eventData, progressElement, progressId, 
                                         () => assistantMessageId, (id) => { assistantMessageId = id; },
                                         () => mcpExecutionIds, (ids) => { mcpExecutionIds = ids; });
                    } catch (e) {
                        console.error('解析事件数据失败:', e, line);
                    }
                }
            }
        }
        
        // 处理剩余的buffer
        if (buffer.trim()) {
            const lines = buffer.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const eventData = JSON.parse(line.slice(6));
                        handleStreamEvent(eventData, progressElement, progressId,
                                         () => assistantMessageId, (id) => { assistantMessageId = id; },
                                         () => mcpExecutionIds, (ids) => { mcpExecutionIds = ids; });
                    } catch (e) {
                        console.error('解析事件数据失败:', e, line);
                    }
                }
            }
        }
        
    } catch (error) {
        removeMessage(progressId);
        addMessage('system', '错误: ' + error.message);
    }
}

// 创建进度消息容器
function addProgressMessage() {
    const messagesDiv = document.getElementById('chat-messages');
    const messageDiv = document.createElement('div');
    messageCounter++;
    const id = 'progress-' + Date.now() + '-' + messageCounter;
    messageDiv.id = id;
    messageDiv.className = 'message system progress-message';
    
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'message-content';
    
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble progress-container';
    bubble.innerHTML = `
        <div class="progress-header">
            <span class="progress-title">🔍 渗透测试进行中...</span>
            <div class="progress-actions">
                <button class="progress-stop" id="${id}-stop-btn" onclick="cancelProgressTask('${id}')">停止任务</button>
                <button class="progress-toggle" onclick="toggleProgressDetails('${id}')">收起详情</button>
            </div>
        </div>
        <div class="progress-timeline expanded" id="${id}-timeline"></div>
    `;
    
    contentWrapper.appendChild(bubble);
    messageDiv.appendChild(contentWrapper);
    messageDiv.dataset.conversationId = currentConversationId || '';
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    return id;
}

// 切换进度详情显示
function toggleProgressDetails(progressId) {
    const timeline = document.getElementById(progressId + '-timeline');
    const toggleBtn = document.querySelector(`#${progressId} .progress-toggle`);
    
    if (!timeline || !toggleBtn) return;
    
    if (timeline.classList.contains('expanded')) {
        timeline.classList.remove('expanded');
        toggleBtn.textContent = '展开详情';
    } else {
        timeline.classList.add('expanded');
        toggleBtn.textContent = '收起详情';
    }
}

// 折叠所有进度详情
function collapseAllProgressDetails(assistantMessageId, progressId) {
    // 折叠集成到MCP区域的详情
    const detailsId = 'process-details-' + assistantMessageId;
    const detailsContainer = document.getElementById(detailsId);
    if (detailsContainer) {
        const timeline = detailsContainer.querySelector('.progress-timeline');
        if (timeline && timeline.classList.contains('expanded')) {
            timeline.classList.remove('expanded');
            const btn = document.querySelector(`#${assistantMessageId} .process-detail-btn`);
            if (btn) {
                btn.innerHTML = '<span>展开详情</span>';
            }
        }
    }
    
    // 折叠独立的详情组件（通过convertProgressToDetails创建的）
    // 查找所有以details-开头的详情组件
    const allDetails = document.querySelectorAll('[id^="details-"]');
    allDetails.forEach(detail => {
        const timeline = detail.querySelector('.progress-timeline');
        const toggleBtn = detail.querySelector('.progress-toggle');
        if (timeline && timeline.classList.contains('expanded')) {
            timeline.classList.remove('expanded');
            if (toggleBtn) {
                toggleBtn.textContent = '展开详情';
            }
        }
    });
    
    // 折叠原始的进度消息（如果还存在）
    if (progressId) {
        const progressTimeline = document.getElementById(progressId + '-timeline');
        const progressToggleBtn = document.querySelector(`#${progressId} .progress-toggle`);
        if (progressTimeline && progressTimeline.classList.contains('expanded')) {
            progressTimeline.classList.remove('expanded');
            if (progressToggleBtn) {
                progressToggleBtn.textContent = '展开详情';
            }
        }
    }
}

// 获取当前助手消息ID（用于done事件）
function getAssistantId() {
    // 从最近的助手消息中获取ID
    const messages = document.querySelectorAll('.message.assistant');
    if (messages.length > 0) {
        return messages[messages.length - 1].id;
    }
    return null;
}

// 将进度详情集成到工具调用区域
function integrateProgressToMCPSection(progressId, assistantMessageId) {
    const progressElement = document.getElementById(progressId);
    if (!progressElement) return;
    
    // 获取时间线内容
    const timeline = document.getElementById(progressId + '-timeline');
    let timelineHTML = '';
    if (timeline) {
        timelineHTML = timeline.innerHTML;
    }
    
    // 获取助手消息元素
    const assistantElement = document.getElementById(assistantMessageId);
    if (!assistantElement) {
        removeMessage(progressId);
        return;
    }
    
    // 查找MCP调用区域
    const mcpSection = assistantElement.querySelector('.mcp-call-section');
    if (!mcpSection) {
        // 如果没有MCP区域，创建详情组件放在消息下方
        convertProgressToDetails(progressId, assistantMessageId);
        return;
    }
    
    // 获取时间线内容
    const hasContent = timelineHTML.trim().length > 0;
    
    // 确保按钮容器存在
    let buttonsContainer = mcpSection.querySelector('.mcp-call-buttons');
    if (!buttonsContainer) {
        buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'mcp-call-buttons';
        mcpSection.appendChild(buttonsContainer);
    }
    
    // 创建详情容器，放在MCP按钮区域下方（统一结构）
    const detailsId = 'process-details-' + assistantMessageId;
    let detailsContainer = document.getElementById(detailsId);
    
    if (!detailsContainer) {
        detailsContainer = document.createElement('div');
        detailsContainer.id = detailsId;
        detailsContainer.className = 'process-details-container';
        // 确保容器在按钮容器之后
        if (buttonsContainer.nextSibling) {
            mcpSection.insertBefore(detailsContainer, buttonsContainer.nextSibling);
        } else {
            mcpSection.appendChild(detailsContainer);
        }
    }
    
    // 设置详情内容（默认折叠状态）
    detailsContainer.innerHTML = `
        <div class="process-details-content">
            ${hasContent ? `<div class="progress-timeline" id="${detailsId}-timeline">${timelineHTML}</div>` : '<div class="progress-timeline-empty">暂无过程详情</div>'}
        </div>
    `;
    
    // 确保初始状态是折叠的
    if (hasContent) {
        const timeline = document.getElementById(detailsId + '-timeline');
        if (timeline) {
            timeline.classList.remove('expanded');
        }
    }
    
    // 移除原来的进度消息
    removeMessage(progressId);
}

// 切换过程详情显示
function toggleProcessDetails(progressId, assistantMessageId) {
    const detailsId = 'process-details-' + assistantMessageId;
    const detailsContainer = document.getElementById(detailsId);
    if (!detailsContainer) return;
    
    const content = detailsContainer.querySelector('.process-details-content');
    const timeline = detailsContainer.querySelector('.progress-timeline');
    const btn = document.querySelector(`#${assistantMessageId} .process-detail-btn`);
    
    if (content && timeline) {
        if (timeline.classList.contains('expanded')) {
            timeline.classList.remove('expanded');
            if (btn) btn.innerHTML = '<span>展开详情</span>';
        } else {
            timeline.classList.add('expanded');
            if (btn) btn.innerHTML = '<span>收起详情</span>';
        }
    } else if (timeline) {
        // 如果只有timeline，直接切换
        if (timeline.classList.contains('expanded')) {
            timeline.classList.remove('expanded');
            if (btn) btn.innerHTML = '<span>展开详情</span>';
        } else {
            timeline.classList.add('expanded');
            if (btn) btn.innerHTML = '<span>收起详情</span>';
        }
    }
    
    // 滚动到底部以便查看展开的内容
    if (timeline && timeline.classList.contains('expanded')) {
        setTimeout(() => {
            const messagesDiv = document.getElementById('chat-messages');
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }, 100);
    }
}

// 停止当前进度对应的任务
async function cancelProgressTask(progressId) {
    const state = progressTaskState.get(progressId);
    const stopBtn = document.getElementById(`${progressId}-stop-btn`);

    if (!state || !state.conversationId) {
        if (stopBtn) {
            stopBtn.disabled = true;
            setTimeout(() => {
                stopBtn.disabled = false;
            }, 1500);
        }
        alert('任务信息尚未同步，请稍后再试。');
        return;
    }

    if (state.cancelling) {
        return;
    }

    markProgressCancelling(progressId);
    if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.textContent = '取消中...';
    }

    try {
        await requestCancel(state.conversationId);
        loadActiveTasks();
    } catch (error) {
        console.error('取消任务失败:', error);
        alert('取消任务失败: ' + error.message);
        if (stopBtn) {
            stopBtn.disabled = false;
            stopBtn.textContent = '停止任务';
        }
        const currentState = progressTaskState.get(progressId);
        if (currentState) {
            currentState.cancelling = false;
        }
    }
}

// 将进度消息转换为可折叠的详情组件
function convertProgressToDetails(progressId, assistantMessageId) {
    const progressElement = document.getElementById(progressId);
    if (!progressElement) return;
    
    // 获取时间线内容
    const timeline = document.getElementById(progressId + '-timeline');
    // 即使时间线不存在，也创建详情组件（显示空状态）
    let timelineHTML = '';
    if (timeline) {
        timelineHTML = timeline.innerHTML;
    }
    
    // 获取助手消息元素
    const assistantElement = document.getElementById(assistantMessageId);
    if (!assistantElement) {
        removeMessage(progressId);
        return;
    }
    
    // 创建详情组件
    const detailsId = 'details-' + Date.now() + '-' + messageCounter++;
    const detailsDiv = document.createElement('div');
    detailsDiv.id = detailsId;
    detailsDiv.className = 'message system progress-details';
    
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'message-content';
    
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble progress-container completed';
    
    // 获取时间线HTML内容
    const hasContent = timelineHTML.trim().length > 0;
    
    // 总是显示详情组件，即使没有内容也显示
    bubble.innerHTML = `
        <div class="progress-header">
            <span class="progress-title">📋 渗透测试详情</span>
            ${hasContent ? `<button class="progress-toggle" onclick="toggleProgressDetails('${detailsId}')">收起详情</button>` : ''}
        </div>
        ${hasContent ? `<div class="progress-timeline expanded" id="${detailsId}-timeline">${timelineHTML}</div>` : '<div class="progress-timeline-empty">暂无过程详情（可能执行过快或未触发详细事件）</div>'}
    `;
    
    contentWrapper.appendChild(bubble);
    detailsDiv.appendChild(contentWrapper);
    
    // 将详情组件插入到助手消息之后
    const messagesDiv = document.getElementById('chat-messages');
    // assistantElement 是消息div，需要插入到它的下一个兄弟节点之前
    if (assistantElement.nextSibling) {
        messagesDiv.insertBefore(detailsDiv, assistantElement.nextSibling);
    } else {
        // 如果没有下一个兄弟节点，直接追加
        messagesDiv.appendChild(detailsDiv);
    }
    
    // 移除原来的进度消息
    removeMessage(progressId);
    
    // 滚动到底部
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// 处理流式事件
function handleStreamEvent(event, progressElement, progressId, 
                          getAssistantId, setAssistantId, getMcpIds, setMcpIds) {
    const timeline = document.getElementById(progressId + '-timeline');
    if (!timeline) return;
    
    switch (event.type) {
        case 'conversation':
            if (event.data && event.data.conversationId) {
                updateProgressConversation(progressId, event.data.conversationId);
                currentConversationId = event.data.conversationId;
                updateActiveConversation();
                loadActiveTasks();
                // 立即刷新对话列表，让新对话显示在历史记录中
                loadConversations();
            }
            break;
        case 'iteration':
            // 添加迭代标记
            addTimelineItem(timeline, 'iteration', {
                title: `第 ${event.data?.iteration || 1} 轮迭代`,
                message: event.message,
                data: event.data
            });
            break;
            
        case 'thinking':
            // 显示AI思考内容
            addTimelineItem(timeline, 'thinking', {
                title: '🤔 AI思考',
                message: event.message,
                data: event.data
            });
            break;
            
        case 'tool_calls_detected':
            // 工具调用检测
            addTimelineItem(timeline, 'tool_calls_detected', {
                title: `🔧 检测到 ${event.data?.count || 0} 个工具调用`,
                message: event.message,
                data: event.data
            });
            break;
            
        case 'tool_call':
            // 显示工具调用信息
            const toolInfo = event.data || {};
            const toolName = toolInfo.toolName || '未知工具';
            const index = toolInfo.index || 0;
            const total = toolInfo.total || 0;
            addTimelineItem(timeline, 'tool_call', {
                title: `🔧 调用工具: ${escapeHtml(toolName)} (${index}/${total})`,
                message: event.message,
                data: toolInfo,
                expanded: false
            });
            break;
            
        case 'tool_result':
            // 显示工具执行结果
            const resultInfo = event.data || {};
            const resultToolName = resultInfo.toolName || '未知工具';
            const success = resultInfo.success !== false;
            const statusIcon = success ? '✅' : '❌';
            addTimelineItem(timeline, 'tool_result', {
                title: `${statusIcon} 工具 ${escapeHtml(resultToolName)} 执行${success ? '完成' : '失败'}`,
                message: event.message,
                data: resultInfo,
                expanded: false
            });
            break;
            
        case 'progress':
            // 更新进度状态
            const progressTitle = document.querySelector(`#${progressId} .progress-title`);
            if (progressTitle) {
                progressTitle.textContent = '🔍 ' + event.message;
            }
            break;
        
        case 'cancelled':
            addTimelineItem(timeline, 'cancelled', {
                title: '⛔ 任务已取消',
                message: event.message,
                data: event.data
            });
            const cancelTitle = document.querySelector(`#${progressId} .progress-title`);
            if (cancelTitle) {
                cancelTitle.textContent = '⛔ 任务已取消';
            }
            finalizeProgressTask(progressId, '已取消');
            loadActiveTasks();
            break;
            
        case 'response':
            // 先添加助手回复
            const responseData = event.data || {};
            const mcpIds = responseData.mcpExecutionIds || [];
            setMcpIds(mcpIds);
            
            // 更新对话ID
            if (responseData.conversationId) {
                currentConversationId = responseData.conversationId;
                updateActiveConversation();
                updateProgressConversation(progressId, responseData.conversationId);
                loadActiveTasks();
            }
            
            // 添加助手回复，并传入进度ID以便集成详情
            const assistantId = addMessage('assistant', event.message, mcpIds, progressId);
            setAssistantId(assistantId);
            
            // 将进度详情集成到工具调用区域
            integrateProgressToMCPSection(progressId, assistantId);
            
            // 延迟自动折叠详情（3秒后）
            setTimeout(() => {
                collapseAllProgressDetails(assistantId, progressId);
            }, 3000);
            
            // 刷新对话列表
            loadConversations();
            break;
            
        case 'error':
            // 显示错误
            addTimelineItem(timeline, 'error', {
                title: '❌ 错误',
                message: event.message,
                data: event.data
            });
            break;
            
        case 'done':
            // 完成，更新进度标题（如果进度消息还存在）
            const doneTitle = document.querySelector(`#${progressId} .progress-title`);
            if (doneTitle) {
                doneTitle.textContent = '✅ 渗透测试完成';
            }
            // 更新对话ID
            if (event.data && event.data.conversationId) {
                currentConversationId = event.data.conversationId;
                updateActiveConversation();
                updateProgressConversation(progressId, event.data.conversationId);
            }
            if (progressTaskState.has(progressId)) {
                finalizeProgressTask(progressId, '已完成');
            }
            loadActiveTasks();
            // 完成时自动折叠所有详情（延迟一下确保response事件已处理）
            setTimeout(() => {
                const assistantIdFromDone = getAssistantId();
                if (assistantIdFromDone) {
                    collapseAllProgressDetails(assistantIdFromDone, progressId);
                } else {
                    // 如果无法获取助手ID，尝试折叠所有详情
                    collapseAllProgressDetails(null, progressId);
                }
            }, 500);
            break;
    }
    
    // 自动滚动到底部
    const messagesDiv = document.getElementById('chat-messages');
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// 添加时间线项目
function addTimelineItem(timeline, type, options) {
    const item = document.createElement('div');
    item.className = `timeline-item timeline-item-${type}`;
    
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    let content = `
        <div class="timeline-item-header">
            <span class="timeline-item-time">${time}</span>
            <span class="timeline-item-title">${escapeHtml(options.title || '')}</span>
        </div>
    `;
    
    // 根据类型添加详细内容
    if (type === 'thinking' && options.message) {
        content += `<div class="timeline-item-content">${formatMarkdown(options.message)}</div>`;
    } else if (type === 'tool_call' && options.data) {
        const data = options.data;
        const args = data.argumentsObj || (data.arguments ? JSON.parse(data.arguments) : {});
        content += `
            <div class="timeline-item-content">
                <div class="tool-details">
                    <div class="tool-arg-section">
                        <strong>参数:</strong>
                        <pre class="tool-args">${escapeHtml(JSON.stringify(args, null, 2))}</pre>
                    </div>
                </div>
            </div>
        `;
    } else if (type === 'tool_result' && options.data) {
        const data = options.data;
        const isError = data.isError || !data.success;
        const result = data.result || data.error || '无结果';
        // 确保 result 是字符串
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        content += `
            <div class="timeline-item-content">
                <div class="tool-result-section ${isError ? 'error' : 'success'}">
                    <strong>执行结果:</strong>
                    <pre class="tool-result">${escapeHtml(resultStr)}</pre>
                    ${data.executionId ? `<div class="tool-execution-id">执行ID: <code>${escapeHtml(data.executionId)}</code></div>` : ''}
                </div>
            </div>
        `;
    } else if (type === 'cancelled') {
        content += `
            <div class="timeline-item-content">
                ${escapeHtml(options.message || '任务已取消')}
            </div>
        `;
    }
    
    item.innerHTML = content;
    timeline.appendChild(item);
    
    // 自动展开详情
    const expanded = timeline.classList.contains('expanded');
    if (!expanded && (type === 'tool_call' || type === 'tool_result')) {
        // 对于工具调用和结果，默认显示摘要
    }
}

// 消息计数器，确保ID唯一
let messageCounter = 0;

// 添加消息
function addMessage(role, content, mcpExecutionIds = null, progressId = null) {
    const messagesDiv = document.getElementById('chat-messages');
    const messageDiv = document.createElement('div');
    messageCounter++;
    const id = 'msg-' + Date.now() + '-' + messageCounter + '-' + Math.random().toString(36).substr(2, 9);
    messageDiv.id = id;
    messageDiv.className = 'message ' + role;
    
    // 创建头像
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    if (role === 'user') {
        avatar.textContent = 'U';
    } else if (role === 'assistant') {
        avatar.textContent = 'A';
    } else {
        avatar.textContent = 'S';
    }
    messageDiv.appendChild(avatar);
    
    // 创建消息内容容器
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'message-content';
    
    // 创建消息气泡
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    
    // 解析 Markdown 或 HTML 格式
    let formattedContent;
    
    // 先使用 DOMPurify 清理（如果可用），这样可以处理已经是 HTML 的内容
    if (typeof DOMPurify !== 'undefined') {
        // 配置 DOMPurify 允许的标签和属性
        const sanitizeConfig = {
            // 允许基本的 Markdown 格式化标签
            ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
            ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class'],
            ALLOW_DATA_ATTR: false,
        };
        
        // 如果内容看起来已经是 HTML（包含 HTML 标签），直接清理
        // 否则先用 marked.js 解析 Markdown，再清理
        if (typeof marked !== 'undefined' && !/<[a-z][\s\S]*>/i.test(content)) {
            // 内容不包含 HTML 标签，可能是 Markdown，使用 marked.js 解析
            try {
                marked.setOptions({
                    breaks: true,
                    gfm: true,
                });
                let parsedContent = marked.parse(content);
                formattedContent = DOMPurify.sanitize(parsedContent, sanitizeConfig);
            } catch (e) {
                console.error('Markdown 解析失败:', e);
                // 降级处理：直接清理原始内容
                formattedContent = DOMPurify.sanitize(content, sanitizeConfig);
            }
        } else {
            // 内容包含 HTML 标签或 marked.js 不可用，直接清理
            formattedContent = DOMPurify.sanitize(content, sanitizeConfig);
        }
    } else if (typeof marked !== 'undefined') {
        // 没有 DOMPurify，但有 marked.js
        try {
            marked.setOptions({
                breaks: true,
                gfm: true,
            });
            formattedContent = marked.parse(content);
        } catch (e) {
            console.error('Markdown 解析失败:', e);
            formattedContent = escapeHtml(content).replace(/\n/g, '<br>');
        }
    } else {
        // 都没有，简单转义
        formattedContent = escapeHtml(content).replace(/\n/g, '<br>');
    }
    
    bubble.innerHTML = formattedContent;
    contentWrapper.appendChild(bubble);
    
    // 添加时间戳
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    contentWrapper.appendChild(timeDiv);
    
    // 如果有MCP执行ID或进度ID，添加查看详情区域（统一使用"渗透测试详情"样式）
    if (role === 'assistant' && ((mcpExecutionIds && Array.isArray(mcpExecutionIds) && mcpExecutionIds.length > 0) || progressId)) {
        const mcpSection = document.createElement('div');
        mcpSection.className = 'mcp-call-section';
        
        const mcpLabel = document.createElement('div');
        mcpLabel.className = 'mcp-call-label';
        mcpLabel.textContent = '📋 渗透测试详情';
        mcpSection.appendChild(mcpLabel);
        
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'mcp-call-buttons';
        
        // 如果有MCP执行ID，添加MCP调用详情按钮
        if (mcpExecutionIds && Array.isArray(mcpExecutionIds) && mcpExecutionIds.length > 0) {
            mcpExecutionIds.forEach((execId, index) => {
                const detailBtn = document.createElement('button');
                detailBtn.className = 'mcp-detail-btn';
                detailBtn.innerHTML = `<span>调用 #${index + 1}</span>`;
                detailBtn.onclick = () => showMCPDetail(execId);
                buttonsContainer.appendChild(detailBtn);
            });
        }
        
        // 如果有进度ID，添加展开详情按钮（统一使用"展开详情"文本）
        if (progressId) {
            const progressDetailBtn = document.createElement('button');
            progressDetailBtn.className = 'mcp-detail-btn process-detail-btn';
            progressDetailBtn.innerHTML = '<span>展开详情</span>';
            progressDetailBtn.onclick = () => toggleProcessDetails(progressId, messageDiv.id);
            buttonsContainer.appendChild(progressDetailBtn);
            // 存储进度ID到消息元素
            messageDiv.dataset.progressId = progressId;
        }
        
        mcpSection.appendChild(buttonsContainer);
        contentWrapper.appendChild(mcpSection);
    }
    
    messageDiv.appendChild(contentWrapper);
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    return id;
}

// 渲染过程详情
function renderProcessDetails(messageId, processDetails) {
    if (!processDetails || processDetails.length === 0) {
        return;
    }
    
    const messageElement = document.getElementById(messageId);
    if (!messageElement) {
        return;
    }
    
    // 查找或创建MCP调用区域
    let mcpSection = messageElement.querySelector('.mcp-call-section');
    if (!mcpSection) {
        mcpSection = document.createElement('div');
        mcpSection.className = 'mcp-call-section';
        
        const contentWrapper = messageElement.querySelector('.message-content');
        if (contentWrapper) {
            contentWrapper.appendChild(mcpSection);
        } else {
            return;
        }
    }
    
    // 确保有标签和按钮容器（统一结构）
    let mcpLabel = mcpSection.querySelector('.mcp-call-label');
    let buttonsContainer = mcpSection.querySelector('.mcp-call-buttons');
    
    // 如果没有标签，创建一个（当没有工具调用时）
    if (!mcpLabel && !buttonsContainer) {
        mcpLabel = document.createElement('div');
        mcpLabel.className = 'mcp-call-label';
        mcpLabel.textContent = '📋 渗透测试详情';
        mcpSection.appendChild(mcpLabel);
    } else if (mcpLabel && mcpLabel.textContent !== '📋 渗透测试详情') {
        // 如果标签存在但不是统一格式，更新它
        mcpLabel.textContent = '📋 渗透测试详情';
    }
    
    // 如果没有按钮容器，创建一个
    if (!buttonsContainer) {
        buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'mcp-call-buttons';
        mcpSection.appendChild(buttonsContainer);
    }
    
    // 添加过程详情按钮（如果还没有）
    let processDetailBtn = buttonsContainer.querySelector('.process-detail-btn');
    if (!processDetailBtn) {
        processDetailBtn = document.createElement('button');
        processDetailBtn.className = 'mcp-detail-btn process-detail-btn';
        processDetailBtn.innerHTML = '<span>展开详情</span>';
        processDetailBtn.onclick = () => toggleProcessDetails(null, messageId);
        buttonsContainer.appendChild(processDetailBtn);
    }
    
    // 创建过程详情容器（放在按钮容器之后）
    const detailsId = 'process-details-' + messageId;
    let detailsContainer = document.getElementById(detailsId);
    
    if (!detailsContainer) {
        detailsContainer = document.createElement('div');
        detailsContainer.id = detailsId;
        detailsContainer.className = 'process-details-container';
        // 确保容器在按钮容器之后
        if (buttonsContainer.nextSibling) {
            mcpSection.insertBefore(detailsContainer, buttonsContainer.nextSibling);
        } else {
            mcpSection.appendChild(detailsContainer);
        }
    }
    
    // 创建时间线
    const timelineId = detailsId + '-timeline';
    let timeline = document.getElementById(timelineId);
    
    if (!timeline) {
        const contentDiv = document.createElement('div');
        contentDiv.className = 'process-details-content';
        
        timeline = document.createElement('div');
        timeline.id = timelineId;
        timeline.className = 'progress-timeline';
        
        contentDiv.appendChild(timeline);
        detailsContainer.appendChild(contentDiv);
    }
    
    // 清空时间线并重新渲染
    timeline.innerHTML = '';
    
    // 渲染每个过程详情事件
    processDetails.forEach(detail => {
        const eventType = detail.eventType || '';
        const title = detail.message || '';
        const data = detail.data || {};
        
        // 根据事件类型渲染不同的内容
        let itemTitle = title;
        if (eventType === 'iteration') {
            itemTitle = `第 ${data.iteration || 1} 轮迭代`;
        } else if (eventType === 'thinking') {
            itemTitle = '🤔 AI思考';
        } else if (eventType === 'tool_calls_detected') {
            itemTitle = `🔧 检测到 ${data.count || 0} 个工具调用`;
        } else if (eventType === 'tool_call') {
            const toolName = data.toolName || '未知工具';
            const index = data.index || 0;
            const total = data.total || 0;
            itemTitle = `🔧 调用工具: ${escapeHtml(toolName)} (${index}/${total})`;
        } else if (eventType === 'tool_result') {
            const toolName = data.toolName || '未知工具';
            const success = data.success !== false;
            const statusIcon = success ? '✅' : '❌';
            itemTitle = `${statusIcon} 工具 ${escapeHtml(toolName)} 执行${success ? '完成' : '失败'}`;
        } else if (eventType === 'error') {
            itemTitle = '❌ 错误';
        }
        
        addTimelineItem(timeline, eventType, {
            title: itemTitle,
            message: detail.message || '',
            data: data
        });
    });
}

// 移除消息
function removeMessage(id) {
    const messageDiv = document.getElementById(id);
    if (messageDiv) {
        messageDiv.remove();
    }
}

// 回车发送消息，Shift+Enter 换行
const chatInput = document.getElementById('chat-input');
chatInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
    // Shift+Enter 允许默认行为（换行）
});

// 显示MCP调用详情
async function showMCPDetail(executionId) {
    try {
        const response = await apiFetch(`/api/monitor/execution/${executionId}`);
        const exec = await response.json();
        
        if (response.ok) {
            // 填充模态框内容
            document.getElementById('detail-tool-name').textContent = exec.toolName || 'Unknown';
            document.getElementById('detail-execution-id').textContent = exec.id || 'N/A';
            document.getElementById('detail-status').textContent = getStatusText(exec.status);
            document.getElementById('detail-time').textContent = new Date(exec.startTime).toLocaleString('zh-CN');
            
            // 请求参数
            const requestData = {
                tool: exec.toolName,
                arguments: exec.arguments
            };
            document.getElementById('detail-request').textContent = JSON.stringify(requestData, null, 2);
            
            // 响应结果
            if (exec.result) {
                const responseData = {
                    content: exec.result.content,
                    isError: exec.result.isError
                };
                document.getElementById('detail-response').textContent = JSON.stringify(responseData, null, 2);
                document.getElementById('detail-response').className = exec.result.isError ? 'code-block error' : 'code-block';
            } else {
                document.getElementById('detail-response').textContent = '暂无响应数据';
            }
            
            // 错误信息
            if (exec.error) {
                document.getElementById('detail-error-section').style.display = 'block';
                document.getElementById('detail-error').textContent = exec.error;
            } else {
                document.getElementById('detail-error-section').style.display = 'none';
            }
            
            // 显示模态框
            document.getElementById('mcp-detail-modal').style.display = 'block';
        } else {
            alert('获取详情失败: ' + (exec.error || '未知错误'));
        }
    } catch (error) {
        alert('获取详情失败: ' + error.message);
    }
}

// 关闭MCP详情模态框
function closeMCPDetail() {
    document.getElementById('mcp-detail-modal').style.display = 'none';
}


// 工具函数
function getStatusText(status) {
    const statusMap = {
        'pending': '等待中',
        'running': '执行中',
        'completed': '已完成',
        'failed': '失败'
    };
    return statusMap[status] || status;
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
        return `${hours}小时${minutes % 60}分钟`;
    } else if (minutes > 0) {
        return `${minutes}分钟${seconds % 60}秒`;
    } else {
        return `${seconds}秒`;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatMarkdown(text) {
    // 配置 DOMPurify 允许的标签和属性
    const sanitizeConfig = {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
        ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class'],
        ALLOW_DATA_ATTR: false,
    };
    
    if (typeof DOMPurify !== 'undefined') {
        // 如果内容看起来已经是 HTML（包含 HTML 标签），直接清理
        // 否则先用 marked.js 解析 Markdown，再清理
        if (typeof marked !== 'undefined' && !/<[a-z][\s\S]*>/i.test(text)) {
            // 内容不包含 HTML 标签，可能是 Markdown，使用 marked.js 解析
            try {
                marked.setOptions({
                    breaks: true,
                    gfm: true,
                });
                let parsedContent = marked.parse(text);
                return DOMPurify.sanitize(parsedContent, sanitizeConfig);
            } catch (e) {
                console.error('Markdown 解析失败:', e);
                return DOMPurify.sanitize(text, sanitizeConfig);
            }
        } else {
            // 内容包含 HTML 标签或 marked.js 不可用，直接清理
            return DOMPurify.sanitize(text, sanitizeConfig);
        }
    } else if (typeof marked !== 'undefined') {
        // 没有 DOMPurify，但有 marked.js
        try {
            marked.setOptions({
                breaks: true,
                gfm: true,
            });
            return marked.parse(text);
        } catch (e) {
            console.error('Markdown 解析失败:', e);
            return escapeHtml(text).replace(/\n/g, '<br>');
        }
    } else {
        return escapeHtml(text).replace(/\n/g, '<br>');
    }
}

// 开始新对话
function startNewConversation() {
    currentConversationId = null;
    document.getElementById('chat-messages').innerHTML = '';
    addMessage('assistant', '系统已就绪。请输入您的测试需求，系统将自动执行相应的安全测试。');
    updateActiveConversation();
    // 刷新对话列表，确保显示最新的历史对话
    loadConversations();
}

// 加载对话列表
async function loadConversations() {
    try {
        const response = await apiFetch('/api/conversations?limit=50');
        const conversations = await response.json();
        
        const listContainer = document.getElementById('conversations-list');
        listContainer.innerHTML = '';
        
        if (conversations.length === 0) {
            listContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.875rem;">暂无历史对话</div>';
            return;
        }
        
        conversations.forEach(conv => {
            const item = document.createElement('div');
            item.className = 'conversation-item';
            item.dataset.conversationId = conv.id;
            if (conv.id === currentConversationId) {
                item.classList.add('active');
            }
            
            // 创建内容容器
            const contentWrapper = document.createElement('div');
            contentWrapper.className = 'conversation-content';
            
            const title = document.createElement('div');
            title.className = 'conversation-title';
            title.textContent = conv.title || '未命名对话';
            contentWrapper.appendChild(title);
            
            const time = document.createElement('div');
            time.className = 'conversation-time';
            // 解析时间，支持多种格式
            let dateObj;
            if (conv.updatedAt) {
                dateObj = new Date(conv.updatedAt);
                // 检查日期是否有效
                if (isNaN(dateObj.getTime())) {
                    // 如果解析失败，尝试其他格式
                    console.warn('时间解析失败:', conv.updatedAt);
                    dateObj = new Date();
                }
            } else {
                dateObj = new Date();
            }
            
            // 格式化时间显示
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const messageDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
            
            let timeText;
            if (messageDate.getTime() === today.getTime()) {
                // 今天：只显示时间
                timeText = dateObj.toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } else if (messageDate.getTime() === yesterday.getTime()) {
                // 昨天
                timeText = '昨天 ' + dateObj.toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } else if (now.getFullYear() === dateObj.getFullYear()) {
                // 今年：显示月日和时间
                timeText = dateObj.toLocaleString('zh-CN', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } else {
                // 去年或更早：显示完整日期和时间
                timeText = dateObj.toLocaleString('zh-CN', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            }
            
            time.textContent = timeText;
            contentWrapper.appendChild(time);
            
            item.appendChild(contentWrapper);
            
            // 创建删除按钮
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'conversation-delete-btn';
            deleteBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6M14 11v6" 
                          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            `;
            deleteBtn.title = '删除对话';
            deleteBtn.onclick = (e) => {
                e.stopPropagation(); // 阻止触发对话加载
                deleteConversation(conv.id);
            };
            item.appendChild(deleteBtn);
            
            item.onclick = () => loadConversation(conv.id);
            listContainer.appendChild(item);
        });
    } catch (error) {
        console.error('加载对话列表失败:', error);
    }
}

// 加载对话
async function loadConversation(conversationId) {
    try {
        const response = await apiFetch(`/api/conversations/${conversationId}`);
        const conversation = await response.json();
        
        if (!response.ok) {
            alert('加载对话失败: ' + (conversation.error || '未知错误'));
            return;
        }
        
        // 更新当前对话ID
        currentConversationId = conversationId;
        updateActiveConversation();
        
        // 清空消息区域
        const messagesDiv = document.getElementById('chat-messages');
        messagesDiv.innerHTML = '';
        
        // 加载消息
        if (conversation.messages && conversation.messages.length > 0) {
            conversation.messages.forEach(msg => {
                const messageId = addMessage(msg.role, msg.content, msg.mcpExecutionIds || []);
                // 如果有过程详情，显示它们
                if (msg.processDetails && msg.processDetails.length > 0 && msg.role === 'assistant') {
                    // 延迟一下，确保消息已经渲染
                    setTimeout(() => {
                        renderProcessDetails(messageId, msg.processDetails);
                    }, 100);
                }
            });
        } else {
            addMessage('assistant', '系统已就绪。请输入您的测试需求，系统将自动执行相应的安全测试。');
        }
        
        // 滚动到底部
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        
        // 刷新对话列表
        loadConversations();
    } catch (error) {
        console.error('加载对话失败:', error);
        alert('加载对话失败: ' + error.message);
    }
}

// 删除对话
async function deleteConversation(conversationId) {
    // 确认删除
    if (!confirm('确定要删除这个对话吗？此操作不可恢复。')) {
        return;
    }
    
    try {
        const response = await apiFetch(`/api/conversations/${conversationId}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '删除失败');
        }
        
        // 如果删除的是当前对话，清空对话界面
        if (conversationId === currentConversationId) {
            currentConversationId = null;
            document.getElementById('chat-messages').innerHTML = '';
            addMessage('assistant', '系统已就绪。请输入您的测试需求，系统将自动执行相应的安全测试。');
        }
        
        // 刷新对话列表
        loadConversations();
    } catch (error) {
        console.error('删除对话失败:', error);
        alert('删除对话失败: ' + error.message);
    }
}

// 更新活动对话样式
function updateActiveConversation() {
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.remove('active');
        if (currentConversationId && item.dataset.conversationId === currentConversationId) {
            item.classList.add('active');
        }
    });
}

// 加载活跃任务列表
async function loadActiveTasks(showErrors = false) {
    const bar = document.getElementById('active-tasks-bar');
    try {
        const response = await apiFetch('/api/agent-loop/tasks');
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(result.error || '获取活跃任务失败');
        }

        renderActiveTasks(result.tasks || []);
    } catch (error) {
        console.error('获取活跃任务失败:', error);
        if (showErrors && bar) {
            bar.style.display = 'block';
            bar.innerHTML = `<div class="active-task-error">无法获取任务状态：${escapeHtml(error.message)}</div>`;
        }
    }
}

function renderActiveTasks(tasks) {
    const bar = document.getElementById('active-tasks-bar');
    if (!bar) return;

    if (!tasks || tasks.length === 0) {
        bar.style.display = 'none';
        bar.innerHTML = '';
        return;
    }

    bar.style.display = 'flex';
    bar.innerHTML = '';

    tasks.forEach(task => {
        const item = document.createElement('div');
        item.className = 'active-task-item';

        const startedTime = task.startedAt ? new Date(task.startedAt) : null;
        const timeText = startedTime && !isNaN(startedTime.getTime())
            ? startedTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : '';

        item.innerHTML = `
            <div class="active-task-info">
                <span class="active-task-status">${task.status === 'cancelling' ? '取消中' : '执行中'}</span>
                <span class="active-task-message">${escapeHtml(task.message || '未命名任务')}</span>
            </div>
            <div class="active-task-actions">
                ${timeText ? `<span class="active-task-time">${timeText}</span>` : ''}
                <button class="active-task-cancel">停止任务</button>
            </div>
        `;

        const cancelBtn = item.querySelector('.active-task-cancel');
        cancelBtn.onclick = () => cancelActiveTask(task.conversationId, cancelBtn);
        if (task.status === 'cancelling') {
            cancelBtn.disabled = true;
            cancelBtn.textContent = '取消中...';
        }

        bar.appendChild(item);
    });
}

async function cancelActiveTask(conversationId, button) {
    if (!conversationId) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '取消中...';

    try {
        await requestCancel(conversationId);
        loadActiveTasks();
    } catch (error) {
        console.error('取消任务失败:', error);
        alert('取消任务失败: ' + error.message);
        button.disabled = false;
        button.textContent = originalText;
    }
}

// 设置相关功能
let currentConfig = null;
let allTools = [];
let toolsPagination = {
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0
};

// 打开设置
async function openSettings() {
    const modal = document.getElementById('settings-modal');
    modal.style.display = 'block';
    
    // 每次打开时重新加载最新配置
    await loadConfig();
    
    // 清除之前的验证错误状态
    document.querySelectorAll('.form-group input').forEach(input => {
        input.classList.remove('error');
    });
}

// 关闭设置
function closeSettings() {
    const modal = document.getElementById('settings-modal');
    modal.style.display = 'none';
}

// 点击模态框外部关闭
window.onclick = function(event) {
    const settingsModal = document.getElementById('settings-modal');
    const mcpModal = document.getElementById('mcp-detail-modal');
    const monitorModal = document.getElementById('monitor-modal');
    
    if (event.target === settingsModal) {
        closeSettings();
    }
    if (event.target === mcpModal) {
        closeMCPDetail();
    }
    if (event.target === monitorModal) {
        closeMonitorPanel();
    }
}

// 加载配置
async function loadConfig() {
    try {
        const response = await apiFetch('/api/config');
        if (!response.ok) {
            throw new Error('获取配置失败');
        }
        
        currentConfig = await response.json();
        
        // 填充OpenAI配置
        document.getElementById('openai-api-key').value = currentConfig.openai.api_key || '';
        document.getElementById('openai-base-url').value = currentConfig.openai.base_url || '';
        document.getElementById('openai-model').value = currentConfig.openai.model || '';
        
        // 填充Agent配置
        document.getElementById('agent-max-iterations').value = currentConfig.agent.max_iterations || 30;
        
        // 加载工具列表（使用分页）
        toolsSearchKeyword = '';
        await loadToolsList(1, '');
    } catch (error) {
        console.error('加载配置失败:', error);
        alert('加载配置失败: ' + error.message);
    }
}

// 工具搜索关键词
let toolsSearchKeyword = '';

// 加载工具列表（分页）
async function loadToolsList(page = 1, searchKeyword = '') {
    try {
        const pageSize = toolsPagination.pageSize;
        let url = `/api/config/tools?page=${page}&page_size=${pageSize}`;
        if (searchKeyword) {
            url += `&search=${encodeURIComponent(searchKeyword)}`;
        }
        
        const response = await apiFetch(url);
        if (!response.ok) {
            throw new Error('获取工具列表失败');
        }
        
        const result = await response.json();
        allTools = result.tools || [];
        toolsPagination = {
            page: result.page || page,
            pageSize: result.page_size || pageSize,
            total: result.total || 0,
            totalPages: result.total_pages || 1
        };
        
        renderToolsList();
        renderToolsPagination();
    } catch (error) {
        console.error('加载工具列表失败:', error);
        const toolsList = document.getElementById('tools-list');
        if (toolsList) {
            toolsList.innerHTML = `<div class="error">加载工具列表失败: ${escapeHtml(error.message)}</div>`;
        }
    }
}

// 搜索工具
function searchTools() {
    const searchInput = document.getElementById('tools-search');
    const keyword = searchInput ? searchInput.value.trim() : '';
    toolsSearchKeyword = keyword;
    // 搜索时重置到第一页
    loadToolsList(1, keyword);
}

// 清除搜索
function clearSearch() {
    const searchInput = document.getElementById('tools-search');
    if (searchInput) {
        searchInput.value = '';
    }
    toolsSearchKeyword = '';
    loadToolsList(1, '');
}

// 处理搜索框回车事件
function handleSearchKeyPress(event) {
    if (event.key === 'Enter') {
        searchTools();
    }
}

// 渲染工具列表
function renderToolsList() {
    const toolsList = document.getElementById('tools-list');
    if (!toolsList) return;
    
    // 只渲染列表部分，分页控件单独渲染
    const listContainer = toolsList.querySelector('.tools-list-items') || document.createElement('div');
    listContainer.className = 'tools-list-items';
    listContainer.innerHTML = '';
    
    if (allTools.length === 0) {
        listContainer.innerHTML = '<div class="empty">暂无工具</div>';
        if (!toolsList.contains(listContainer)) {
            toolsList.appendChild(listContainer);
        }
        return;
    }
    
    allTools.forEach(tool => {
        const toolItem = document.createElement('div');
        toolItem.className = 'tool-item';
        toolItem.dataset.toolName = tool.name; // 保存原始工具名称
        toolItem.innerHTML = `
            <input type="checkbox" id="tool-${tool.name}" ${tool.enabled ? 'checked' : ''} />
            <div class="tool-item-info">
                <div class="tool-item-name">${escapeHtml(tool.name)}</div>
                <div class="tool-item-desc">${escapeHtml(tool.description || '无描述')}</div>
            </div>
        `;
        listContainer.appendChild(toolItem);
    });
    
    if (!toolsList.contains(listContainer)) {
        toolsList.appendChild(listContainer);
    }
}

// 渲染工具列表分页控件
function renderToolsPagination() {
    const toolsList = document.getElementById('tools-list');
    if (!toolsList) return;
    
    // 移除旧的分页控件
    const oldPagination = toolsList.querySelector('.tools-pagination');
    if (oldPagination) {
        oldPagination.remove();
    }
    
    // 如果只有一页或没有数据，不显示分页
    if (toolsPagination.totalPages <= 1) {
        return;
    }
    
    const pagination = document.createElement('div');
    pagination.className = 'tools-pagination';
    
    const { page, totalPages, total } = toolsPagination;
    const startItem = (page - 1) * toolsPagination.pageSize + 1;
    const endItem = Math.min(page * toolsPagination.pageSize, total);
    
    pagination.innerHTML = `
        <div class="pagination-info">
            显示 ${startItem}-${endItem} / 共 ${total} 个工具${toolsSearchKeyword ? ` (搜索: "${escapeHtml(toolsSearchKeyword)}")` : ''}
        </div>
        <div class="pagination-controls">
            <button class="btn-secondary" onclick="loadToolsList(1, '${escapeHtml(toolsSearchKeyword)}')" ${page === 1 ? 'disabled' : ''}>首页</button>
            <button class="btn-secondary" onclick="loadToolsList(${page - 1}, '${escapeHtml(toolsSearchKeyword)}')" ${page === 1 ? 'disabled' : ''}>上一页</button>
            <span class="pagination-page">第 ${page} / ${totalPages} 页</span>
            <button class="btn-secondary" onclick="loadToolsList(${page + 1}, '${escapeHtml(toolsSearchKeyword)}')" ${page === totalPages ? 'disabled' : ''}>下一页</button>
            <button class="btn-secondary" onclick="loadToolsList(${totalPages}, '${escapeHtml(toolsSearchKeyword)}')" ${page === totalPages ? 'disabled' : ''}>末页</button>
        </div>
    `;
    
    toolsList.appendChild(pagination);
}

// 全选工具
function selectAllTools() {
    document.querySelectorAll('#tools-list input[type="checkbox"]').forEach(checkbox => {
        checkbox.checked = true;
    });
}

// 全不选工具
function deselectAllTools() {
    document.querySelectorAll('#tools-list input[type="checkbox"]').forEach(checkbox => {
        checkbox.checked = false;
    });
}

// 过滤工具（已废弃，现在使用服务端搜索）
// 保留此函数以防其他地方调用，但实际功能已由searchTools()替代
function filterTools() {
    // 不再使用客户端过滤，改为触发服务端搜索
    // 可以保留为空函数或移除oninput事件
}

// 应用设置
async function applySettings() {
    try {
        // 清除之前的验证错误状态
        document.querySelectorAll('.form-group input').forEach(input => {
            input.classList.remove('error');
        });
        
        // 验证必填字段
        const apiKey = document.getElementById('openai-api-key').value.trim();
        const baseUrl = document.getElementById('openai-base-url').value.trim();
        const model = document.getElementById('openai-model').value.trim();
        
        let hasError = false;
        
        if (!apiKey) {
            document.getElementById('openai-api-key').classList.add('error');
            hasError = true;
        }
        
        if (!baseUrl) {
            document.getElementById('openai-base-url').classList.add('error');
            hasError = true;
        }
        
        if (!model) {
            document.getElementById('openai-model').classList.add('error');
            hasError = true;
        }
        
        if (hasError) {
            alert('请填写所有必填字段（标记为 * 的字段）');
            return;
        }
        
        // 收集配置
        const config = {
            openai: {
                api_key: apiKey,
                base_url: baseUrl,
                model: model
            },
            agent: {
                max_iterations: parseInt(document.getElementById('agent-max-iterations').value) || 30
            },
            tools: []
        };
        
        // 收集工具启用状态
        // 由于使用分页，需要先获取所有工具的状态
        // 先获取当前页的工具状态
        const currentPageTools = new Map();
        document.querySelectorAll('#tools-list .tool-item').forEach(item => {
            const checkbox = item.querySelector('input[type="checkbox"]');
            const toolName = item.dataset.toolName;
            if (toolName) {
                currentPageTools.set(toolName, checkbox.checked);
            }
        });
        
        // 获取所有工具列表以获取完整状态
        try {
            const allToolsResponse = await apiFetch(`/api/config/tools?page=1&page_size=1000`);
            if (allToolsResponse.ok) {
                const allToolsResult = await allToolsResponse.json();
                // 使用所有工具，但用当前页的修改覆盖
                allToolsResult.tools.forEach(tool => {
                    config.tools.push({
                        name: tool.name,
                        enabled: currentPageTools.has(tool.name) ? currentPageTools.get(tool.name) : tool.enabled
                    });
                });
            } else {
                // 如果获取失败，只使用当前页的工具
                currentPageTools.forEach((enabled, toolName) => {
                    config.tools.push({
                        name: toolName,
                        enabled: enabled
                    });
                });
            }
        } catch (error) {
            console.warn('获取所有工具列表失败，仅使用当前页工具状态', error);
            // 如果获取失败，只使用当前页的工具
            currentPageTools.forEach((enabled, toolName) => {
                config.tools.push({
                    name: toolName,
                    enabled: enabled
                });
            });
        }
        
        // 更新配置
        const updateResponse = await apiFetch('/api/config', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });
        
        if (!updateResponse.ok) {
            const error = await updateResponse.json();
            throw new Error(error.error || '更新配置失败');
        }
        
        // 应用配置
        const applyResponse = await apiFetch('/api/config/apply', {
            method: 'POST'
        });
        
        if (!applyResponse.ok) {
            const error = await applyResponse.json();
            throw new Error(error.error || '应用配置失败');
        }
        
        alert('配置已成功应用！');
        closeSettings();
    } catch (error) {
        console.error('应用配置失败:', error);
        alert('应用配置失败: ' + error.message);
    }
}

function resetPasswordForm() {
    const currentInput = document.getElementById('auth-current-password');
    const newInput = document.getElementById('auth-new-password');
    const confirmInput = document.getElementById('auth-confirm-password');

    [currentInput, newInput, confirmInput].forEach(input => {
        if (input) {
            input.value = '';
            input.classList.remove('error');
        }
    });
}

async function changePassword() {
    const currentInput = document.getElementById('auth-current-password');
    const newInput = document.getElementById('auth-new-password');
    const confirmInput = document.getElementById('auth-confirm-password');
    const submitBtn = document.querySelector('.change-password-submit');

    [currentInput, newInput, confirmInput].forEach(input => input && input.classList.remove('error'));

    const currentPassword = currentInput?.value.trim() || '';
    const newPassword = newInput?.value.trim() || '';
    const confirmPassword = confirmInput?.value.trim() || '';

    let hasError = false;

    if (!currentPassword) {
        currentInput?.classList.add('error');
        hasError = true;
    }

    if (!newPassword || newPassword.length < 8) {
        newInput?.classList.add('error');
        hasError = true;
    }

    if (newPassword !== confirmPassword) {
        confirmInput?.classList.add('error');
        hasError = true;
    }

    if (hasError) {
        alert('请正确填写当前密码和新密码，新密码至少 8 位且需要两次输入一致。');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
    }

    try {
        const response = await apiFetch('/api/auth/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                oldPassword: currentPassword,
                newPassword: newPassword
            })
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || '修改密码失败');
        }

        alert('密码已更新，请使用新密码重新登录。');
        resetPasswordForm();
        handleUnauthorized({ message: '密码已更新，请使用新密码重新登录。', silent: false });
        closeSettings();
    } catch (error) {
        console.error('修改密码失败:', error);
        alert('修改密码失败: ' + error.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
        }
    }
}


// 监控面板状态
const monitorState = {
    executions: [],
    stats: {},
    lastFetchedAt: null,
    pagination: {
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 0
    }
};

function openMonitorPanel() {
    const modal = document.getElementById('monitor-modal');
    if (!modal) {
        return;
    }
    modal.style.display = 'block';

    // 重置显示状态
    const statsContainer = document.getElementById('monitor-stats');
    const execContainer = document.getElementById('monitor-executions');
    if (statsContainer) {
        statsContainer.innerHTML = '<div class="monitor-empty">加载中...</div>';
    }
    if (execContainer) {
        execContainer.innerHTML = '<div class="monitor-empty">加载中...</div>';
    }

    const statusFilter = document.getElementById('monitor-status-filter');
    if (statusFilter) {
        statusFilter.value = 'all';
    }

    // 重置分页状态
    monitorState.pagination = {
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 0
    };

    refreshMonitorPanel(1);
}

function closeMonitorPanel() {
    const modal = document.getElementById('monitor-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

async function refreshMonitorPanel(page = null) {
    const statsContainer = document.getElementById('monitor-stats');
    const execContainer = document.getElementById('monitor-executions');

    try {
        // 如果指定了页码，使用指定页码，否则使用当前页码
        const currentPage = page !== null ? page : monitorState.pagination.page;
        const pageSize = monitorState.pagination.pageSize;
        
        const response = await apiFetch(`/api/monitor?page=${currentPage}&page_size=${pageSize}`, { method: 'GET' });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || '获取监控数据失败');
        }

        monitorState.executions = Array.isArray(result.executions) ? result.executions : [];
        monitorState.stats = result.stats || {};
        monitorState.lastFetchedAt = new Date();
        
        // 更新分页信息
        if (result.total !== undefined) {
            monitorState.pagination = {
                page: result.page || currentPage,
                pageSize: result.page_size || pageSize,
                total: result.total || 0,
                totalPages: result.total_pages || 1
            };
        }

        renderMonitorStats(monitorState.stats, monitorState.lastFetchedAt);
        renderMonitorExecutions(monitorState.executions);
        renderMonitorPagination();
    } catch (error) {
        console.error('刷新监控面板失败:', error);
        if (statsContainer) {
            statsContainer.innerHTML = `<div class="monitor-error">无法加载统计信息：${escapeHtml(error.message)}</div>`;
        }
        if (execContainer) {
            execContainer.innerHTML = `<div class="monitor-error">无法加载执行记录：${escapeHtml(error.message)}</div>`;
        }
    }
}

function applyMonitorFilters() {
    const statusFilter = document.getElementById('monitor-status-filter');
    const status = statusFilter ? statusFilter.value : 'all';
    renderMonitorExecutions(monitorState.executions, status);
}

function renderMonitorStats(statsMap = {}, lastFetchedAt = null) {
    const container = document.getElementById('monitor-stats');
    if (!container) {
        return;
    }

    const entries = Object.values(statsMap);
    if (entries.length === 0) {
        container.innerHTML = '<div class="monitor-empty">暂无统计数据</div>';
        return;
    }

    // 计算总体汇总
    const totals = entries.reduce(
        (acc, item) => {
            acc.total += item.totalCalls || 0;
            acc.success += item.successCalls || 0;
            acc.failed += item.failedCalls || 0;
            const lastCall = item.lastCallTime ? new Date(item.lastCallTime) : null;
            if (lastCall && (!acc.lastCallTime || lastCall > acc.lastCallTime)) {
                acc.lastCallTime = lastCall;
            }
            return acc;
        },
        { total: 0, success: 0, failed: 0, lastCallTime: null }
    );

    const successRate = totals.total > 0 ? ((totals.success / totals.total) * 100).toFixed(1) : '0.0';
    const lastUpdatedText = lastFetchedAt ? lastFetchedAt.toLocaleString('zh-CN') : 'N/A';
    const lastCallText = totals.lastCallTime ? totals.lastCallTime.toLocaleString('zh-CN') : '暂无调用';

    let html = `
        <div class="monitor-stat-card">
            <h4>总调用次数</h4>
            <div class="monitor-stat-value">${totals.total}</div>
            <div class="monitor-stat-meta">成功 ${totals.success} / 失败 ${totals.failed}</div>
        </div>
        <div class="monitor-stat-card">
            <h4>成功率</h4>
            <div class="monitor-stat-value">${successRate}%</div>
            <div class="monitor-stat-meta">统计自全部工具调用</div>
        </div>
        <div class="monitor-stat-card">
            <h4>最近一次调用</h4>
            <div class="monitor-stat-value" style="font-size:1rem;">${lastCallText}</div>
            <div class="monitor-stat-meta">最后刷新时间：${lastUpdatedText}</div>
        </div>
    `;

    // 显示最多前4个工具的统计
    const topTools = entries
        .slice()
        .sort((a, b) => (b.totalCalls || 0) - (a.totalCalls || 0))
        .slice(0, 4);

    topTools.forEach(tool => {
        const toolSuccessRate = tool.totalCalls > 0 ? ((tool.successCalls || 0) / tool.totalCalls * 100).toFixed(1) : '0.0';
        html += `
            <div class="monitor-stat-card">
                <h4>${escapeHtml(tool.toolName || '未知工具')}</h4>
                <div class="monitor-stat-value">${tool.totalCalls || 0}</div>
                <div class="monitor-stat-meta">
                    成功 ${tool.successCalls || 0} / 失败 ${tool.failedCalls || 0} · 成功率 ${toolSuccessRate}%
                </div>
            </div>
        `;
    });

    container.innerHTML = `<div class="monitor-stats-grid">${html}</div>`;
}

function renderMonitorExecutions(executions = [], statusFilter = 'all') {
    const container = document.getElementById('monitor-executions');
    if (!container) {
        return;
    }

    if (!Array.isArray(executions) || executions.length === 0) {
        container.innerHTML = '<div class="monitor-empty">暂无执行记录</div>';
        return;
    }

    const normalizedStatus = statusFilter === 'all' ? null : statusFilter;
    const filtered = normalizedStatus
        ? executions.filter(exec => (exec.status || '').toLowerCase() === normalizedStatus)
        : executions;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="monitor-empty">当前筛选条件下暂无记录</div>';
        return;
    }

    const rows = filtered
        .map(exec => {
            const status = (exec.status || 'unknown').toLowerCase();
            const statusClass = `monitor-status-chip ${status}`;
            const statusLabel = getStatusText(status);
            const startTime = exec.startTime ? new Date(exec.startTime).toLocaleString('zh-CN') : '未知';
            const duration = formatExecutionDuration(exec.startTime, exec.endTime);
            const toolName = escapeHtml(exec.toolName || '未知工具');
            const executionId = escapeHtml(exec.id || '');
            return `
                <tr>
                    <td>${toolName}</td>
                    <td><span class="${statusClass}">${statusLabel}</span></td>
                    <td>${startTime}</td>
                    <td>${duration}</td>
                    <td>
                        <div class="monitor-execution-actions">
                            <button class="btn-secondary" onclick="showMCPDetail('${executionId}')">查看详情</button>
                        </div>
                    </td>
                </tr>
            `;
        })
        .join('');

    // 创建表格容器
    const tableContainer = document.createElement('div');
    tableContainer.className = 'monitor-table-container';
    tableContainer.innerHTML = `
        <table class="monitor-table">
            <thead>
                <tr>
                    <th>工具</th>
                    <th>状态</th>
                    <th>开始时间</th>
                    <th>耗时</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
    
    // 清空容器并添加表格
    container.innerHTML = '';
    container.appendChild(tableContainer);
}

// 渲染监控面板分页控件
function renderMonitorPagination() {
    const container = document.getElementById('monitor-executions');
    if (!container) return;
    
    // 移除旧的分页控件
    const oldPagination = container.querySelector('.monitor-pagination');
    if (oldPagination) {
        oldPagination.remove();
    }
    
    const { page, totalPages, total, pageSize } = monitorState.pagination;
    
    // 如果只有一页或没有数据，不显示分页
    if (totalPages <= 1 || total === 0) {
        return;
    }
    
    const pagination = document.createElement('div');
    pagination.className = 'monitor-pagination';
    
    const startItem = (page - 1) * pageSize + 1;
    const endItem = Math.min(page * pageSize, total);
    
    pagination.innerHTML = `
        <div class="pagination-info">
            显示 ${startItem}-${endItem} / 共 ${total} 条记录
        </div>
        <div class="pagination-controls">
            <button class="btn-secondary" onclick="refreshMonitorPanel(1)" ${page === 1 ? 'disabled' : ''}>首页</button>
            <button class="btn-secondary" onclick="refreshMonitorPanel(${page - 1})" ${page === 1 ? 'disabled' : ''}>上一页</button>
            <span class="pagination-page">第 ${page} / ${totalPages} 页</span>
            <button class="btn-secondary" onclick="refreshMonitorPanel(${page + 1})" ${page === totalPages ? 'disabled' : ''}>下一页</button>
            <button class="btn-secondary" onclick="refreshMonitorPanel(${totalPages})" ${page === totalPages ? 'disabled' : ''}>末页</button>
        </div>
    `;
    
    container.appendChild(pagination);
}


function formatExecutionDuration(start, end) {
    if (!start) {
        return '未知';
    }
    const startTime = new Date(start);
    const endTime = end ? new Date(end) : new Date();
    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
        return '未知';
    }
    const diffMs = Math.max(0, endTime - startTime);
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) {
        return `${seconds} 秒`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        const remain = seconds % 60;
        return remain > 0 ? `${minutes} 分 ${remain} 秒` : `${minutes} 分`;
    }
    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return remainMinutes > 0 ? `${hours} 小时 ${remainMinutes} 分` : `${hours} 小时`;
}
