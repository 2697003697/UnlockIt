// background.js - 后台服务工作脚本 (健壮版本)

(function() {
    'use strict';

    // ==================== 配置 ====================
    const CONFIG = {
        VERSION: '8.2.0',
        STORAGE_KEY: 'unlockSettings',
        DEBUG: false
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
            if (CONFIG.DEBUG) console.log(this.prefix, ...args);
        },
        error(...args) {
            console.error(this.prefix, ...args);
        },
        warn(...args) {
            console.warn(this.prefix, ...args);
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
        }
    };

    // ==================== 工具函数 ====================
    const Utils = {
        // 验证设置对象
        validateSettings(settings) {
            if (!settings || typeof settings !== 'object') {
                return { ...DEFAULT_SETTINGS };
            }
            
            const validated = { ...DEFAULT_SETTINGS };
            
            ['mainEnabled', 'copyEnabled', 'pasteEnabled', 'inputEnabled'].forEach(key => {
                if (typeof settings[key] === 'boolean') {
                    validated[key] = settings[key];
                }
            });
            
            return validated;
        }
    };

    // ==================== 存储管理 ====================
    const Storage = {
        async getSettings() {
            try {
                const result = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
                return Utils.validateSettings(result[CONFIG.STORAGE_KEY]);
            } catch (error) {
                Logger.error('Failed to get settings:', error);
                return { ...DEFAULT_SETTINGS };
            }
        },

        async saveSettings(settings) {
            try {
                const validated = Utils.validateSettings(settings);
                await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: validated });
                await IconManager.update(validated.mainEnabled);
                return validated;
            } catch (error) {
                Logger.error('Failed to save settings:', error);
                return null;
            }
        },

        async resetSettings() {
            try {
                const settings = { ...DEFAULT_SETTINGS };
                await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: settings });
                await IconManager.update(false);
                return settings;
            } catch (error) {
                Logger.error('Failed to reset settings:', error);
                return null;
            }
        }
    };

    // ==================== 图标状态管理 ====================
    const IconManager = {
        // 更新图标徽章
        async update(enabled) {
            try {
                const text = enabled ? 'ON' : '';
                const color = enabled ? '#4ade80' : '#9ca3af';

                await chrome.action.setBadgeText({ text });
                await chrome.action.setBadgeBackgroundColor({ color });

                Logger.log('Icon badge updated:', enabled ? 'ON' : 'OFF');
            } catch (error) {
                Logger.error('Failed to update icon badge:', error);
            }
        },

        // 初始化图标状态
        async init() {
            try {
                const settings = await Storage.getSettings();
                await this.update(settings.mainEnabled);
            } catch (error) {
                Logger.error('Failed to init icon badge:', error);
            }
        }
    };

    // ==================== 消息处理 ====================
    const MessageHandler = {
        init() {
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                ErrorHandler.wrap(() => {
                    this.handle(message, sender, sendResponse);
                }, 'message handler')();
                return true; // 保持消息通道开放
            });
        },

        handle(message, sender, sendResponse) {
            switch (message.type) {
                case 'getSettings':
                    this.handleGetSettings(sendResponse);
                    break;

                case 'setSettings':
                    this.handleSetSettings(message.settings, sendResponse);
                    break;

                case 'resetSettings':
                    this.handleResetSettings(sendResponse);
                    break;

                case 'restrictionDetected':
                    this.handleRestrictionDetected(message, sendResponse);
                    break;

                case 'ping':
                    sendResponse({
                        pong: true,
                        version: CONFIG.VERSION,
                        timestamp: Date.now()
                    });
                    break;

                default:
                    sendResponse({
                        success: false,
                        error: 'Unknown message type: ' + message.type
                    });
            }
        },

        async handleGetSettings(sendResponse) {
            try {
                const settings = await Storage.getSettings();
                sendResponse({ success: true, settings });
            } catch (error) {
                Logger.error('Failed to get settings:', error);
                sendResponse({ 
                    success: false, 
                    error: error.message,
                    settings: { ...DEFAULT_SETTINGS }
                });
            }
        },

        async handleSetSettings(settings, sendResponse) {
            try {
                const savedSettings = await Storage.saveSettings(settings);
                if (savedSettings) {
                    sendResponse({ success: true, settings: savedSettings });
                } else {
                    sendResponse({ success: false, error: 'Failed to save settings' });
                }
            } catch (error) {
                Logger.error('Failed to set settings:', error);
                sendResponse({ success: false, error: error.message });
            }
        },

        async handleResetSettings(sendResponse) {
            try {
                const settings = await Storage.resetSettings();
                if (settings) {
                    sendResponse({ success: true, settings });
                } else {
                    sendResponse({ success: false, error: 'Failed to reset settings' });
                }
            } catch (error) {
                Logger.error('Failed to reset settings:', error);
                sendResponse({ success: false, error: error.message });
            }
        },

        // 处理复制限制检测
        async handleRestrictionDetected(data, sendResponse) {
            try {
                Logger.log('Restriction detected:', data);

                // 获取当前设置
                const settings = await Storage.getSettings();

                // 如果插件已开启，不需要提示
                if (settings.mainEnabled) {
                    sendResponse({ success: true, notified: false });
                    return;
                }

                // 检查是否已经提示过这个网站
                const notifiedSites = await this.getNotifiedSites();
                if (notifiedSites.includes(data.hostname)) {
                    sendResponse({ success: true, notified: false });
                    return;
                }

                // 记录已提示的网站
                notifiedSites.push(data.hostname);
                await this.saveNotifiedSites(notifiedSites);

                // 显示通知
                await this.showRestrictionNotification(data);

                sendResponse({ success: true, notified: true });
            } catch (error) {
                Logger.error('Failed to handle restriction detection:', error);
                sendResponse({ success: false, error: error.message });
            }
        },

        // 获取已提示的网站列表
        async getNotifiedSites() {
            try {
                const result = await chrome.storage.local.get('notifiedSites');
                return result.notifiedSites || [];
            } catch (error) {
                return [];
            }
        },

        // 保存已提示的网站列表
        async saveNotifiedSites(sites) {
            try {
                // 只保留最近20个
                const limited = sites.slice(-20);
                await chrome.storage.local.set({ notifiedSites: limited });
            } catch (error) {
                Logger.error('Failed to save notified sites:', error);
            }
        },

        // 显示限制检测通知
        async showRestrictionNotification(data) {
            try {
                // 更新图标提示
                await chrome.action.setBadgeText({ text: '!' });
                await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });

                // 3秒后恢复
                setTimeout(async () => {
                    const settings = await Storage.getSettings();
                    await IconManager.update(settings.mainEnabled);
                }, 3000);

                Logger.info('Restriction notification shown for:', data.hostname);
            } catch (error) {
                Logger.error('Failed to show notification:', error);
            }
        }
    };

    // ==================== 右键菜单管理 ====================
    const ContextMenuHandler = {
        init() {
            chrome.contextMenus.removeAll(() => {
                chrome.contextMenus.create({
                    id: 'unlock-copy',
                    title: '🔓 强制复制选中内容',
                    contexts: ['selection']
                });

                chrome.contextMenus.create({
                    id: 'unlock-copy-dingtalk',
                    title: '🔓 强制复制当前选区',
                    contexts: ['all'],
                    documentUrlPatterns: [
                        '*://*.dingtalk.com/*',
                        '*://*.alidocs.com/*'
                    ]
                });

                chrome.contextMenus.create({
                    id: 'unlock-paste',
                    title: '🔓 强制粘贴',
                    contexts: ['editable']
                });

                chrome.contextMenus.create({
                    id: 'separator',
                    type: 'separator',
                    contexts: ['selection', 'editable']
                });

                chrome.contextMenus.create({
                    id: 'toggle-plugin',
                    title: '🔌 切换插件开关',
                    contexts: ['all']
                });
            });

            chrome.contextMenus.onClicked.addListener(
                ErrorHandler.wrap(this.handleClick.bind(this), 'context menu click')
            );
        },

        async handleClick(info, tab) {
            switch (info.menuItemId) {
                case 'unlock-copy':
                    await this.handleCopy(info, tab);
                    break;
                case 'unlock-copy-dingtalk':
                    await this.handleDingTalkCopy(info, tab);
                    break;
                case 'unlock-paste':
                    await this.handlePaste(info, tab);
                    break;
                case 'toggle-plugin':
                    await this.handleToggle(tab);
                    break;
            }
        },

        async handleCopy(info, tab) {
            try {
                const settings = await Storage.getSettings();
                if (!settings.mainEnabled || !settings.copyEnabled) {
                    this.showNotification(tab.id, '复制解锁功能未启用', 'warning', info.frameId);
                    return;
                }

                const text = info.selectionText;
                if (text) {
                    await chrome.scripting.executeScript({
                        target: {
                            tabId: tab.id,
                            frameIds: [info.frameId ?? 0]
                        },
                        func: async (textToCopy) => navigator.clipboard.writeText(textToCopy),
                        args: [text]
                    });
                    this.showNotification(tab.id, '复制成功', 'success', info.frameId);
                }
            } catch (error) {
                Logger.error('Failed to handle copy:', error);
                this.showNotification(tab.id, '复制失败', 'error', info.frameId);
            }
        },

        async handleDingTalkCopy(info, tab) {
            try {
                const settings = await Storage.getSettings();
                if (!settings.mainEnabled || !settings.copyEnabled) {
                    this.showNotification(tab.id, '复制解锁功能未启用', 'warning', info.frameId);
                    return;
                }

                const response = await chrome.tabs.sendMessage(tab.id, {
                    type: 'getDingTalkSelection'
                }, {
                    frameId: info.frameId ?? 0
                });

                if (!response?.text) {
                    this.showNotification(tab.id, '未检测到选中文本', 'warning', info.frameId);
                    return;
                }

                await chrome.scripting.executeScript({
                    target: {
                        tabId: tab.id,
                        frameIds: [info.frameId ?? 0]
                    },
                    func: async text => navigator.clipboard.writeText(text),
                    args: [response.text]
                });
                this.showNotification(tab.id, '复制成功', 'success', info.frameId);
            } catch (error) {
                Logger.error('Failed to handle DingTalk copy:', error);
                this.showNotification(tab.id, '复制失败', 'error', info.frameId);
            }
        },

        async handlePaste(info, tab) {
            try {
                const settings = await Storage.getSettings();
                if (!settings.mainEnabled || !settings.pasteEnabled) {
                    this.showNotification(tab.id, '粘贴解锁功能未启用', 'warning', info.frameId);
                    return;
                }

                await chrome.tabs.sendMessage(tab.id, {
                    type: 'forcePaste'
                }, {
                    frameId: info.frameId ?? 0
                });
            } catch (error) {
                Logger.error('Failed to handle paste:', error);
                this.showNotification(tab.id, '粘贴失败', 'error', info.frameId);
            }
        },

        async handleToggle(tab) {
            try {
                const settings = await Storage.getSettings();
                settings.mainEnabled = !settings.mainEnabled;
                const savedSettings = await Storage.saveSettings(settings);
                if (!savedSettings) throw new Error('Failed to save settings');
                
                const message = savedSettings.mainEnabled ? '插件已启用' : '插件已禁用';
                this.showNotification(tab.id, message, savedSettings.mainEnabled ? 'success' : 'info', 0);
            } catch (error) {
                Logger.error('Failed to toggle plugin:', error);
            }
        },

        showNotification(tabId, message, type, frameId = 0) {
            chrome.tabs.sendMessage(tabId, {
                type: 'showToast',
                message: message,
                toastType: type
            }, { frameId }).catch(() => {});
        }
    };

    // ==================== 快捷键管理 ====================
    const CommandHandler = {
        init() {
            chrome.commands.onCommand.addListener(
                ErrorHandler.wrap(this.handle.bind(this), 'command handler')
            );
        },

        async handle(command) {
            Logger.log('Command received:', command);

            switch (command) {
                case 'toggle-plugin':
                    await this.togglePlugin();
                    break;
                case 'open-input':
                    await this.openInput();
                    break;
                default:
                    Logger.warn('Unknown command:', command);
            }
        },

        async togglePlugin() {
            try {
                const settings = await Storage.getSettings();
                settings.mainEnabled = !settings.mainEnabled;
                const savedSettings = await Storage.saveSettings(settings);
                if (!savedSettings) throw new Error('Failed to save settings');

                Logger.info('Plugin toggled via shortcut:', savedSettings.mainEnabled);
            } catch (error) {
                Logger.error('Failed to toggle plugin:', error);
            }
        },

        async openInput() {
            try {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (activeTab?.id) {
                    await chrome.tabs.sendMessage(activeTab.id, {
                        type: 'openFloatingInput'
                    });
                    Logger.info('Open input command sent to tab:', activeTab.id);
                }
            } catch (error) {
                Logger.error('Failed to open input:', error);
            }
        }
    };

    // ==================== 生命周期管理 ====================
    const Lifecycle = {
        // 插件安装/更新时初始化
        async onInstalled(details) {
            Logger.info('Extension', details.reason, '- version:', CONFIG.VERSION);

            try {
                if (details.reason === 'install') {
                    // 首次安装，初始化设置
                    await Storage.saveSettings(DEFAULT_SETTINGS);
                    Logger.info('Settings initialized for first install');
                    
                } else if (details.reason === 'update') {
                    // 更新时合并设置
                    const currentSettings = await Storage.getSettings();
                    const mergedSettings = {
                        ...DEFAULT_SETTINGS,
                        ...currentSettings,
                        version: CONFIG.VERSION
                    };
                    await Storage.saveSettings(mergedSettings);
                    Logger.info('Settings merged after update');
                }
            } catch (error) {
                Logger.error('Failed to handle install/update:', error);
            }
        },

        // 标签页更新时
        onTabUpdated(tabId, changeInfo, tab) {
            if (changeInfo.status === 'complete' && tab.url) {
                Logger.log('Tab updated:', tabId, tab.url);
            }
        },

        // 标签页激活时
        onTabActivated(activeInfo) {
            Logger.log('Tab activated:', activeInfo.tabId);
        }
    };

    // ==================== 初始化 ====================
    const App = {
        async init() {
            try {
                Logger.info('Background script initializing...');

                // 监听安装/更新事件
                chrome.runtime.onInstalled.addListener(
                    ErrorHandler.wrap(Lifecycle.onInstalled.bind(Lifecycle), 'onInstalled')
                );

                // 监听标签页事件
                chrome.tabs.onUpdated.addListener(
                    ErrorHandler.wrap(Lifecycle.onTabUpdated.bind(Lifecycle), 'onTabUpdated')
                );

                chrome.tabs.onActivated.addListener(
                    ErrorHandler.wrap(Lifecycle.onTabActivated.bind(Lifecycle), 'onTabActivated')
                );

                // 初始化消息处理
                MessageHandler.init();

                // 初始化快捷键处理
                CommandHandler.init();

                // 初始化右键菜单
                ContextMenuHandler.init();

                // 初始化图标状态
                await IconManager.init();

                // 所有设置入口最终都会写 storage，徽章只监听这一处变化。
                chrome.storage.onChanged.addListener((changes, areaName) => {
                    if (areaName !== 'local' || !changes[CONFIG.STORAGE_KEY]) return;
                    const settings = Utils.validateSettings(changes[CONFIG.STORAGE_KEY].newValue);
                    IconManager.update(settings.mainEnabled);
                });

                Logger.info('Background script initialized');
            } catch (error) {
                Logger.error('Failed to initialize background script:', error);
            }
        }
    };

    // 启动
    App.init();
})();
