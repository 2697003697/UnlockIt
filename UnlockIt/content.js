/*
 * 免责声明：
 * 本脚本为教育和学习用途而开发，旨在帮助用户了解网页元素的控制与交互操作。
 * 使用本脚本即表示用户同意自行承担由此带来的一切风险和后果，开发者不对因使用本脚本
 * 造成的任何直接或间接损失负责。
 * 
 * 请勿使用本脚本用于任何违反服务条款、侵害他人权益或违反当地法律法规的行为。
 * 建议仅在个人测试环境中使用，不建议用于生产环境或未经授权的网页。
 * 
 * 使用前请务必仔细阅读本免责声明，开发者保留随时更改或终止该脚本的权利。
 */

(function () {
    'use strict';

    // ==================== 配置和常量 ====================
    const CONFIG = {
        VERSION: '8.1.0',
        STORAGE_KEY: 'unlockSettings',
        DEBUG: false,
        MAX_RETRY_ATTEMPTS: 3,
        RETRY_DELAY: 100,
        DEBOUNCE_DELAY: 100,
        THROTTLE_DELAY: 16 // ~60fps
    };

    // 默认设置 - 默认关闭状态
    const DEFAULT_SETTINGS = Object.freeze({
        mainEnabled: false,
        copyEnabled: true,
        pasteEnabled: true,
        inputEnabled: true,
        version: CONFIG.VERSION
    });

    // ==================== 日志系统 ====================
    const Logger = {
        prefix: '[UnlockIt]',
        
        log(...args) {
            if (CONFIG.DEBUG) {
                console.log(this.prefix, ...args);
            }
        },
        
        warn(...args) {
            console.warn(this.prefix, ...args);
        },
        
        error(...args) {
            console.error(this.prefix, ...args);
        },
        
        info(...args) {
            console.info(this.prefix, ...args);
        }
    };

    // ==================== 错误处理 ====================
    const ErrorHandler = {
        wrap(fn, context = '') {
            return function(...args) {
                try {
                    return fn.apply(this, args);
                } catch (error) {
                    Logger.error(`Error in ${context}:`, error);
                    return undefined;
                }
            };
        },

        async wrapAsync(fn, context = '') {
            return async function(...args) {
                try {
                    return await fn.apply(this, args);
                } catch (error) {
                    Logger.error(`Async error in ${context}:`, error);
                    return undefined;
                }
            };
        }
    };

    // ==================== 工具函数 ====================
    const Utils = {
        // 防抖函数
        debounce(fn, delay) {
            let timeoutId;
            return function(...args) {
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => fn.apply(this, args), delay);
            };
        },

        // 节流函数
        throttle(fn, delay) {
            let lastTime = 0;
            return function(...args) {
                const now = Date.now();
                if (now - lastTime >= delay) {
                    lastTime = now;
                    fn.apply(this, args);
                }
            };
        },

        // 重试机制
        async retry(fn, attempts = CONFIG.MAX_RETRY_ATTEMPTS, delay = CONFIG.RETRY_DELAY) {
            for (let i = 0; i < attempts; i++) {
                try {
                    return await fn();
                } catch (error) {
                    if (i === attempts - 1) throw error;
                    await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
                }
            }
        },

        // 安全地访问对象属性
        safeGet(obj, path, defaultValue = undefined) {
            try {
                return path.split('.').reduce((o, p) => o?.[p], obj) ?? defaultValue;
            } catch {
                return defaultValue;
            }
        },

        // 验证设置对象
        validateSettings(settings) {
            if (!settings || typeof settings !== 'object') {
                return { ...DEFAULT_SETTINGS };
            }
            
            const validated = { ...DEFAULT_SETTINGS };
            
            if (typeof settings.mainEnabled === 'boolean') {
                validated.mainEnabled = settings.mainEnabled;
            }
            if (typeof settings.copyEnabled === 'boolean') {
                validated.copyEnabled = settings.copyEnabled;
            }
            if (typeof settings.pasteEnabled === 'boolean') {
                validated.pasteEnabled = settings.pasteEnabled;
            }
            if (typeof settings.inputEnabled === 'boolean') {
                validated.inputEnabled = settings.inputEnabled;
            }
            
            return validated;
        },

        // 检查元素是否在视口内
        isInViewport(element) {
            const rect = element.getBoundingClientRect();
            return (
                rect.top >= 0 &&
                rect.left >= 0 &&
                rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                rect.right <= (window.innerWidth || document.documentElement.clientWidth)
            );
        }
    };

    // ==================== Toast 提示模块 ====================
    const Toast = {
        show(message, type = 'success', duration = 2000) {
            const toast = document.createElement('div');
            toast.className = 'unlock-toast';
            
            const colors = {
                success: { bg: '#10b981', icon: '✓' },
                error: { bg: '#ef4444', icon: '✕' },
                info: { bg: '#3b82f6', icon: 'ℹ' },
                warning: { bg: '#f59e0b', icon: '⚠' }
            };
            
            const config = colors[type] || colors.success;
            
            Object.assign(toast.style, {
                position: 'fixed',
                top: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                padding: '12px 20px',
                backgroundColor: config.bg,
                color: '#fff',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: '500',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                zIndex: '2147483647',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                opacity: '0',
                transition: 'opacity 0.3s, transform 0.3s'
            });
            
            toast.innerHTML = `<span style="font-size:16px;">${config.icon}</span><span>${message}</span>`;
            
            document.body.appendChild(toast);
            
            requestAnimationFrame(() => {
                toast.style.opacity = '1';
            });
            
            setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => toast.remove(), 300);
            }, duration);
        }
    };

    // ==================== 状态管理 ====================
    const State = {
        settings: { ...DEFAULT_SETTINGS },
        observers: new Set(),
        eventListeners: new Set(),
        initialized: false,
        targetElement: null,
        featureCleanupFns: [],
        
        // 更新设置
        updateSettings(newSettings) {
            const oldSettings = { ...this.settings };
            this.settings = Utils.validateSettings(newSettings);
            Logger.log('Settings updated:', this.settings);
            
            // 如果主开关状态改变，执行相应的启用/禁用
            if (oldSettings.mainEnabled !== this.settings.mainEnabled) {
                if (this.settings.mainEnabled) {
                    App.enableFeatures();
                } else {
                    App.disableFeatures();
                }
            }
        },

        // 注册观察者
        registerObserver(observer) {
            this.observers.add(observer);
        },

        // 断开所有观察者
        disconnectAllObservers() {
            this.observers.forEach(observer => {
                try {
                    observer.disconnect();
                } catch (e) {
                    Logger.warn('Failed to disconnect observer:', e);
                }
            });
            this.observers.clear();
        },

        // 注册事件监听器
        registerEventListener(element, type, listener, options) {
            element.addEventListener(type, listener, options);
            this.eventListeners.add({ element, type, listener, options });
        },

        // 清理所有事件监听器
        cleanupEventListeners() {
            this.eventListeners.forEach(({ element, type, listener, options }) => {
                try {
                    element.removeEventListener(type, listener, options);
                } catch (e) {
                    Logger.warn('Failed to remove event listener:', e);
                }
            });
            this.eventListeners.clear();
        },

        // 添加功能清理函数
        addFeatureCleanup(fn) {
            this.featureCleanupFns.push(fn);
        },

        // 执行所有功能清理
        runFeatureCleanup() {
            this.featureCleanupFns.forEach(fn => {
                try {
                    fn();
                } catch (e) {
                    Logger.warn('Feature cleanup failed:', e);
                }
            });
            this.featureCleanupFns = [];
        },

        // 完全清理
        cleanup() {
            this.disconnectAllObservers();
            this.cleanupEventListeners();
            this.runFeatureCleanup();
            this.targetElement = null;
        }
    };

    // ==================== 存储管理 ====================
    const Storage = {
        async getSettings() {
            try {
                const result = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
                return Utils.validateSettings(result[CONFIG.STORAGE_KEY]);
            } catch (error) {
                Logger.error('Failed to get settings from storage:', error);
                return { ...DEFAULT_SETTINGS };
            }
        },

        async saveSettings(settings) {
            try {
                const validated = Utils.validateSettings(settings);
                await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: validated });
                return true;
            } catch (error) {
                Logger.error('Failed to save settings:', error);
                return false;
            }
        },

        async resetSettings() {
            try {
                await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: { ...DEFAULT_SETTINGS } });
                return true;
            } catch (error) {
                Logger.error('Failed to reset settings:', error);
                return false;
            }
        }
    };

    // ==================== 消息通信 ====================
    const Messaging = {
        init() {
            // 监听来自popup/background的消息
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                ErrorHandler.wrap(() => {
                    this.handleMessage(message, sender, sendResponse);
                }, 'message handler')();
                return true; // 保持消息通道开放
            });
        },

        handleMessage(message, sender, sendResponse) {
            switch (message.type) {
                case 'settingsUpdated':
                case 'settingsChanged':
                    const oldEnabled = State.settings.mainEnabled;
                    State.updateSettings(message.settings);
                    if (message.settings.mainEnabled) {
                        App.enableFeatures();
                        if (!oldEnabled) {
                            Toast.show('插件已启用', 'success');
                        }
                    } else {
                        App.disableFeatures();
                        if (oldEnabled) {
                            Toast.show('插件已禁用', 'info');
                        }
                    }
                    sendResponse({ success: true });
                    break;

                case 'openFloatingInput':
                    if (State.settings.mainEnabled && State.settings.inputEnabled) {
                        State.targetElement = document.activeElement;
                        FloatingInput.create();
                        sendResponse({ success: true });
                    } else {
                        sendResponse({ success: false, error: 'Plugin or input feature disabled' });
                    }
                    break;

                case 'getSettings':
                    sendResponse({ settings: State.settings });
                    break;

                case 'ping':
                    sendResponse({ pong: true, version: CONFIG.VERSION });
                    break;

                case 'showToast':
                    Toast.show(message.message, message.toastType || 'success');
                    sendResponse({ success: true });
                    break;

                default:
                    sendResponse({ error: 'Unknown message type' });
            }
        },

        async notifyAllTabs(settings) {
            try {
                const tabs = await chrome.tabs.query({});
                const promises = tabs.map(tab => 
                    chrome.tabs.sendMessage(tab.id, {
                        type: 'settingsUpdated',
                        settings: settings
                    }).catch(() => null)
                );
                await Promise.all(promises);
            } catch (error) {
                Logger.error('Failed to notify tabs:', error);
            }
        }
    };

    // ==================== 页面类型检测 ====================
    const PageDetector = {
        types: {
            feishu: /feishu\.cn|larkoffice\.com/i,
            chaoxing: /chaoxing\.com/i,
            pintia: /pintia\.cn/i,
            csdn: /csdn\.net/i,
            juejin: /juejin\.cn/i,
            zhihu: /zhihu\.com/i,
            baidu: /baidu\.com/i,
            baiduwenku: /wenku\.baidu\.com/i,
            docin: /docin\.com|doc88\.com/i,
            educoder: /educoder\.net/i,
            weixin: /mp\.weixin\.qq\.com/i,
            cnki: /cnki\.net|cnki\.com\.cn|kns\.cnki\.net/i
        },

        detect() {
            const hostname = window.location.hostname;
            const detected = [];

            for (const [name, pattern] of Object.entries(this.types)) {
                if (pattern.test(hostname)) {
                    detected.push(name);
                }
            }

            Logger.log('Detected page types:', detected);
            return detected;
        },

        is(type) {
            return this.types[type]?.test(window.location.hostname) ?? false;
        }
    };

    // ==================== 复制限制检测 ====================
    const CopyRestrictionDetector = {
        // 检测页面是否有复制限制
        detect() {
            const restrictions = [];

            // 1. 检测 CSS 限制
            if (this.hasCssRestriction()) {
                restrictions.push('CSS限制');
            }

            // 2. 检测事件监听
            if (this.hasEventRestriction()) {
                restrictions.push('事件拦截');
            }

            // 3. 检测特定网站
            const siteType = this.detectSiteType();
            if (siteType) {
                restrictions.push(`${siteType}特定限制`);
            }

            // 4. 检测常见遮罩
            if (this.hasLoginMask()) {
                restrictions.push('登录遮罩');
            }

            Logger.log('Detected restrictions:', restrictions);
            return {
                hasRestriction: restrictions.length > 0,
                restrictions: restrictions,
                siteType: siteType
            };
        },

        // 检测 CSS 限制
        hasCssRestriction() {
            const testElements = document.querySelectorAll('article, .content, .article, [class*="content"]');
            for (const el of testElements) {
                const style = window.getComputedStyle(el);
                if (style.userSelect === 'none' ||
                    style.webkitUserSelect === 'none' ||
                    style.msUserSelect === 'none' ||
                    style.MozUserSelect === 'none') {
                    return true;
                }
            }
            return false;
        },

        // 检测事件限制
        hasEventRestriction() {
            // 检查是否有阻止复制的事件监听
            const events = ['copy', 'cut', 'paste', 'contextmenu', 'selectstart'];
            // 这里只能检测内联事件，无法检测 addEventListener
            for (const event of events) {
                const listeners = document.querySelectorAll(`[on${event}]`);
                if (listeners.length > 0) {
                    return true;
                }
            }
            return false;
        },

        // 检测网站类型
        detectSiteType() {
            for (const [name, pattern] of Object.entries(PageDetector.types)) {
                if (pattern.test(window.location.hostname)) {
                    return name;
                }
            }
            return null;
        },

        // 检测登录遮罩
        hasLoginMask() {
            const selectors = [
                '.passport-login-mark',
                '.login-mark',
                '.login-mask',
                '[class*="vip-mask"]',
                '[class*="paywall"]'
            ];

            for (const selector of selectors) {
                if (document.querySelector(selector)) {
                    return true;
                }
            }
            return false;
        },

        // 通知 background 显示提示
        async notifyRestrictionDetected(result) {
            if (!result.hasRestriction) return;

            try {
                await chrome.runtime.sendMessage({
                    type: 'restrictionDetected',
                    data: result,
                    url: window.location.href,
                    hostname: window.location.hostname
                });
            } catch (error) {
                Logger.error('Failed to notify restriction:', error);
            }
        }
    };

    // ==================== Shadow DOM 处理 ====================
    const ShadowDOMHandler = {
        // 存储已处理的 Shadow Root，避免重复处理
        processedRoots: new WeakSet(),

        // 递归处理所有 Shadow DOM
        processAllShadowRoots(root = document) {
            if (!State.settings.mainEnabled) return;

            // 处理当前根下的所有元素
            this.processElements(root);

            // 查找所有带有 Shadow Root 的元素
            const allElements = root.querySelectorAll('*');
            allElements.forEach(el => {
                if (el.shadowRoot && !this.processedRoots.has(el.shadowRoot)) {
                    this.processedRoots.add(el.shadowRoot);
                    this.processAllShadowRoots(el.shadowRoot);

                    // 监听 Shadow DOM 的变化
                    this.observeShadowDOM(el.shadowRoot);
                }
            });
        },

        // 处理元素（解锁 CSS 限制）
        processElements(root) {
            const elements = root.querySelectorAll('*');
            elements.forEach(el => {
                try {
                    el.style.userSelect = 'text';
                    el.style.webkitUserSelect = 'text';
                    el.style.msUserSelect = 'text';
                    el.style.MozUserSelect = 'text';
                    el.style.pointerEvents = 'auto';
                } catch (e) {
                    // 忽略跨域 Shadow DOM 错误
                }
            });
        },

        // 观察 Shadow DOM 变化
        observeShadowDOM(shadowRoot) {
            const observer = new MutationObserver(
                Utils.throttle(() => {
                    if (State.settings.mainEnabled) {
                        this.processAllShadowRoots(shadowRoot);
                    }
                }, CONFIG.THROTTLE_DELAY)
            );

            observer.observe(shadowRoot, {
                childList: true,
                subtree: true
            });

            State.registerObserver(observer);
        },

        // 初始化 Shadow DOM 监听
        init() {
            // 监听整个文档的 Shadow DOM 创建
            const observer = new MutationObserver(() => {
                if (State.settings.mainEnabled) {
                    this.processAllShadowRoots();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            State.registerObserver(observer);

            // 立即处理现有的 Shadow DOM
            this.processAllShadowRoots();
        }
    };

    // ==================== iframe 处理 ====================
    const IframeHandler = {
        // 存储已处理的 iframe
        processedIframes: new WeakSet(),

        // 处理所有 iframe
        processAllIframes() {
            if (!State.settings.mainEnabled) return;

            const iframes = document.querySelectorAll('iframe');
            iframes.forEach(iframe => this.processIframe(iframe));
        },

        // 处理单个 iframe
        processIframe(iframe) {
            if (this.processedIframes.has(iframe)) return;
            this.processedIframes.add(iframe);

            try {
                // 尝试访问 iframe 内容（同源）
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDoc) {
                    this.unlockIframeContent(iframeDoc);
                    this.observeIframe(iframe, iframeDoc);
                }
            } catch (e) {
                // 跨域 iframe 无法访问，尝试通过注入脚本
                this.injectScriptToIframe(iframe);
            }
        },

        // 解锁 iframe 内容
        unlockIframeContent(doc) {
            // 解锁 CSS
            const elements = doc.querySelectorAll('*');
            elements.forEach(el => {
                try {
                    el.style.userSelect = 'text';
                    el.style.webkitUserSelect = 'text';
                    el.style.pointerEvents = 'auto';
                } catch (e) {
                    // 忽略错误
                }
            });

            // 移除事件限制
            const events = ['copy', 'cut', 'paste', 'contextmenu', 'selectstart'];
            events.forEach(eventName => {
                doc.addEventListener(eventName, (e) => {
                    if (State.settings.mainEnabled) {
                        e.stopImmediatePropagation();
                    }
                }, true);
            });
        },

        // 观察 iframe 变化
        observeIframe(iframe, doc) {
            const observer = new MutationObserver(
                Utils.throttle(() => {
                    if (State.settings.mainEnabled) {
                        this.unlockIframeContent(doc);
                    }
                }, CONFIG.THROTTLE_DELAY)
            );

            observer.observe(doc.body, {
                childList: true,
                subtree: true
            });
        },

        // 向跨域 iframe 注入脚本（通过 postMessage）
        injectScriptToIframe(iframe) {
            // 尝试发送消息给 iframe（如果 iframe 内部有相应处理）
            try {
                iframe.contentWindow?.postMessage({
                    type: 'UNLOCK_COPY_PASTE',
                    enabled: State.settings.mainEnabled
                }, '*');
            } catch (e) {
                // 忽略跨域错误
            }
        },

        // 初始化 iframe 监听
        init() {
            // 处理现有 iframe
            this.processAllIframes();

            // 监听新创建的 iframe
            const observer = new MutationObserver((mutations) => {
                if (!State.settings.mainEnabled) return;

                mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.tagName === 'IFRAME') {
                            this.processIframe(node);
                        } else if (node.querySelectorAll) {
                            const iframes = node.querySelectorAll('iframe');
                            iframes.forEach(iframe => this.processIframe(iframe));
                        }
                    });
                });
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            State.registerObserver(observer);
        }
    };

    // ==================== 智能 DOM 观察器 ====================
    const SmartDOMObserver = {
        // 观察器实例
        mainObserver: null,
        // 批量处理队列
        pendingMutations: [],
        // 批量处理定时器
        batchTimer: null,
        // 观察的元素集合（避免重复观察）
        observedElements: new WeakSet(),
        // 性能统计
        stats: {
            processedMutations: 0,
            skippedMutations: 0,
            startTime: Date.now()
        },

        // 初始化
        init() {
            if (this.mainObserver) return;

            this.mainObserver = new MutationObserver((mutations) => {
                if (!State.settings.mainEnabled) return;
                this.handleMutations(mutations);
            });

            // 配置观察选项
            const config = {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class', 'disabled', 'readonly']
            };

            // 观察 body
            if (document.body) {
                this.mainObserver.observe(document.body, config);
                this.observedElements.add(document.body);
            }

            // 立即执行一次解锁
            this.batchProcess();

            Logger.info('Smart DOM Observer initialized');
        },

        // 处理变更
        handleMutations(mutations) {
            // 过滤有效变更
            const validMutations = mutations.filter(m => this.isValidMutation(m));

            if (validMutations.length === 0) return;

            // 加入队列
            this.pendingMutations.push(...validMutations);

            // 防抖批量处理
            clearTimeout(this.batchTimer);
            this.batchTimer = setTimeout(() => {
                this.batchProcess();
            }, CONFIG.THROTTLE_DELAY);
        },

        // 判断是否为有效变更
        isValidMutation(mutation) {
            // 跳过文本内容变化
            if (mutation.type === 'characterData') return false;

            // 跳过某些特定元素的变化
            const target = mutation.target;
            if (target.nodeType !== Node.ELEMENT_NODE) return false;

            // 跳过脚本和样式标签
            const tagName = target.tagName?.toLowerCase();
            if (tagName === 'script' || tagName === 'style' || tagName === 'link') {
                return false;
            }

            // 跳过已处理的元素
            if (mutation.type === 'attributes' && target.getAttribute('data-unlock-processed')) {
                return false;
            }

            return true;
        },

        // 批量处理
        batchProcess() {
            if (this.pendingMutations.length === 0) return;

            const mutations = this.pendingMutations.splice(0);
            const elementsToProcess = new Set();

            // 收集需要处理的元素
            mutations.forEach(mutation => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            elementsToProcess.add(node);
                            // 包含子元素
                            if (node.querySelectorAll) {
                                node.querySelectorAll('*').forEach(el => elementsToProcess.add(el));
                            }
                        }
                    });
                } else if (mutation.type === 'attributes') {
                    elementsToProcess.add(mutation.target);
                }
            });

            // 批量处理元素
            this.processElements(Array.from(elementsToProcess));

            this.stats.processedMutations += mutations.length;
        },

        // 处理元素
        processElements(elements) {
            elements.forEach(el => {
                try {
                    // 标记已处理
                    el.setAttribute?.('data-unlock-processed', 'true');

                    // 解锁 CSS
                    if (el.style) {
                        el.style.userSelect = 'text';
                        el.style.webkitUserSelect = 'text';
                        el.style.pointerEvents = 'auto';
                    }

                    // 移除禁用属性
                    if (el.hasAttribute?.('disabled')) {
                        el.removeAttribute('disabled');
                    }
                    if (el.hasAttribute?.('readonly')) {
                        el.removeAttribute('readonly');
                    }

                    // 处理特定类名
                    const className = el.className;
                    if (typeof className === 'string') {
                        if (className.includes('mask') ||
                            className.includes('overlay') ||
                            className.includes('blur')) {
                            el.style.display = 'none';
                        }
                    }
                } catch (e) {
                    // 忽略单个元素错误
                }
            });

            // 执行全局解锁
            UnlockFeatures.removeVipMask();
            UnlockFeatures.unlockCssRestrictions();
        },

        // 断开观察
        disconnect() {
            if (this.mainObserver) {
                this.mainObserver.disconnect();
                this.mainObserver = null;
            }
            clearTimeout(this.batchTimer);
            this.pendingMutations = [];
        },

        // 获取统计信息
        getStats() {
            return {
                ...this.stats,
                uptime: Date.now() - this.stats.startTime
            };
        }
    };

    // ==================== 核心功能模块 ====================
    const UnlockFeatures = {
        // 移除VIP遮罩层和登录遮罩
        removeVipMask: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;
            
            const maskSelectors = [
                'div[class*="hide-article"]',
                'div[class*="vip-mask"]',
                'div[class*="paywall"]',
                'div[class*="overlay"]',
                '.article-mask',
                '.content-mask',
                '[class*="blur"]',
                // 登录相关遮罩
                '.passport-login-mark',
                '.login-mark',
                '.login-mask',
                '[class*="login-mark"]',
                '[class*="login-mask"]',
                '[class*="passport-mask"]'
            ];
            
            maskSelectors.forEach(selector => {
                try {
                    const elements = document.querySelectorAll(selector);
                    elements.forEach(el => {
                        el.style.display = 'none';
                        el.style.visibility = 'hidden';
                        el.style.opacity = '0';
                        el.remove();
                    });
                } catch (e) {
                    Logger.warn('Failed to remove mask:', e);
                }
            });

            // 恢复body滚动
            document.body.style.overflow = 'auto';
            document.body.style.pointerEvents = 'auto';
            document.documentElement.style.overflow = 'auto';
        }, 'removeVipMask'),

        // 解锁CSS限制
        unlockCssRestrictions: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            const processElement = (el) => {
                if (!el || !el.getAttribute) return;
                
                try {
                    if (!el.getAttribute('data-unlock-applied')) {
                        el.style.userSelect = 'text';
                        el.style.webkitUserSelect = 'text';
                        el.style.msUserSelect = 'text';
                        el.style.MozUserSelect = 'text';
                        el.style.pointerEvents = 'auto';
                        el.setAttribute('data-unlock-applied', 'true');
                    }
                    
                    // 处理 Shadow DOM
                    if (el.shadowRoot) {
                        el.shadowRoot.querySelectorAll('*').forEach(processElement);
                    }
                } catch (e) {
                    // 忽略单个元素错误
                }
            };

            document.querySelectorAll('*').forEach(processElement);
        }, 'unlockCssRestrictions'),

        // 移除特定事件监听器
        removeSpecificEventListeners: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled || !State.settings.copyEnabled) return;

            const events = ['copy', 'cut', 'paste', 'contextmenu', 'selectstart', 'dragstart'];
            
            events.forEach(eventName => {
                State.registerEventListener(
                    document.body,
                    eventName,
                    (e) => {
                        if (State.settings.mainEnabled && State.settings.copyEnabled) {
                            e.stopImmediatePropagation();
                        }
                    },
                    true
                );
            });
        }, 'removeSpecificEventListeners'),

        // 拦截XHR请求
        interceptXHR: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            const rawOpen = XMLHttpRequest.prototype.open;
            const rawSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                this._unlockUrl = url;
                return rawOpen.apply(this, [method, url, ...rest]);
            };

            XMLHttpRequest.prototype.send = function(...args) {
                this.addEventListener('readystatechange', ErrorHandler.wrap(() => {
                    if (this.readyState === 4 && State.settings.mainEnabled) {
                        try {
                            const contentType = this.getResponseHeader('content-type');
                            if (contentType && contentType.includes('application/json')) {
                                const jsonResponse = JSON.parse(this.responseText);
                                
                                // 修改复制权限
                                if (Utils.safeGet(jsonResponse, 'data.actions.copy') !== undefined) {
                                    jsonResponse.data.actions.copy = 1;
                                    Object.defineProperty(this, 'responseText', {
                                        value: JSON.stringify(jsonResponse),
                                        writable: false
                                    });
                                }
                            }
                        } catch (e) {
                            // 忽略非JSON响应
                        }
                    }
                }, 'XHR interceptor'));
                
                return rawSend.apply(this, args);
            };
        }, 'interceptXHR'),

        // 拦截Fetch请求
        interceptFetch: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            const rawFetch = window.fetch;
            
            window.fetch = async function(...args) {
                const response = await rawFetch.apply(this, args);
                
                if (!State.settings.mainEnabled) return response;

                try {
                    const contentType = response.headers.get('content-type');
                    if (contentType && contentType.includes('application/json')) {
                        const clone = response.clone();
                        const data = await clone.json();
                        
                        // 修改复制权限
                        if (Utils.safeGet(data, 'data.actions.copy') !== undefined) {
                            data.data.actions.copy = 1;
                            
                            // 创建新的响应
                            return new Response(JSON.stringify(data), {
                                status: response.status,
                                statusText: response.statusText,
                                headers: response.headers
                            });
                        }
                    }
                } catch (e) {
                    // 忽略处理错误
                }
                
                return response;
            };
        }, 'interceptFetch'),

        // 观察DOM变化
        observeDOMChanges: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            const observer = new MutationObserver(
                Utils.throttle(() => {
                    if (State.settings.mainEnabled) {
                        this.removeVipMask();
                        this.unlockCssRestrictions();
                    }
                }, CONFIG.THROTTLE_DELAY)
            );

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            });

            State.registerObserver(observer);
        }, 'observeDOMChanges'),

        // 自定义复制处理
        customCopyHandler: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled || !State.settings.copyEnabled) return;

            State.registerEventListener(
                document,
                'keydown',
                (e) => {
                    if (State.settings.mainEnabled && 
                        State.settings.copyEnabled && 
                        e.ctrlKey && 
                        e.key === 'c') {
                        e.preventDefault();
                        e.stopPropagation();
                        
                        try {
                            const selection = window.getSelection();
                            if (selection && selection.toString()) {
                                navigator.clipboard.writeText(selection.toString())
                                    .then(() => {
                                        Logger.log('Content copied to clipboard!');
                                        Toast.show('复制成功', 'success');
                                    })
                                    .catch(err => {
                                        document.execCommand('copy');
                                        Toast.show('复制成功', 'success');
                                    });
                            }
                        } catch (err) {
                            Logger.error('Copy operation failed:', err);
                            Toast.show('复制失败', 'error');
                        }
                    }
                },
                true
            );
        }, 'customCopyHandler')
    };

    // ==================== 浮动输入框模块 ====================
    const FloatingInput = {
        currentBox: null,
        isPaused: false,
        currentSpeed: 'normal',
        speedSettings: {
            slow: { delay: 100, label: '慢速' },
            normal: { delay: 50, label: '正常' },
            fast: { delay: 20, label: '快速' }
        },
        typingState: {
            isTyping: false,
            currentIndex: 0,
            chars: [],
            element: null,
            timeoutId: null
        },

        create: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled || !State.settings.inputEnabled) return;
            if (FloatingInput.currentBox) return;

            const box = document.createElement('div');
            box.id = 'unlock-floating-input-box';
            Object.assign(box.style, {
                position: 'fixed',
                top: '20px',
                right: '20px',
                width: '320px',
                padding: '16px',
                backgroundColor: '#ffffff',
                border: '1px solid #e0e0e0',
                borderRadius: '12px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
                zIndex: '2147483647',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            });

            // 头部
            const header = document.createElement('div');
            header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';

            const title = document.createElement('span');
            title.textContent = '🔓 模拟人工输入';
            title.style.cssText = 'font-weight:600;font-size:14px;color:#333;';

            const closeBtn = document.createElement('button');
            closeBtn.innerHTML = '✕';
            closeBtn.style.cssText = 'border:none;background:none;cursor:pointer;font-size:16px;color:#666;padding:4px;';
            closeBtn.onclick = () => FloatingInput.destroy();

            header.appendChild(title);
            header.appendChild(closeBtn);

            // 文本区域
            const textarea = document.createElement('textarea');
            textarea.style.cssText = `
                width: 100%;
                height: 100px;
                border: 1px solid #ddd;
                border-radius: 8px;
                padding: 10px;
                resize: none;
                font-family: inherit;
                font-size: 14px;
                line-height: 1.5;
                box-sizing: border-box;
            `;
            textarea.placeholder = '在此粘贴内容，按 Enter 开始输入...\n按 Shift+Enter 换行';

            // 速度选择器
            const speedRow = document.createElement('div');
            speedRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:12px;';

            const speedLabel = document.createElement('span');
            speedLabel.textContent = '输入速度:';
            speedLabel.style.cssText = 'font-size:12px;color:#666;';

            const speedSelect = document.createElement('select');
            speedSelect.style.cssText = `
                padding: 4px 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                font-size: 12px;
                cursor: pointer;
            `;
            Object.entries(FloatingInput.speedSettings).forEach(([key, value]) => {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = value.label;
                if (key === 'normal') option.selected = true;
                speedSelect.appendChild(option);
            });
            speedSelect.onchange = (e) => {
                FloatingInput.currentSpeed = e.target.value;
            };

            speedRow.appendChild(speedLabel);
            speedRow.appendChild(speedSelect);

            // 按钮组
            const btnGroup = document.createElement('div');
            btnGroup.style.cssText = 'display:flex;gap:8px;margin-top:12px;';

            const startBtn = document.createElement('button');
            startBtn.textContent = '开始输入';
            startBtn.style.cssText = `
                flex: 1;
                padding: 8px 16px;
                background: #4f46e5;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
            `;

            const pauseBtn = document.createElement('button');
            pauseBtn.textContent = '暂停';
            pauseBtn.style.cssText = `
                flex: 1;
                padding: 8px 16px;
                background: #f59e0b;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                display: none;
            `;

            const pasteBtn = document.createElement('button');
            pasteBtn.textContent = '直接粘贴';
            pasteBtn.style.cssText = `
                flex: 1;
                padding: 8px 16px;
                background: #f3f4f6;
                color: #374151;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
            `;

            btnGroup.appendChild(startBtn);
            btnGroup.appendChild(pauseBtn);
            btnGroup.appendChild(pasteBtn);

            // 进度条
            const progressContainer = document.createElement('div');
            progressContainer.style.cssText = 'margin-top:8px;display:none;';
            
            const progressBar = document.createElement('div');
            progressBar.style.cssText = `
                width: 100%;
                height: 4px;
                background: #e5e7eb;
                border-radius: 2px;
                overflow: hidden;
            `;
            
            const progressFill = document.createElement('div');
            progressFill.style.cssText = `
                width: 0%;
                height: 100%;
                background: #4f46e5;
                transition: width 0.1s;
            `;
            
            progressBar.appendChild(progressFill);
            progressContainer.appendChild(progressBar);

            box.appendChild(header);
            box.appendChild(textarea);
            box.appendChild(speedRow);
            box.appendChild(btnGroup);
            box.appendChild(progressContainer);

            // 事件处理
            const targetElement = State.targetElement || document.activeElement;

            const updateUI = (isTyping) => {
                if (isTyping) {
                    startBtn.textContent = '停止';
                    startBtn.style.background = '#ef4444';
                    pauseBtn.style.display = 'block';
                    pasteBtn.style.display = 'none';
                    progressContainer.style.display = 'block';
                    textarea.disabled = true;
                    speedSelect.disabled = true;
                } else {
                    startBtn.textContent = '开始输入';
                    startBtn.style.background = '#4f46e5';
                    pauseBtn.style.display = 'none';
                    pasteBtn.style.display = 'block';
                    progressContainer.style.display = 'none';
                    textarea.disabled = false;
                    speedSelect.disabled = false;
                    FloatingInput.isPaused = false;
                    pauseBtn.textContent = '暂停';
                }
            };

            startBtn.onclick = () => {
                if (FloatingInput.typingState.isTyping) {
                    FloatingInput.stopTyping();
                    updateUI(false);
                } else {
                    const text = textarea.value;
                    if (text && targetElement) {
                        FloatingInput.typeText(targetElement, text, progressFill);
                        updateUI(true);
                    }
                }
            };

            pauseBtn.onclick = () => {
                FloatingInput.isPaused = !FloatingInput.isPaused;
                pauseBtn.textContent = FloatingInput.isPaused ? '继续' : '暂停';
                if (!FloatingInput.isPaused) {
                    FloatingInput.continueTyping(progressFill);
                }
            };

            pasteBtn.onclick = async () => {
                try {
                    const text = await navigator.clipboard.readText();
                    textarea.value = text;
                } catch (e) {
                    textarea.focus();
                    document.execCommand('paste');
                }
            };

            textarea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    startBtn.click();
                } else if (e.key === 'Escape') {
                    FloatingInput.destroy();
                }
            });

            // 点击外部关闭
            const outsideClickHandler = (e) => {
                if (!box.contains(e.target)) {
                    FloatingInput.destroy();
                    document.removeEventListener('mousedown', outsideClickHandler);
                }
            };
            
            setTimeout(() => {
                document.addEventListener('mousedown', outsideClickHandler);
            }, 100);

            document.body.appendChild(box);
            FloatingInput.currentBox = box;
            textarea.focus();
        }, 'FloatingInput.create'),

        destroy() {
            FloatingInput.stopTyping();
            if (FloatingInput.currentBox && FloatingInput.currentBox.parentNode) {
                FloatingInput.currentBox.parentNode.removeChild(FloatingInput.currentBox);
                FloatingInput.currentBox = null;
            }
        },

        stopTyping() {
            if (FloatingInput.typingState.timeoutId) {
                clearTimeout(FloatingInput.typingState.timeoutId);
            }
            FloatingInput.typingState = {
                isTyping: false,
                currentIndex: 0,
                chars: [],
                element: null,
                timeoutId: null
            };
        },

        typeText: ErrorHandler.wrap((element, text, progressFill) => {
            if (!State.settings.mainEnabled || !State.settings.inputEnabled) return;

            FloatingInput.typingState = {
                isTyping: true,
                currentIndex: 0,
                chars: text.split(''),
                element: element,
                timeoutId: null,
                progressFill: progressFill
            };

            FloatingInput.continueTyping(progressFill);
        }, 'FloatingInput.typeText'),

        continueTyping: ErrorHandler.wrap((progressFill) => {
            const state = FloatingInput.typingState;
            if (!state.isTyping) return;

            const typeNext = () => {
                if (FloatingInput.isPaused) return;
                
                if (state.currentIndex >= state.chars.length || !FloatingInput.currentBox) {
                    FloatingInput.stopTyping();
                    Toast.show('输入完成', 'success');
                    FloatingInput.destroy();
                    return;
                }

                if (!State.settings.mainEnabled || !State.settings.inputEnabled) {
                    FloatingInput.stopTyping();
                    FloatingInput.destroy();
                    return;
                }

                const char = state.chars[state.currentIndex];
                FloatingInput.insertChar(state.element, char);
                state.currentIndex++;

                if (progressFill) {
                    const progress = (state.currentIndex / state.chars.length) * 100;
                    progressFill.style.width = `${progress}%`;
                }

                const avgDelay = FloatingInput.speedSettings[FloatingInput.currentSpeed].delay;
                const randomDelay = avgDelay + (Math.random() - 0.5) * 30;
                state.timeoutId = setTimeout(typeNext, Math.max(10, randomDelay));
            };

            typeNext();
        }, 'FloatingInput.continueTyping'),

        insertChar: ErrorHandler.wrap((element, char) => {
            if (!element) return;

            element.focus();

            if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                const start = element.selectionStart || 0;
                const end = element.selectionEnd || 0;
                const value = element.value || '';
                
                element.value = value.substring(0, start) + char + value.substring(end);
                element.selectionStart = element.selectionEnd = start + 1;
                
                // 触发输入事件
                element.dispatchEvent(new InputEvent('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (element.isContentEditable) {
                document.execCommand('insertText', false, char);
            }
        }, 'FloatingInput.insertChar')
    };

    // ==================== 特定网站处理 ====================
    const SiteHandlers = {
        // 飞书处理
        feishu: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            // 重写事件监听
            const rawAddEventListener = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function(type, listener, options) {
                if (State.settings.mainEnabled && ['copy', 'contextmenu', 'cut'].includes(type)) {
                    const wrappedListener = (event) => {
                        if (State.settings.mainEnabled) {
                            event.stopImmediatePropagation();
                        }
                        return listener(event);
                    };
                    return rawAddEventListener.call(this, type, wrappedListener, options);
                }
                return rawAddEventListener.call(this, type, listener, options);
            };

            UnlockFeatures.interceptXHR();
            UnlockFeatures.interceptFetch();
        }, 'SiteHandlers.feishu'),

        // PTA处理
        pintia: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            const enableTextSelection = () => {
                const styles = {
                    userSelect: 'text',
                    webkitUserSelect: 'text',
                    msUserSelect: 'text',
                    MozUserSelect: 'text'
                };
                Object.assign(document.body.style, styles);
            };

            const unlockClipboard = () => {
                ['copy', 'paste', 'drop', 'beforeinput', 'cut'].forEach(eventName => {
                    State.registerEventListener(document, eventName, (e) => {
                        if (State.settings.mainEnabled) {
                            e.stopPropagation();
                        }
                    }, true);
                });
            };

            enableTextSelection();
            unlockClipboard();

            const observer = new MutationObserver(() => {
                if (State.settings.mainEnabled) {
                    enableTextSelection();
                    unlockClipboard();
                }
            });

            observer.observe(document, { childList: true, subtree: true });
            State.registerObserver(observer);
        }, 'SiteHandlers.pintia'),

        // 超星处理
        chaoxing: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;
            if (typeof jQuery === 'undefined') return;

            jQuery(function($) {
                setTimeout(() => {
                    if (!State.settings.mainEnabled) return;
                    
                    $('body').removeAttr('onselectstart');
                    $('html').css('user-select', 'unset');
                    
                    if (typeof UE !== 'undefined' && UE.EventBase?.prototype) {
                        UE.EventBase.prototype.fireEvent = () => null;
                    }
                }, 1000);

                // 添加复制按钮
                const isNewMooc = window.location.href.includes('newMooc=true');
                const buttonHtml = `<div style='background:#86b430;display:inline-block;border:solid 1px #6f8e30;color:#FFF;padding:4px 12px;cursor:pointer;border-radius:4px;font-size:13px;margin:4px 0;' class='unlock-copy-btn'>📋 复制题目</div>`;
                
                if (isNewMooc) {
                    $(buttonHtml).insertAfter('.colorShallow');
                } else {
                    $(buttonHtml).insertAfter('.Cy_TItle p');
                }

                // 复制功能
                $(document).on('click', '.unlock-copy-btn', function(e) {
                    if (!State.settings.mainEnabled || !State.settings.copyEnabled) return;
                    
                    const $btn = $(this);
                    const $target = isNewMooc ? $btn.next() : $btn.parent().find('p');
                    
                    try {
                        const range = document.createRange();
                        const selection = window.getSelection();
                        selection.removeAllRanges();
                        range.selectNodeContents($target[0]);
                        selection.addRange(range);
                        document.execCommand('copy');
                        selection.removeAllRanges();
                        
                        const originalText = $btn.text();
                        $btn.text('✅ 复制成功');
                        setTimeout(() => $btn.text(originalText), 1500);
                    } catch (err) {
                        Logger.error('Copy failed:', err);
                    }
                });
            });
        }, 'SiteHandlers.chaoxing'),

        // CSDN处理
        csdn: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            // 移除登录遮罩和容器
            const removeLoginMask = () => {
                // 移除遮罩和登录相关元素
                const selectors = [
                    '.login-mark',
                    '.login-box',
                    '#passportbox',
                    '.hide-article-box',
                    '.article-mask',
                    '.passport-login-mark',
                    '.passport-login-container'
                ];
                
                selectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        el.remove();
                    });
                });

                // 确保body可交互
                document.body.style.pointerEvents = 'auto';
                document.body.style.overflow = 'auto';
                document.documentElement.style.overflow = 'auto';
            };

            removeLoginMask();

            const observer = new MutationObserver(removeLoginMask);
            observer.observe(document.body, { childList: true, subtree: true });
            State.registerObserver(observer);
        }, 'SiteHandlers.csdn'),

        // 豆丁网处理
        docin: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            // 豆丁网使用 Flash 或 Canvas 展示文档，需要特殊处理
            const unlockDocin = () => {
                // 1. 移除遮罩层
                const maskSelectors = [
                    '.docin-mask',
                    '.docin-login-mask',
                    '.docin-vip-mask',
                    '.docin-overlay',
                    '[class*="docin-mask"]',
                    '[class*="docin-login"]',
                    '[class*="docin-vip"]',
                    '.mask',
                    '.overlay',
                    '.login-popup',
                    '.vip-popup'
                ];

                maskSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        el.style.display = 'none';
                        el.style.visibility = 'hidden';
                        el.style.pointerEvents = 'none';
                    });
                });

                // 2. 解锁文本选择
                document.body.style.userSelect = 'text';
                document.body.style.webkitUserSelect = 'text';
                document.documentElement.style.userSelect = 'text';

                // 3. 移除事件限制
                ['copy', 'cut', 'paste', 'contextmenu', 'selectstart', 'mousedown', 'mouseup'].forEach(eventName => {
                    document.addEventListener(eventName, (e) => {
                        if (State.settings.mainEnabled) {
                            e.stopImmediatePropagation();
                        }
                    }, true);
                });

                // 4. 处理 Canvas 元素（豆丁网使用 Canvas 渲染文档）
                const canvases = document.querySelectorAll('canvas');
                canvases.forEach(canvas => {
                    canvas.style.pointerEvents = 'auto';
                    canvas.style.userSelect = 'text';
                });

                // 5. 处理文档内容区域
                const contentSelectors = [
                    '.docin-content',
                    '.docin-page',
                    '.docin-viewer',
                    '.doc-content',
                    '.page-content',
                    '#content',
                    '.content'
                ];

                contentSelectors.forEach(selector => {
                    const elements = document.querySelectorAll(selector);
                    elements.forEach(el => {
                        el.style.userSelect = 'text';
                        el.style.webkitUserSelect = 'text';
                        el.style.pointerEvents = 'auto';
                    });
                });

                // 6. 重写事件监听拦截
                const originalAddEventListener = EventTarget.prototype.addEventListener;
                EventTarget.prototype.addEventListener = function(type, listener, options) {
                    if (State.settings.mainEnabled && 
                        ['copy', 'cut', 'paste', 'contextmenu', 'selectstart'].includes(type)) {
                        return; // 完全阻止这些事件的监听
                    }
                    return originalAddEventListener.call(this, type, listener, options);
                };
            };

            unlockDocin();

            // 持续监听并解锁
            const observer = new MutationObserver(() => {
                if (State.settings.mainEnabled) {
                    unlockDocin();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            });

            State.registerObserver(observer);

            Logger.info('Docin handler initialized');
        }, 'SiteHandlers.docin'),

        // 头歌实践教学平台处理
        educoder: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            const unlockEducoder = () => {
                // 1. 解锁代码编辑器（CodeMirror、Monaco Editor 等）
                const editorSelectors = [
                    '.CodeMirror',
                    '.monaco-editor',
                    '.ace_editor',
                    '[class*="editor"]',
                    '[class*="code"]',
                    'textarea',
                    'input'
                ];

                editorSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        // 解锁文本选择
                        el.style.userSelect = 'text';
                        el.style.webkitUserSelect = 'text';
                        el.style.pointerEvents = 'auto';

                        // 移除只读属性
                        if (el.hasAttribute('readonly')) {
                            el.removeAttribute('readonly');
                        }
                        if (el.hasAttribute('disabled')) {
                            el.removeAttribute('disabled');
                        }

                        // 处理 CodeMirror
                        if (el.classList.contains('CodeMirror')) {
                            el.classList.remove('CodeMirror-readonly');
                            const cm = el.CodeMirror;
                            if (cm && cm.setOption) {
                                cm.setOption('readOnly', false);
                            }
                        }

                        // 处理 Monaco Editor
                        if (el.classList.contains('monaco-editor')) {
                            el.setAttribute('contenteditable', 'true');
                        }
                    });
                });

                // 2. 移除事件拦截
                ['copy', 'cut', 'paste', 'contextmenu', 'selectstart', 'keydown', 'keyup'].forEach(eventName => {
                    document.addEventListener(eventName, (e) => {
                        if (State.settings.mainEnabled) {
                            // 允许 Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+M
                            if (e.ctrlKey || e.metaKey) {
                                e.stopImmediatePropagation();
                                return true;
                            }
                        }
                    }, true);
                });

                // 3. 重写 addEventListener 阻止编辑器拦截
                const originalAddEventListener = EventTarget.prototype.addEventListener;
                EventTarget.prototype.addEventListener = function(type, listener, options) {
                    if (State.settings.mainEnabled) {
                        // 包装监听器，允许我们的快捷键
                        const wrappedListener = function(event) {
                            // 允许 Ctrl+M 呼出输入框
                            if (event.ctrlKey && event.key === 'm') {
                                return;
                            }
                            // 允许复制粘贴快捷键
                            if ((event.ctrlKey || event.metaKey) &&
                                ['c', 'v', 'x', 'a'].includes(event.key.toLowerCase())) {
                                return;
                            }
                            return listener.call(this, event);
                        };
                        return originalAddEventListener.call(this, type, wrappedListener, options);
                    }
                    return originalAddEventListener.call(this, type, listener, options);
                };

                // 4. 处理 iframe 中的编辑器
                document.querySelectorAll('iframe').forEach(iframe => {
                    try {
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                        if (iframeDoc) {
                            // 在 iframe 中也执行解锁
                            ['copy', 'cut', 'paste', 'contextmenu', 'selectstart'].forEach(eventName => {
                                iframeDoc.addEventListener(eventName, (e) => {
                                    if (State.settings.mainEnabled) {
                                        e.stopImmediatePropagation();
                                    }
                                }, true);
                            });
                        }
                    } catch (e) {
                        // 跨域 iframe 忽略
                    }
                });

                // 5. 移除遮罩和弹窗
                const maskSelectors = [
                    '.modal',
                    '.popup',
                    '.overlay',
                    '.mask',
                    '[class*="modal"]',
                    '[class*="popup"]',
                    '[class*="overlay"]'
                ];

                maskSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        if (el.textContent.includes('复制') ||
                            el.textContent.includes('粘贴') ||
                            el.textContent.includes('权限')) {
                            el.style.display = 'none';
                        }
                    });
                });
            };

            unlockEducoder();

            // 持续监听
            const observer = new MutationObserver(() => {
                if (State.settings.mainEnabled) {
                    unlockEducoder();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true
            });

            State.registerObserver(observer);

            Logger.info('Educoder handler initialized');
        }, 'SiteHandlers.educoder'),

        // 百度文库处理
        baiduwenku: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            const unlockBaiduWenku = () => {
                // 1. 移除付费遮罩和登录弹窗
                const maskSelectors = [
                    '.pay-pop',
                    '.payt-money',
                    '.doc-vip',
                    '.vip-privilege',
                    '.try-end-fold-page',
                    '.read-all',
                    '.purchase-wrapper',
                    '.layer-wrap',
                    '.experience-card',
                    '[class*="pay-"]',
                    '[class*="vip-"]',
                    '[class*="login-"]',
                    '.reader-copy'
                ];

                maskSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        el.style.display = 'none';
                        el.remove();
                    });
                });

                // 2. 解锁文本选择
                const contentSelectors = [
                    '.reader-content',
                    '.doc-reader',
                    '.ie-fix',
                    '.reader-wrap',
                    '.content-wrapper'
                ];

                contentSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        el.style.userSelect = 'text';
                        el.style.webkitUserSelect = 'text';
                        el.style.pointerEvents = 'auto';
                    });
                });

                // 3. 解锁全局选择
                document.body.style.userSelect = 'text';
                document.body.style.webkitUserSelect = 'text';

                // 4. 移除事件限制
                ['copy', 'cut', 'paste', 'contextmenu', 'selectstart', 'mousedown'].forEach(eventName => {
                    document.addEventListener(eventName, (e) => {
                        if (State.settings.mainEnabled) {
                            e.stopImmediatePropagation();
                        }
                    }, true);
                });
            };

            unlockBaiduWenku();

            const observer = new MutationObserver(() => {
                if (State.settings.mainEnabled) {
                    unlockBaiduWenku();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            });

            State.registerObserver(observer);
            Logger.info('Baidu Wenku handler initialized');
        }, 'SiteHandlers.baiduwenku'),

        // 微信公众号处理
        weixin: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            const unlockWeixin = () => {
                // 1. 解锁文本选择
                const contentSelectors = [
                    '#js_content',
                    '.rich_media_content',
                    '.rich_media_area_primary'
                ];

                contentSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        el.style.userSelect = 'text';
                        el.style.webkitUserSelect = 'text';
                        el.style.pointerEvents = 'auto';
                    });
                });

                // 2. 移除复制限制
                ['copy', 'cut', 'contextmenu', 'selectstart'].forEach(eventName => {
                    document.addEventListener(eventName, (e) => {
                        if (State.settings.mainEnabled) {
                            e.stopImmediatePropagation();
                        }
                    }, true);
                });

                // 3. 移除可能的遮罩
                document.querySelectorAll('[class*="mask"], [class*="overlay"]').forEach(el => {
                    if (el.style.position === 'fixed' || el.style.position === 'absolute') {
                        el.style.display = 'none';
                    }
                });
            };

            unlockWeixin();

            const observer = new MutationObserver(() => {
                if (State.settings.mainEnabled) {
                    unlockWeixin();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            State.registerObserver(observer);
            Logger.info('Weixin handler initialized');
        }, 'SiteHandlers.weixin'),

        // 知网处理
        cnki: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            const unlockCNKI = () => {
                // 1. 解锁文本选择
                const contentSelectors = [
                    '.article-content',
                    '.content',
                    '#content',
                    '.txt',
                    '.article-text',
                    '.brief',
                    '.abstract'
                ];

                contentSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        el.style.userSelect = 'text';
                        el.style.webkitUserSelect = 'text';
                        el.style.pointerEvents = 'auto';
                    });
                });

                // 2. 移除登录遮罩
                const maskSelectors = [
                    '.login-mask',
                    '.vip-mask',
                    '.pay-mask',
                    '[class*="login"]',
                    '[class*="vip"]',
                    '.modal',
                    '.popup'
                ];

                maskSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        el.style.display = 'none';
                    });
                });

                // 3. 移除事件限制
                ['copy', 'cut', 'paste', 'contextmenu', 'selectstart'].forEach(eventName => {
                    document.addEventListener(eventName, (e) => {
                        if (State.settings.mainEnabled) {
                            e.stopImmediatePropagation();
                        }
                    }, true);
                });

                // 4. 全局解锁
                document.body.style.userSelect = 'text';
                document.body.style.webkitUserSelect = 'text';
            };

            unlockCNKI();

            const observer = new MutationObserver(() => {
                if (State.settings.mainEnabled) {
                    unlockCNKI();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true
            });

            State.registerObserver(observer);
            Logger.info('CNKI handler initialized');
        }, 'SiteHandlers.cnki'),

        // 知乎专栏处理
        zhihu: ErrorHandler.wrap(() => {
            if (!State.settings.mainEnabled) return;

            const unlockZhihu = () => {
                // 1. 解锁文本选择
                const contentSelectors = [
                    '.Post-RichText',
                    '.RichText',
                    '.RichContent-inner',
                    '.ArticleItem-content',
                    '.Post-content'
                ];

                contentSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        el.style.userSelect = 'text';
                        el.style.webkitUserSelect = 'text';
                    });
                });

                // 2. 移除登录弹窗
                const loginSelectors = [
                    '.Modal-wrapper',
                    '.signFlowModal',
                    '.LoginModal',
                    '[class*="Login"]',
                    '[class*="login"]'
                ];

                loginSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        if (el.textContent.includes('登录') || el.textContent.includes('注册')) {
                            el.style.display = 'none';
                        }
                    });
                });

                // 3. 移除复制限制
                ['copy', 'cut', 'contextmenu', 'selectstart'].forEach(eventName => {
                    document.addEventListener(eventName, (e) => {
                        if (State.settings.mainEnabled) {
                            e.stopImmediatePropagation();
                        }
                    }, true);
                });
            };

            unlockZhihu();

            const observer = new MutationObserver(() => {
                if (State.settings.mainEnabled) {
                    unlockZhihu();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            State.registerObserver(observer);
            Logger.info('Zhihu handler initialized');
        }, 'SiteHandlers.zhihu')
    };

    // ==================== 初始化 ====================
    const App = {
        async init() {
            try {
                Logger.info('Initializing...');

                // 加载设置
                const settings = await Storage.getSettings();
                State.updateSettings(settings);

                // 初始化消息通信
                Messaging.init();

                // 如果插件已启用，启动功能
                if (State.settings.mainEnabled) {
                    this.enableFeatures();
                } else {
                    // 插件未开启时，检测是否有复制限制
                    this.detectRestrictions();
                }

                State.initialized = true;
                Logger.info('Initialization complete, plugin enabled:', State.settings.mainEnabled);

            } catch (error) {
                Logger.error('Initialization failed:', error);
            }
        },

        // 检测复制限制
        detectRestrictions() {
            // 延迟检测，等待页面加载完成
            setTimeout(() => {
                const result = CopyRestrictionDetector.detect();
                if (result.hasRestriction) {
                    Logger.info('Copy restrictions detected:', result.restrictions);
                    CopyRestrictionDetector.notifyRestrictionDetected(result);
                }
            }, 2000);
        },

        // 启用所有功能
        enableFeatures() {
            Logger.info('Enabling features...');

            // 根据页面类型执行不同处理
            if (PageDetector.is('feishu')) {
                SiteHandlers.feishu();
            } else if (PageDetector.is('pintia')) {
                SiteHandlers.pintia();
            } else if (PageDetector.is('chaoxing')) {
                SiteHandlers.chaoxing();
            } else if (PageDetector.is('csdn')) {
                SiteHandlers.csdn();
            } else if (PageDetector.is('docin')) {
                SiteHandlers.docin();
            } else if (PageDetector.is('educoder')) {
                SiteHandlers.educoder();
            } else if (PageDetector.is('baiduwenku')) {
                SiteHandlers.baiduwenku();
            } else if (PageDetector.is('weixin')) {
                SiteHandlers.weixin();
            } else if (PageDetector.is('cnki')) {
                SiteHandlers.cnki();
            } else if (PageDetector.is('zhihu')) {
                SiteHandlers.zhihu();
            } else {
                // 通用解锁
                UnlockFeatures.removeSpecificEventListeners();
                UnlockFeatures.interceptXHR();
                UnlockFeatures.interceptFetch();
            }

            // 观察DOM变化（优化策略）
            SmartDOMObserver.init();

            // 处理 Shadow DOM
            ShadowDOMHandler.init();

            // 处理 iframe
            IframeHandler.init();

            // 设置键盘快捷键
            this.setupKeyboardShortcuts();

            // 设置双击事件
            this.setupDoubleClick();

            // 通用处理
            this.setupUniversalHandlers();

            // 立即执行一次解锁
            UnlockFeatures.removeVipMask();
            UnlockFeatures.unlockCssRestrictions();

            Logger.info('Features enabled');
        },

        // 禁用所有功能
        disableFeatures() {
            Logger.info('Disabling features...');
            
            // 清理所有观察者和事件监听
            State.disconnectAllObservers();
            State.cleanupEventListeners();
            State.runFeatureCleanup();

            // 关闭浮动输入框
            FloatingInput.destroy();

            // 恢复页面交互 - 确保没有残留的遮罩阻挡点击
            this.restorePageInteraction();

            Logger.info('Features disabled');
        },

        // 恢复页面交互
        restorePageInteraction: ErrorHandler.wrap(() => {
            // 强制恢复body和html的pointer-events
            document.body.style.pointerEvents = 'auto';
            document.body.style.overflow = 'auto';
            document.documentElement.style.pointerEvents = 'auto';
            document.documentElement.style.overflow = 'auto';

            // 移除CSDN等网站的登录容器
            const loginContainers = [
                '.passport-login-container',
                '.passport-login-mark',
                '.login-container',
                '[class*="passport-login"]'
            ];

            loginContainers.forEach(selector => {
                try {
                    document.querySelectorAll(selector).forEach(el => {
                        el.remove();
                        Logger.log('Removed login container:', selector);
                    });
                } catch (e) {
                    // 忽略错误
                }
            });

            // 查找并禁用可能残留的遮罩层的pointer-events
            const possibleMaskSelectors = [
                '.passport-login-mark',
                '.login-mark',
                '.login-mask',
                '[class*="login-mark"]',
                '[class*="login-mask"]',
                '[class*="passport-mask"]',
                '[class*="overlay"]'
            ];

            possibleMaskSelectors.forEach(selector => {
                try {
                    document.querySelectorAll(selector).forEach(el => {
                        el.style.pointerEvents = 'none';
                        el.style.display = 'none';
                    });
                } catch (e) {
                    // 忽略错误
                }
            });
        }, 'restorePageInteraction'),

        setupUniversalHandlers() {
            UnlockFeatures.customCopyHandler();
        },

        setupKeyboardShortcuts() {
            const handler = (e) => {
                if (State.settings.mainEnabled && 
                    State.settings.inputEnabled && 
                    e.ctrlKey && 
                    e.shiftKey &&
                    e.key.toLowerCase() === 'm') {
                    e.preventDefault();
                    e.stopPropagation();
                    State.targetElement = document.activeElement;
                    FloatingInput.create();
                }
            };
            State.registerEventListener(document, 'keydown', handler, true);
        },

        setupDoubleClick() {
            const handler = (e) => {
                const target = e.target;
                const isInput = target.tagName === 'INPUT' || 
                               target.tagName === 'TEXTAREA' || 
                               target.isContentEditable;
                
                if (isInput && State.settings.mainEnabled && State.settings.inputEnabled) {
                    State.targetElement = target;
                    FloatingInput.create();
                }
            };
            State.registerEventListener(document, 'dblclick', handler, true);
        }
    };

    // ==================== 启动应用 ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => App.init());
    } else {
        App.init();
    }

    // 页面卸载时清理
    window.addEventListener('beforeunload', () => {
        State.cleanup();
    });

})();
