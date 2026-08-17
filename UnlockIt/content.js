/*
 * UnlockIt content script
 * 页面修改只在功能启用期间生效，关闭或切换设置时会恢复原始 DOM 状态。
 */

(function() {
    'use strict';

    const CONFIG = {
        VERSION: '8.2.0',
        STORAGE_KEY: 'unlockSettings',
        DEBUG: false,
        MUTATION_DELAY: 50
    };

    const DEFAULT_SETTINGS = Object.freeze({
        mainEnabled: false,
        copyEnabled: true,
        pasteEnabled: true,
        inputEnabled: true,
        version: CONFIG.VERSION
    });

    const Logger = {
        prefix: '[UnlockIt]',
        log(...args) {
            if (CONFIG.DEBUG) console.log(this.prefix, ...args);
        },
        info(...args) {
            if (CONFIG.DEBUG) console.info(this.prefix, ...args);
        },
        warn(...args) {
            console.warn(this.prefix, ...args);
        },
        error(...args) {
            console.error(this.prefix, ...args);
        }
    };

    const Utils = {
        validateSettings(settings) {
            const validated = { ...DEFAULT_SETTINGS };
            if (!settings || typeof settings !== 'object') return validated;

            ['mainEnabled', 'copyEnabled', 'pasteEnabled', 'inputEnabled'].forEach(key => {
                if (typeof settings[key] === 'boolean') validated[key] = settings[key];
            });
            return validated;
        },

        throttle(fn, delay) {
            let timeoutId = null;
            let pending = false;

            return function(...args) {
                if (timeoutId) {
                    pending = true;
                    return;
                }

                fn.apply(this, args);
                timeoutId = setTimeout(() => {
                    timeoutId = null;
                    if (pending) {
                        pending = false;
                        fn.apply(this, args);
                    }
                }, delay);
            };
        },

        isCangjieSelectionLayer(element) {
            return Boolean(element?.matches?.('[data-cangjie-selection-layer]'));
        },

        isEditable(element) {
            return Boolean(element && (
                element.tagName === 'INPUT' ||
                element.tagName === 'TEXTAREA' ||
                element.isContentEditable
            ));
        },

        queryAll(root, selectors) {
            if (!root?.querySelectorAll) return [];
            try {
                const elements = Array.from(root.querySelectorAll(selectors));
                if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(selectors)) {
                    elements.unshift(root);
                }
                return elements;
            } catch {
                return [];
            }
        }
    };

    const Toast = {
        show(message, type = 'success', duration = 2000) {
            if (!document.body) return;

            const colors = {
                success: { background: '#10b981', icon: '✓' },
                error: { background: '#ef4444', icon: '✕' },
                info: { background: '#3b82f6', icon: 'ℹ' },
                warning: { background: '#f59e0b', icon: '⚠' }
            };
            const appearance = colors[type] || colors.success;
            const toast = document.createElement('div');
            toast.className = 'unlock-toast';
            toast.textContent = `${appearance.icon} ${message}`;
            Object.assign(toast.style, {
                position: 'fixed',
                top: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                padding: '12px 20px',
                backgroundColor: appearance.background,
                color: '#fff',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: '500',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                zIndex: '2147483647',
                opacity: '0',
                transition: 'opacity 0.2s'
            });
            document.body.appendChild(toast);
            requestAnimationFrame(() => {
                toast.style.opacity = '1';
            });
            setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => toast.remove(), 250);
            }, duration);
        }
    };

    const State = {
        settings: { ...DEFAULT_SETTINGS },
        initialized: false,
        featuresEnabled: false,
        targetElement: null,
        dingTalkSelectionText: '',
        dingTalkSelectionTimestamp: 0,
        observers: new Set(),
        eventListeners: new Set(),
        cleanupFns: [],
        domChanges: new Map(),

        registerObserver(observer) {
            this.observers.add(observer);
            return observer;
        },

        registerEventListener(element, type, listener, options) {
            element.addEventListener(type, listener, options);
            this.eventListeners.add({ element, type, listener, options });
            return listener;
        },

        addCleanup(fn) {
            this.cleanupFns.push(fn);
        },

        getDomRecord(element) {
            let record = this.domChanges.get(element);
            if (!record) {
                record = { styles: new Map(), attributes: new Map() };
                this.domChanges.set(element, record);
            }
            return record;
        },

        setStyle(element, property, value, priority = '') {
            if (!element?.style) return;
            if (element.style.getPropertyValue(property) === value &&
                element.style.getPropertyPriority(property) === priority) {
                return;
            }

            const record = this.getDomRecord(element);
            if (!record.styles.has(property)) {
                record.styles.set(property, {
                    value: element.style.getPropertyValue(property),
                    priority: element.style.getPropertyPriority(property)
                });
            }
            element.style.setProperty(property, value, priority);
        },

        setStyles(element, styles, priority = '') {
            Object.entries(styles).forEach(([property, value]) => {
                this.setStyle(element, property, value, priority);
            });
        },

        setAttribute(element, name, value) {
            if (!element?.setAttribute || element.getAttribute(name) === value) return;
            const record = this.getDomRecord(element);
            if (!record.attributes.has(name)) {
                record.attributes.set(name, {
                    existed: element.hasAttribute(name),
                    value: element.getAttribute(name)
                });
            }
            element.setAttribute(name, value);
        },

        removeAttribute(element, name) {
            if (!element?.hasAttribute?.(name)) return;
            const record = this.getDomRecord(element);
            if (!record.attributes.has(name)) {
                record.attributes.set(name, {
                    existed: true,
                    value: element.getAttribute(name)
                });
            }
            element.removeAttribute(name);
        },

        hide(element) {
            this.setStyle(element, 'display', 'none', 'important');
        },

        cleanup() {
            this.observers.forEach(observer => {
                try {
                    observer.disconnect();
                } catch (error) {
                    Logger.warn('Observer cleanup failed:', error);
                }
            });
            this.observers.clear();

            this.eventListeners.forEach(({ element, type, listener, options }) => {
                try {
                    element.removeEventListener(type, listener, options);
                } catch (error) {
                    Logger.warn('Event cleanup failed:', error);
                }
            });
            this.eventListeners.clear();

            this.cleanupFns.splice(0).forEach(fn => {
                try {
                    fn();
                } catch (error) {
                    Logger.warn('Feature cleanup failed:', error);
                }
            });

            Array.from(this.domChanges.entries()).reverse().forEach(([element, record]) => {
                try {
                    record.styles.forEach((original, property) => {
                        if (original.value) {
                            element.style.setProperty(property, original.value, original.priority);
                        } else {
                            element.style.removeProperty(property);
                        }
                    });
                    record.attributes.forEach((original, name) => {
                        if (original.existed) {
                            element.setAttribute(name, original.value ?? '');
                        } else {
                            element.removeAttribute(name);
                        }
                    });
                } catch (error) {
                    Logger.warn('DOM restoration failed:', error);
                }
            });
            this.domChanges.clear();

            FloatingInput.destroy();
            this.targetElement = null;
            this.dingTalkSelectionText = '';
            this.dingTalkSelectionTimestamp = 0;
            this.featuresEnabled = false;
        }
    };

    const Storage = {
        async getSettings() {
            try {
                const result = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
                return Utils.validateSettings(result[CONFIG.STORAGE_KEY]);
            } catch (error) {
                Logger.error('Failed to load settings:', error);
                return { ...DEFAULT_SETTINGS };
            }
        }
    };

    const MainWorldBridge = {
        syncSettings(settings = State.settings) {
            document.dispatchEvent(new CustomEvent('unlockit:settings', {
                detail: JSON.stringify(Utils.validateSettings(settings))
            }));
        }
    };

    const PageDetector = {
        types: {
            dingtalk: /dingtalk\.com|alidocs\.com/i,
            feishu: /feishu\.cn|larkoffice\.com/i,
            chaoxing: /chaoxing\.com/i,
            pintia: /pintia\.cn/i,
            csdn: /csdn\.net/i,
            zhihu: /zhihu\.com/i,
            baiduwenku: /wenku\.baidu\.com/i,
            docin: /docin\.com|doc88\.com/i,
            educoder: /educoder\.net/i,
            weixin: /mp\.weixin\.qq\.com/i,
            cnki: /cnki\.net|cnki\.com\.cn/i
        },

        is(type) {
            return this.types[type]?.test(window.location.hostname) ?? false;
        },

        current() {
            return Object.keys(this.types).find(type => this.is(type)) || 'generic';
        }
    };

    const ClipboardActions = {
        getEditableTarget() {
            return Utils.isEditable(document.activeElement) ? document.activeElement : null;
        },

        insertText(element, text) {
            if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                const start = element.selectionStart ?? element.value.length;
                const end = element.selectionEnd ?? start;
                element.setRangeText(text, start, end, 'end');
                element.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    data: text,
                    inputType: 'insertFromPaste'
                }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }

            if (element.isContentEditable) {
                element.focus();
                return document.execCommand('insertText', false, text);
            }
            return false;
        },

        async forcePaste() {
            if (!State.settings.mainEnabled || !State.settings.pasteEnabled) {
                return { success: false, error: 'Paste feature disabled' };
            }

            const target = this.getEditableTarget();
            if (!target) {
                Toast.show('请先选中输入框', 'warning');
                return { success: false, error: 'No editable target' };
            }

            try {
                const text = await navigator.clipboard.readText();
                const success = this.insertText(target, text);
                Toast.show(success ? '粘贴成功' : '粘贴失败', success ? 'success' : 'error');
                return { success };
            } catch (error) {
                Logger.error('Force paste failed:', error);
                Toast.show('粘贴失败', 'error');
                return { success: false, error: error.message };
            }
        },

        getDingTalkSelection() {
            if (!PageDetector.is('dingtalk') ||
                !State.settings.mainEnabled ||
                !State.settings.copyEnabled ||
                !State.dingTalkSelectionText ||
                Date.now() - State.dingTalkSelectionTimestamp > 60000) {
                return { success: false, text: '' };
            }
            return { success: true, text: State.dingTalkSelectionText };
        }
    };

    const CopyRestrictionDetector = {
        timerId: null,

        start() {
            this.stop();
            this.timerId = setTimeout(() => this.detect(), 2000);
        },

        stop() {
            if (this.timerId) clearTimeout(this.timerId);
            this.timerId = null;
        },

        async detect() {
            this.timerId = null;
            if (window !== window.top || State.settings.mainEnabled || !document.body) return;

            const restrictions = [];
            const candidates = Utils.queryAll(document, 'article, .content, .article, [class*="content"]');
            if (candidates.some(element => {
                const style = window.getComputedStyle(element);
                return style.userSelect === 'none' || style.webkitUserSelect === 'none';
            })) {
                restrictions.push('CSS限制');
            }

            if (document.querySelector('[oncopy], [oncut], [onpaste], [oncontextmenu], [onselectstart]')) {
                restrictions.push('事件拦截');
            }

            const siteType = PageDetector.current();
            if (siteType !== 'generic') restrictions.push(`${siteType}特定限制`);

            if (document.querySelector('.passport-login-mark, .login-mask, [class*="vip-mask"], [class*="paywall"]')) {
                restrictions.push('登录遮罩');
            }

            if (restrictions.length === 0) return;
            try {
                await chrome.runtime.sendMessage({
                    type: 'restrictionDetected',
                    data: { hasRestriction: true, restrictions, siteType },
                    hostname: window.location.hostname,
                    url: window.location.href
                });
            } catch (error) {
                Logger.log('Restriction notification skipped:', error);
            }
        }
    };

    const DOMUnlocker = {
        genericMaskSelectors: [
            'div[class*="hide-article"]',
            'div[class*="vip-mask"]',
            'div[class*="paywall"]',
            '.article-mask',
            '.content-mask',
            '.passport-login-mark',
            '.login-mark',
            '.login-mask',
            '[class*="login-mark"]',
            '[class*="passport-mask"]'
        ],

        unlockElement(element) {
            if (!State.settings.copyEnabled || !element?.style) return;
            try {
                if (Utils.isCangjieSelectionLayer(element)) {
                    State.setStyles(element, {
                        'user-select': 'none',
                        '-webkit-user-select': 'none',
                        'pointer-events': 'none'
                    }, 'important');
                    return;
                }

                const style = window.getComputedStyle(element);
                if (style.userSelect === 'none' || style.webkitUserSelect === 'none') {
                    State.setStyles(element, {
                        'user-select': 'text',
                        '-webkit-user-select': 'text'
                    }, 'important');
                }
            } catch {
                // Ignore detached or inaccessible nodes.
            }
        },

        unlockTree(root = document) {
            if (!State.settings.mainEnabled || !State.settings.copyEnabled || !root) return;
            if (root.nodeType === Node.ELEMENT_NODE) this.unlockElement(root);
            Utils.queryAll(root, '*').forEach(element => this.unlockElement(element));
        },

        hideGenericMasks(root = document) {
            if (!State.settings.mainEnabled || !State.settings.copyEnabled) return;
            Utils.queryAll(root, this.genericMaskSelectors.join(',')).forEach(element => State.hide(element));
        }
    };

    const ShadowDOMHandler = {
        processedRoots: new WeakSet(),

        process(root = document) {
            if (!State.settings.copyEnabled) return;
            Utils.queryAll(root, '*').forEach(element => {
                if (!element.shadowRoot || this.processedRoots.has(element.shadowRoot)) return;
                this.processedRoots.add(element.shadowRoot);
                DOMUnlocker.unlockTree(element.shadowRoot);
                this.process(element.shadowRoot);

                const observer = new MutationObserver(mutations => {
                    mutations.forEach(mutation => {
                        mutation.addedNodes.forEach(node => DOMUnlocker.unlockTree(node));
                    });
                    this.process(element.shadowRoot);
                });
                observer.observe(element.shadowRoot, { childList: true, subtree: true });
                State.registerObserver(observer);
            });
        },

        init() {
            this.processedRoots = new WeakSet();
            this.process(document);
        }
    };

    const SiteHandlers = {
        siteType: 'generic',

        style(selectors, styles, priority = 'important', root = document) {
            Utils.queryAll(root, selectors).forEach(element => State.setStyles(element, styles, priority));
        },

        hide(selectors, predicate = null, root = document) {
            Utils.queryAll(root, selectors).forEach(element => {
                if (!predicate || predicate(element)) State.hide(element);
            });
        },

        apply(root = document) {
            if (!State.settings.mainEnabled) return;
            this.siteType = PageDetector.current();
            const handler = this[this.siteType];
            if (typeof handler === 'function') handler.call(this, root);
        },

        dingtalk(root) {
            if (!State.settings.copyEnabled) return;
            this.style(
                'article[data-cangjie-content="true"], article.body-editor-content, [data-cangjie-leaf], [data-block-uuid], #doc-title-name',
                { 'user-select': 'text', '-webkit-user-select': 'text' },
                'important',
                root
            );
            this.style(
                '[data-cangjie-selection-layer]',
                { 'pointer-events': 'none', 'user-select': 'none', '-webkit-user-select': 'none' },
                'important',
                root
            );
        },

        feishu(root) {
            if (!State.settings.copyEnabled) return;
            this.style(
                '[contenteditable="true"], [data-slate-editor="true"], .suite-editor, .docx-editor',
                { 'user-select': 'text', '-webkit-user-select': 'text' },
                'important',
                root
            );
        },

        pintia(root) {
            if (!State.settings.copyEnabled) return;
            this.style('html, body, pre, code', {
                'user-select': 'text',
                '-webkit-user-select': 'text'
            }, 'important', root);
        },

        chaoxing(root) {
            if (!State.settings.copyEnabled) return;
            this.style('html, body, .Cy_TItle, .colorShallow, p', {
                'user-select': 'text',
                '-webkit-user-select': 'text'
            }, 'important', root);
            Utils.queryAll(root, '[onselectstart]').forEach(element => State.removeAttribute(element, 'onselectstart'));
        },

        csdn(root) {
            if (!State.settings.copyEnabled) return;
            this.hide(
                '.login-mark, .login-box, #passportbox, .hide-article-box, .article-mask, .passport-login-mark, .passport-login-container',
                null,
                root
            );
            this.style('#content_views, .blog-content-box, article', {
                'user-select': 'text',
                '-webkit-user-select': 'text'
            }, 'important', root);
            if (document.body) State.setStyle(document.body, 'overflow', 'auto', 'important');
        },

        docin(root) {
            if (!State.settings.copyEnabled) return;
            this.hide(
                '.docin-mask, .docin-login-mask, .docin-vip-mask, .docin-overlay, [class*="docin-mask"], [class*="docin-login"], [class*="docin-vip"], .login-popup, .vip-popup',
                null,
                root
            );
            this.style(
                '.docin-content, .docin-page, .docin-viewer, .doc-content, .page-content, canvas',
                { 'user-select': 'text', '-webkit-user-select': 'text' },
                'important',
                root
            );
        },

        educoder(root) {
            const selectors = '.CodeMirror, .monaco-editor, .ace_editor, textarea, input';
            if (State.settings.copyEnabled) {
                this.style(selectors, {
                    'user-select': 'text',
                    '-webkit-user-select': 'text'
                }, 'important', root);
            }
            if (State.settings.pasteEnabled) {
                Utils.queryAll(root, selectors).forEach(element => {
                    State.removeAttribute(element, 'readonly');
                    State.removeAttribute(element, 'disabled');
                    if (element.classList.contains('monaco-editor')) {
                        State.setAttribute(element, 'contenteditable', 'true');
                    }
                });
            }
            if (State.settings.copyEnabled || State.settings.pasteEnabled) {
                this.hide(
                    '.modal, .popup, .overlay, .mask',
                    element => /复制|粘贴|权限/.test(element.textContent || ''),
                    root
                );
            }
        },

        baiduwenku(root) {
            if (!State.settings.copyEnabled) return;
            this.hide(
                '.pay-pop, .payt-money, .doc-vip, .vip-privilege, .try-end-fold-page, .read-all, .purchase-wrapper, .experience-card, .reader-copy',
                null,
                root
            );
            this.style('.reader-content, .doc-reader, .ie-fix, .reader-wrap, .content-wrapper', {
                'user-select': 'text',
                '-webkit-user-select': 'text'
            }, 'important', root);
        },

        weixin(root) {
            if (!State.settings.copyEnabled) return;
            this.style('#js_content, .rich_media_content, .rich_media_area_primary', {
                'user-select': 'text',
                '-webkit-user-select': 'text'
            }, 'important', root);
        },

        cnki(root) {
            if (!State.settings.copyEnabled) return;
            this.style('.article-content, #content, .txt, .article-text, .brief, .abstract', {
                'user-select': 'text',
                '-webkit-user-select': 'text'
            }, 'important', root);
            this.hide('.login-mask, .vip-mask, .pay-mask', null, root);
        },

        zhihu(root) {
            if (!State.settings.copyEnabled) return;
            this.style('.Post-RichText, .RichText, .RichContent-inner, .ArticleItem-content, .Post-content', {
                'user-select': 'text',
                '-webkit-user-select': 'text'
            }, 'important', root);
            this.hide(
                '.Modal-wrapper, .signFlowModal, .LoginModal',
                element => /登录|注册/.test(element.textContent || ''),
                root
            );
        },

        generic() {}
    };

    const DynamicDOMHandler = {
        init() {
            const run = Utils.throttle(mutations => {
                mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType !== Node.ELEMENT_NODE) return;
                        DOMUnlocker.unlockTree(node);
                        DOMUnlocker.hideGenericMasks(node);
                        SiteHandlers.apply(node);
                    });
                    if (mutation.type === 'attributes') {
                        DOMUnlocker.unlockElement(mutation.target);
                        SiteHandlers.apply(mutation.target.parentElement || document);
                    }
                });
                ShadowDOMHandler.process(document);
            }, CONFIG.MUTATION_DELAY);

            const observer = new MutationObserver(run);
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            });
            State.registerObserver(observer);
        }
    };

    const FloatingInput = {
        box: null,
        controller: null,
        paused: false,
        speed: 'normal',
        timerId: null,
        typing: null,
        speeds: { slow: 100, normal: 50, fast: 20 },

        create() {
            if (!State.settings.mainEnabled || !State.settings.inputEnabled || this.box || !document.body) return;

            const target = State.targetElement || document.activeElement;
            if (!Utils.isEditable(target)) {
                Toast.show('请先选中输入框', 'warning');
                return;
            }

            this.controller = new AbortController();
            const signal = this.controller.signal;
            const box = document.createElement('div');
            box.id = 'unlock-floating-input-box';
            box.innerHTML = `
                <div data-role="header"><strong>🔓 模拟人工输入</strong><button data-role="close" title="关闭">✕</button></div>
                <textarea data-role="text" placeholder="在此输入或粘贴内容"></textarea>
                <div data-role="speed"><span>输入速度</span><select><option value="slow">慢速</option><option value="normal" selected>正常</option><option value="fast">快速</option></select></div>
                <div data-role="actions"><button data-role="start">开始输入</button><button data-role="pause" hidden>暂停</button><button data-role="paste">读取剪贴板</button></div>
                <div data-role="progress"><span></span></div>`;
            Object.assign(box.style, {
                position: 'fixed', top: '20px', right: '20px', width: '320px', padding: '16px',
                background: '#fff', color: '#333', border: '1px solid #ddd', borderRadius: '8px',
                boxShadow: '0 8px 32px rgba(0,0,0,.16)', zIndex: '2147483647',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
            });
            box.querySelector('[data-role="header"]').style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px';
            box.querySelector('[data-role="close"]').style.cssText = 'border:0;background:transparent;cursor:pointer;font-size:16px';
            const textarea = box.querySelector('textarea');
            textarea.style.cssText = 'width:100%;height:100px;padding:10px;resize:none;border:1px solid #ddd;border-radius:6px;box-sizing:border-box';
            box.querySelector('[data-role="speed"]').style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px';
            box.querySelector('[data-role="actions"]').style.cssText = 'display:flex;gap:8px;margin-top:12px';
            box.querySelectorAll('[data-role="actions"] button').forEach(button => {
                button.style.cssText = 'flex:1;padding:8px;border:0;border-radius:6px;cursor:pointer';
            });
            const progress = box.querySelector('[data-role="progress"]');
            progress.style.cssText = 'height:4px;background:#e5e7eb;border-radius:2px;margin-top:10px;overflow:hidden;display:none';
            progress.firstElementChild.style.cssText = 'display:block;width:0;height:100%;background:#4f46e5';

            const startButton = box.querySelector('[data-role="start"]');
            const pauseButton = box.querySelector('[data-role="pause"]');
            const pasteButton = box.querySelector('[data-role="paste"]');
            const speedSelect = box.querySelector('select');

            const updateUI = typing => {
                startButton.textContent = typing ? '停止' : '开始输入';
                pauseButton.hidden = !typing;
                pasteButton.hidden = typing;
                progress.style.display = typing ? 'block' : 'none';
                textarea.disabled = typing;
                speedSelect.disabled = typing;
            };

            startButton.addEventListener('click', () => {
                if (this.typing) {
                    this.stopTyping();
                    updateUI(false);
                    return;
                }
                if (!textarea.value) return;
                this.startTyping(target, textarea.value, progress.firstElementChild, () => updateUI(false));
                updateUI(true);
            }, { signal });

            pauseButton.addEventListener('click', () => {
                this.paused = !this.paused;
                pauseButton.textContent = this.paused ? '继续' : '暂停';
                if (!this.paused) this.scheduleNext();
            }, { signal });

            pasteButton.addEventListener('click', async () => {
                if (!State.settings.pasteEnabled) {
                    Toast.show('粘贴解锁功能未启用', 'warning');
                    return;
                }
                try {
                    textarea.value = await navigator.clipboard.readText();
                } catch {
                    Toast.show('读取剪贴板失败', 'error');
                }
            }, { signal });

            speedSelect.addEventListener('change', event => {
                this.speed = event.target.value;
            }, { signal });
            box.querySelector('[data-role="close"]').addEventListener('click', () => this.destroy(), { signal });
            textarea.addEventListener('keydown', event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    startButton.click();
                } else if (event.key === 'Escape') {
                    this.destroy();
                }
            }, { signal });

            document.body.appendChild(box);
            this.box = box;
            textarea.focus();
        },

        startTyping(element, text, progress, onStop) {
            this.typing = { element, chars: Array.from(text), index: 0, progress, onStop };
            this.paused = false;
            this.scheduleNext();
        },

        scheduleNext() {
            if (!this.typing || this.paused) return;
            if (!State.settings.mainEnabled || !State.settings.inputEnabled || !this.box) {
                this.destroy();
                return;
            }
            if (this.typing.index >= this.typing.chars.length) {
                Toast.show('输入完成', 'success');
                this.destroy();
                return;
            }

            const char = this.typing.chars[this.typing.index++];
            ClipboardActions.insertText(this.typing.element, char);
            this.typing.progress.style.width = `${(this.typing.index / this.typing.chars.length) * 100}%`;
            const baseDelay = this.speeds[this.speed] || this.speeds.normal;
            const delay = Math.max(10, baseDelay + (Math.random() - 0.5) * 30);
            this.timerId = setTimeout(() => this.scheduleNext(), delay);
        },

        stopTyping() {
            if (this.timerId) clearTimeout(this.timerId);
            this.timerId = null;
            const onStop = this.typing?.onStop;
            this.typing = null;
            this.paused = false;
            if (onStop) onStop();
        },

        destroy() {
            this.stopTyping();
            this.controller?.abort();
            this.controller = null;
            this.box?.remove();
            this.box = null;
        }
    };

    const Messaging = {
        init() {
            document.addEventListener('unlockit:dingtalk-selection', event => {
                if (typeof event.detail === 'string') {
                    State.dingTalkSelectionText = event.detail;
                    State.dingTalkSelectionTimestamp = event.detail ? Date.now() : 0;
                }
            }, true);

            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                Promise.resolve(this.handle(message))
                    .then(sendResponse)
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            });

            chrome.storage.onChanged.addListener((changes, areaName) => {
                if (areaName !== 'local' || !changes[CONFIG.STORAGE_KEY]) return;
                App.applySettings(changes[CONFIG.STORAGE_KEY].newValue, true);
            });
        },

        async handle(message) {
            switch (message.type) {
                case 'openFloatingInput':
                    if (!State.settings.mainEnabled || !State.settings.inputEnabled) {
                        return { success: false, error: 'Input feature disabled' };
                    }
                    State.targetElement = document.activeElement;
                    FloatingInput.create();
                    return { success: true };
                case 'forcePaste':
                    return ClipboardActions.forcePaste();
                case 'getDingTalkSelection':
                    return ClipboardActions.getDingTalkSelection();
                case 'getSettings':
                    return { success: true, settings: State.settings };
                case 'showToast':
                    Toast.show(message.message, message.toastType || 'success');
                    return { success: true };
                case 'ping':
                    return { pong: true, version: CONFIG.VERSION };
                default:
                    return { success: false, error: 'Unknown message type' };
            }
        }
    };

    const App = {
        async init() {
            Messaging.init();
            const settings = await Storage.getSettings();
            State.settings = Utils.validateSettings(settings);
            MainWorldBridge.syncSettings(State.settings);
            await this.waitForDocument();
            this.applySettings(await Storage.getSettings(), false);
            State.initialized = true;
        },

        waitForDocument() {
            if (document.documentElement && document.body) return Promise.resolve();
            return new Promise(resolve => {
                document.addEventListener('DOMContentLoaded', resolve, { once: true });
            });
        },

        applySettings(settings, showToast) {
            const previous = State.settings;
            const next = Utils.validateSettings(settings);
            const unchanged = ['mainEnabled', 'copyEnabled', 'pasteEnabled', 'inputEnabled']
                .every(key => previous[key] === next[key]);
            if (State.initialized && unchanged) return;

            CopyRestrictionDetector.stop();
            if (State.featuresEnabled) State.cleanup();

            State.settings = next;
            MainWorldBridge.syncSettings(next);

            // storage 变化可能发生在 document_start 的 DOM 创建之前。
            if (!document.documentElement || !document.body) return;

            if (next.mainEnabled) {
                this.enableFeatures();
            } else {
                CopyRestrictionDetector.start();
            }

            if (showToast && window === window.top && State.initialized && previous.mainEnabled !== next.mainEnabled) {
                Toast.show(next.mainEnabled ? '插件已启用' : '插件已禁用', next.mainEnabled ? 'success' : 'info');
            }
        },

        enableFeatures() {
            if (State.featuresEnabled || !State.settings.mainEnabled) return;
            State.featuresEnabled = true;

            if (State.settings.copyEnabled) {
                DOMUnlocker.unlockTree(document);
                DOMUnlocker.hideGenericMasks(document);
                ShadowDOMHandler.init();
            }
            SiteHandlers.apply(document);
            DynamicDOMHandler.init();

            if (State.settings.inputEnabled) {
                State.registerEventListener(document, 'keydown', event => {
                    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
                        event.preventDefault();
                        event.stopPropagation();
                        State.targetElement = document.activeElement;
                        FloatingInput.create();
                    }
                }, true);
                State.registerEventListener(document, 'dblclick', event => {
                    if (!Utils.isEditable(event.target)) return;
                    State.targetElement = event.target;
                    FloatingInput.create();
                }, true);
            }
        }
    };

    window.addEventListener('beforeunload', () => {
        CopyRestrictionDetector.stop();
        State.cleanup();
    });

    App.init().catch(error => Logger.error('Initialization failed:', error));
})();
