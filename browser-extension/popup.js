// popup.js - 插件弹窗控制脚本 (健壮版本)

(function() {
    'use strict';

    // ==================== 配置 ====================
    const CONFIG = {
        VERSION: '8.0.0',
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
        prefix: '[UnlockPopup]',
        log(...args) {
            if (CONFIG.DEBUG) console.log(this.prefix, ...args);
        },
        error(...args) {
            console.error(this.prefix, ...args);
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
        },

        // 防抖函数
        debounce(fn, delay) {
            let timeoutId;
            return function(...args) {
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => fn.apply(this, args), delay);
            };
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
                return true;
            } catch (error) {
                Logger.error('Failed to save settings:', error);
                return false;
            }
        }
    };

    // ==================== UI管理 ====================
    const UI = {
        elements: {},

        // 缓存DOM元素
        cacheElements() {
            this.elements = {
                mainSwitch: document.getElementById('mainSwitch'),
                copySwitch: document.getElementById('copySwitch'),
                pasteSwitch: document.getElementById('pasteSwitch'),
                inputSwitch: document.getElementById('inputSwitch'),
                statusDot: document.getElementById('statusDot'),
                statusText: document.getElementById('statusText')
            };

            // 验证元素存在
            Object.entries(this.elements).forEach(([name, el]) => {
                if (!el) {
                    Logger.error(`Element not found: ${name}`);
                }
            });
        },

        // 更新UI状态
        update(settings) {
            const { mainEnabled, copyEnabled, pasteEnabled, inputEnabled } = settings;
            const { mainSwitch, copySwitch, pasteSwitch, inputSwitch, statusDot, statusText } = this.elements;

            // 更新开关状态
            if (mainSwitch) mainSwitch.classList.toggle('active', mainEnabled);
            if (copySwitch) copySwitch.classList.toggle('active', copyEnabled);
            if (pasteSwitch) pasteSwitch.classList.toggle('active', pasteEnabled);
            if (inputSwitch) inputSwitch.classList.toggle('active', inputEnabled);

            // 子开关是否可点击
            const subSwitches = [copySwitch, pasteSwitch, inputSwitch].filter(Boolean);
            subSwitches.forEach(sw => {
                sw.style.opacity = mainEnabled ? '1' : '0.5';
                sw.style.pointerEvents = mainEnabled ? 'auto' : 'none';
            });

            // 更新状态指示器
            if (statusDot) statusDot.classList.toggle('active', mainEnabled);
            if (statusText) {
                statusText.textContent = mainEnabled ? '插件运行中' : '插件已暂停';
            }
        }
    };

    // ==================== 消息通信 ====================
    const Messaging = {
        // 通知所有标签页设置更新
        async notifyAllTabs(settings) {
            try {
                const tabs = await chrome.tabs.query({});
                const promises = tabs.map(tab => 
                    chrome.tabs.sendMessage(tab.id, {
                        type: 'settingsUpdated',
                        settings: settings
                    }).catch(err => {
                        Logger.log(`Failed to notify tab ${tab.id}:`, err.message);
                        return null;
                    })
                );
                await Promise.all(promises);
            } catch (error) {
                Logger.error('Failed to notify tabs:', error);
            }
        },

        // 获取当前标签页设置
        async getCurrentTabSettings() {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) return null;

                const response = await chrome.tabs.sendMessage(tab.id, {
                    type: 'getSettings'
                }).catch(() => null);

                return response?.settings || null;
            } catch (error) {
                Logger.log('Failed to get current tab settings:', error);
                return null;
            }
        }
    };

    // ==================== 状态管理 ====================
    const State = {
        settings: { ...DEFAULT_SETTINGS },
        isUpdating: false,

        // 切换设置
        toggle(key) {
            if (this.isUpdating) return this.settings;

            const newSettings = { ...this.settings };
            
            switch(key) {
                case 'main':
                    newSettings.mainEnabled = !newSettings.mainEnabled;
                    break;
                case 'copy':
                    if (newSettings.mainEnabled) {
                        newSettings.copyEnabled = !newSettings.copyEnabled;
                    }
                    break;
                case 'paste':
                    if (newSettings.mainEnabled) {
                        newSettings.pasteEnabled = !newSettings.pasteEnabled;
                    }
                    break;
                case 'input':
                    if (newSettings.mainEnabled) {
                        newSettings.inputEnabled = !newSettings.inputEnabled;
                    }
                    break;
            }

            this.settings = newSettings;
            return newSettings;
        },

        // 更新设置
        update(newSettings) {
            this.settings = Utils.validateSettings(newSettings);
        }
    };

    // ==================== 事件处理 ====================
    const EventHandlers = {
        // 保存设置并通知标签页
        async saveAndNotify() {
            if (State.isUpdating) return;
            State.isUpdating = true;

            try {
                const success = await Storage.saveSettings(State.settings);
                if (success) {
                    await Messaging.notifyAllTabs(State.settings);
                    UI.update(State.settings);
                }
            } catch (error) {
                Logger.error('Failed to save and notify:', error);
            } finally {
                State.isUpdating = false;
            }
        },

        // 防抖版本的保存
        debouncedSave: null,

        // 初始化事件监听
        init() {
            this.debouncedSave = Utils.debounce(this.saveAndNotify.bind(this), 100);

            const { mainSwitch, copySwitch, pasteSwitch, inputSwitch } = UI.elements;

            // 开关事件
            if (mainSwitch) {
                mainSwitch.addEventListener('click', ErrorHandler.wrap(() => {
                    State.toggle('main');
                    this.debouncedSave();
                }, 'mainSwitch click'));
            }

            if (copySwitch) {
                copySwitch.addEventListener('click', ErrorHandler.wrap(() => {
                    State.toggle('copy');
                    this.debouncedSave();
                }, 'copySwitch click'));
            }

            if (pasteSwitch) {
                pasteSwitch.addEventListener('click', ErrorHandler.wrap(() => {
                    State.toggle('paste');
                    this.debouncedSave();
                }, 'pasteSwitch click'));
            }

            if (inputSwitch) {
                inputSwitch.addEventListener('click', ErrorHandler.wrap(() => {
                    State.toggle('input');
                    this.debouncedSave();
                }, 'inputSwitch click'));
            }
        }
    };

    // ==================== 初始化 ====================
    const App = {
        async init() {
            try {
                Logger.log('Initializing popup...');

                // 缓存DOM元素
                UI.cacheElements();

                // 加载设置
                const settings = await Storage.getSettings();
                State.update(settings);

                // 更新UI
                UI.update(State.settings);

                // 初始化事件
                EventHandlers.init();

                Logger.log('Popup initialized');
            } catch (error) {
                Logger.error('Initialization failed:', error);
            }
        }
    };

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => App.init());
    } else {
        App.init();
    }
})();
