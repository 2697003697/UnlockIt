/*
 * UnlockIt content script
 * 页面修改只在功能启用期间生效，关闭或切换设置时会恢复原始 DOM 状态。
 */

(function() {
    'use strict';

    const CONFIG = {
        VERSION: '8.2.1',
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
        docinSelectionText: '',
        docinSelectionTimestamp: 0,
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
            this.docinSelectionText = '';
            this.docinSelectionTimestamp = 0;
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
        },

        getDocinSelection() {
            if (!PageDetector.is('docin') ||
                !State.settings.mainEnabled ||
                !State.settings.copyEnabled ||
                !State.docinSelectionText ||
                Date.now() - State.docinSelectionTimestamp > 60000) {
                return { success: false, text: '' };
            }
            return { success: true, text: State.docinSelectionText };
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

    const DocinSelectionEngine = {
        initialized: false,
        active: false,
        startPoint: null,
        currentPoint: null,
        overlay: null,
        styleElement: null,
        resolveToken: 0,

        init() {
            if (this.initialized || !PageDetector.is('docin')) return;
            this.initialized = true;
            this.installStyles();

            State.registerEventListener(document, 'unlockit:docin-pointer', event => {
                if (typeof event.detail !== 'string') return;
                try {
                    this.handlePointer(JSON.parse(event.detail));
                } catch (error) {
                    Logger.warn('Invalid Docin pointer event:', error);
                }
            }, true);
            State.addCleanup(() => this.reset());
        },

        installStyles() {
            if (this.styleElement || !document.documentElement) return;
            const style = document.createElement('style');
            style.id = 'unlock-docin-reader-style';
            style.textContent = `
                #contentcontainer,
                #contentcontainer .model.panel,
                #contentcontainer .panel_inner,
                #contentcontainer .PageView_content__1DxhR,
                #contentcontainer .hkswf-content2,
                #contentcontainer svg,
                #contentcontainer svg text,
                #contentcontainer svg tspan {
                    -webkit-user-select: none !important;
                    user-select: none !important;
                    cursor: text !important;
                }
            `;
            document.documentElement.appendChild(style);
            this.styleElement = style;
        },

        reset() {
            this.active = false;
            this.startPoint = null;
            this.currentPoint = null;
            this.resolveToken++;
            this.overlay?.remove();
            this.overlay = null;
            this.styleElement?.remove();
            this.styleElement = null;
            this.initialized = false;
            this.publishSelection('');
        },

        publishSelection(text) {
            State.docinSelectionText = text;
            State.docinSelectionTimestamp = text ? Date.now() : 0;
            document.dispatchEvent(new CustomEvent('unlockit:docin-selection', { detail: text }));
        },

        handlePointer(pointer) {
            if (!State.settings.mainEnabled || !State.settings.copyEnabled) return;
            if (pointer.type === 'down') this.start(pointer.x, pointer.y);
            else if (pointer.type === 'move') this.move(pointer.x, pointer.y);
            else if (pointer.type === 'up') this.finish(pointer.x, pointer.y);
            else if (pointer.type === 'cancel') this.cancel();
        },

        start(x, y) {
            this.resolveToken++;
            this.active = true;
            this.startPoint = { x, y };
            this.currentPoint = { x, y };
            this.overlay?.remove();
            this.overlay = null;
            this.publishSelection('');
            this.renderDragBox();
        },

        move(x, y) {
            if (!this.active) return;
            this.currentPoint = { x, y };
            this.renderDragBox();
        },

        finish(x, y) {
            if (!this.active) return;
            this.active = false;
            this.currentPoint = { x, y };
            this.renderDragBox();
            const token = ++this.resolveToken;
            requestAnimationFrame(() => this.resolveSelection(token));
        },

        cancel() {
            this.active = false;
            this.overlay?.remove();
            this.overlay = null;
        },

        async resolveSelection(token) {
            const startTime = performance.now();
            const pages = this.getSelectedPages();
            if (token !== this.resolveToken) return;
            if (pages.length === 0) {
                this.cancel();
                Toast.show('未找到已加载的文档页面', 'warning');
                return;
            }

            const glyphs = await this.collectSelectedGlyphs(pages, token);
            if (token !== this.resolveToken) return;
            if (glyphs.length === 0) {
                this.cancel();
                Toast.show('框选区域内没有已加载文字，请滚动到文字显示后重试', 'warning');
                return;
            }

            const ordered = this.sortIntoReadingOrder(glyphs);
            const startIndex = this.findNearestGlyph(ordered, this.startPoint);
            const endIndex = this.findNearestGlyph(ordered, this.currentPoint);
            if (startIndex < 0 || endIndex < 0) {
                this.cancel();
                return;
            }

            const from = Math.min(startIndex, endIndex);
            const to = Math.max(startIndex, endIndex);
            const selected = ordered.slice(from, to + 1);
            const text = this.buildText(selected);
            this.publishSelection(text);
            this.renderHighlights(selected);

            if (text) {
                Logger.log('Docin selection resolved in', Math.round(performance.now() - startTime), 'ms');
                Toast.show('已框选文字，按 Ctrl+C 或使用右键菜单复制', 'success', 2400);
            }
        },

        getSelectedPages() {
            const pages = Utils.queryAll(document, '#contentcontainer .model.panel')
                .map((element, domIndex) => ({
                    element,
                    domIndex,
                    pageIndex: Number(element.id?.match(/page_(\d+)/)?.[1] || domIndex + 1),
                    rect: element.getBoundingClientRect()
                }))
                .filter(page => page.rect.width > 0 && page.rect.height > 0);
            if (pages.length === 0) return [];

            const startPage = this.findNearestPage(pages, this.startPoint);
            const endPage = this.findNearestPage(pages, this.currentPoint);
            if (!startPage || !endPage) return [];

            const minIndex = Math.min(startPage.domIndex, endPage.domIndex);
            const maxIndex = Math.max(startPage.domIndex, endPage.domIndex);
            return pages.filter(page => page.domIndex >= minIndex && page.domIndex <= maxIndex);
        },

        findNearestPage(pages, point) {
            let nearest = null;
            let nearestDistance = Infinity;
            pages.forEach(page => {
                const dx = point.x < page.rect.left ? page.rect.left - point.x :
                    point.x > page.rect.right ? point.x - page.rect.right : 0;
                const dy = point.y < page.rect.top ? page.rect.top - point.y :
                    point.y > page.rect.bottom ? point.y - page.rect.bottom : 0;
                const distance = Math.hypot(dx, dy);
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearest = page;
                }
            });
            return nearest;
        },

        async collectSelectedGlyphs(pages, token) {
            const glyphs = [];
            const firstPage = pages[0];
            const lastPage = pages[pages.length - 1];
            const startPage = this.findNearestPage(pages, this.startPoint);
            const endPage = this.findNearestPage(pages, this.currentPoint);
            const isForward = startPage.domIndex < endPage.domIndex ||
                (startPage.domIndex === endPage.domIndex &&
                    (this.startPoint.y < this.currentPoint.y ||
                        (this.startPoint.y === this.currentPoint.y && this.startPoint.x <= this.currentPoint.x)));
            const logicalStart = isForward ? this.startPoint : this.currentPoint;
            const logicalEnd = isForward ? this.currentPoint : this.startPoint;

            for (const page of pages) {
                if (token !== this.resolveToken) return [];
                const textElements = Utils.queryAll(page.element, '.hkswf-content2 svg text, .PageView_content__1DxhR svg text');
                const candidates = textElements.filter(textElement => {
                    if (!textElement.textContent) return false;
                    const rect = textElement.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) return false;
                    const centerY = rect.top + rect.height / 2;
                    if (pages.length === 1) {
                        const top = Math.min(logicalStart.y, logicalEnd.y) - rect.height;
                        const bottom = Math.max(logicalStart.y, logicalEnd.y) + rect.height;
                        return centerY >= top && centerY <= bottom;
                    }
                    if (page === firstPage) return centerY >= logicalStart.y - rect.height;
                    if (page === lastPage) return centerY <= logicalEnd.y + rect.height;
                    return true;
                });

                for (let index = 0; index < candidates.length; index++) {
                    glyphs.push(...this.extractGlyphs(candidates[index], page.pageIndex));
                    if (index > 0 && index % 40 === 0) {
                        await new Promise(resolve => requestAnimationFrame(resolve));
                        if (token !== this.resolveToken) return [];
                    }
                }
            }
            return glyphs;
        },

        extractGlyphs(textElement, pageIndex) {
            const matrix = textElement.getScreenCTM?.();
            const characters = Array.from(textElement.textContent || '');
            if (!matrix || characters.length === 0) return [];

            const positionedGlyphs = this.extractPositionedGlyphs(textElement, pageIndex, characters, matrix);
            if (positionedGlyphs) return positionedGlyphs;

            let count;
            try {
                count = Math.min(textElement.getNumberOfChars(), characters.length);
            } catch {
                return [];
            }

            const glyphs = [];
            for (let index = 0; index < count; index++) {
                try {
                    const extent = textElement.getExtentOfChar(index);
                    const rect = this.transformExtent(extent, matrix);
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    glyphs.push({
                        char: characters[index],
                        pageIndex,
                        rect,
                        centerX: rect.left + rect.width / 2,
                        centerY: rect.top + rect.height / 2
                    });
                } catch {
                    // Some SVG engines omit geometry for hidden or malformed glyphs.
                }
            }
            return glyphs;
        },

        extractPositionedGlyphs(textElement, pageIndex, characters, matrix) {
            const xList = textElement.x?.baseVal;
            const yList = textElement.y?.baseVal;
            if (!xList || xList.numberOfItems < characters.length || !yList || yList.numberOfItems === 0) {
                return null;
            }

            const fontSize = Number.parseFloat(textElement.getAttribute('font-size')) || 12;
            const glyphs = [];
            for (let index = 0; index < characters.length; index++) {
                const x = xList.getItem(index).value;
                const y = yList.getItem(Math.min(index, yList.numberOfItems - 1)).value;
                const nextX = index + 1 < xList.numberOfItems ? xList.getItem(index + 1).value : NaN;
                const width = Number.isFinite(nextX) && nextX > x ? nextX - x : fontSize * 0.65;
                const rect = this.transformExtent({
                    x,
                    y: y - fontSize * 0.9,
                    width,
                    height: fontSize * 1.2
                }, matrix);
                if (rect.width <= 0 || rect.height <= 0) continue;
                glyphs.push({
                    char: characters[index],
                    pageIndex,
                    rect,
                    centerX: rect.left + rect.width / 2,
                    centerY: rect.top + rect.height / 2
                });
            }
            return glyphs;
        },

        transformExtent(extent, matrix) {
            const points = [
                new DOMPoint(extent.x, extent.y).matrixTransform(matrix),
                new DOMPoint(extent.x + extent.width, extent.y).matrixTransform(matrix),
                new DOMPoint(extent.x, extent.y + extent.height).matrixTransform(matrix),
                new DOMPoint(extent.x + extent.width, extent.y + extent.height).matrixTransform(matrix)
            ];
            const xs = points.map(point => point.x);
            const ys = points.map(point => point.y);
            const left = Math.min(...xs);
            const right = Math.max(...xs);
            const top = Math.min(...ys);
            const bottom = Math.max(...ys);
            return { left, right, top, bottom, width: right - left, height: bottom - top };
        },

        sortIntoReadingOrder(glyphs) {
            const pages = new Map();
            glyphs.forEach(glyph => {
                if (!pages.has(glyph.pageIndex)) pages.set(glyph.pageIndex, []);
                pages.get(glyph.pageIndex).push(glyph);
            });

            const ordered = [];
            Array.from(pages.keys()).sort((a, b) => a - b).forEach(pageIndex => {
                const pageGlyphs = pages.get(pageIndex).sort((a, b) => a.centerY - b.centerY);
                const lines = [];
                pageGlyphs.forEach(glyph => {
                    let line = lines.find(candidate => {
                        const tolerance = Math.max(2, Math.min(candidate.height, glyph.rect.height) * 0.55);
                        return Math.abs(candidate.centerY - glyph.centerY) <= tolerance;
                    });
                    if (!line) {
                        line = { centerY: glyph.centerY, height: glyph.rect.height, glyphs: [] };
                        lines.push(line);
                    }
                    line.glyphs.push(glyph);
                    line.centerY = line.glyphs.reduce((sum, item) => sum + item.centerY, 0) / line.glyphs.length;
                    line.height = Math.max(line.height, glyph.rect.height);
                });

                lines.sort((a, b) => a.centerY - b.centerY).forEach((line, lineIndex) => {
                    line.glyphs.sort((a, b) => a.centerX - b.centerX).forEach(glyph => {
                        glyph.lineIndex = lineIndex;
                        ordered.push(glyph);
                    });
                });
            });
            return ordered;
        },

        findNearestGlyph(glyphs, point) {
            let nearestIndex = -1;
            let nearestDistance = Infinity;
            glyphs.forEach((glyph, index) => {
                const dx = point.x < glyph.rect.left ? glyph.rect.left - point.x :
                    point.x > glyph.rect.right ? point.x - glyph.rect.right : 0;
                const dy = point.y < glyph.rect.top ? glyph.rect.top - point.y :
                    point.y > glyph.rect.bottom ? point.y - glyph.rect.bottom : 0;
                const distance = Math.hypot(dx, dy);
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestIndex = index;
                }
            });
            return nearestIndex;
        },

        buildText(glyphs) {
            const lines = [];
            let currentLine = null;
            glyphs.forEach(glyph => {
                const key = `${glyph.pageIndex}:${glyph.lineIndex}`;
                if (!currentLine || currentLine.key !== key) {
                    currentLine = { key, pageIndex: glyph.pageIndex, chars: [] };
                    lines.push(currentLine);
                }
                currentLine.chars.push(glyph.char);
            });
            return lines.map((line, index) => {
                const previous = lines[index - 1];
                return `${previous && previous.pageIndex !== line.pageIndex ? '\n' : ''}${line.chars.join('')}`;
            }).join('\n');
        },

        createOverlay(reset = false) {
            if (reset) {
                this.overlay?.remove();
                this.overlay = null;
            }
            if (this.overlay?.isConnected) return this.overlay;
            if (!document.body) return null;
            const overlay = document.createElement('div');
            overlay.id = 'unlock-docin-selection-overlay';
            overlay.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646;';
            document.body.appendChild(overlay);
            this.overlay = overlay;
            return overlay;
        },

        renderDragBox() {
            if (!this.startPoint || !this.currentPoint) return;
            const overlay = this.createOverlay();
            if (!overlay) return;
            let box = overlay.querySelector('[data-unlock-docin-drag-box]');
            if (!box) {
                box = document.createElement('span');
                box.setAttribute('data-unlock-docin-drag-box', 'true');
                overlay.appendChild(box);
            }
            const left = Math.min(this.startPoint.x, this.currentPoint.x);
            const top = Math.min(this.startPoint.y, this.currentPoint.y);
            const width = Math.abs(this.currentPoint.x - this.startPoint.x);
            const height = Math.abs(this.currentPoint.y - this.startPoint.y);
            box.style.cssText = [
                'position:absolute',
                `left:${left + window.scrollX}px`,
                `top:${top + window.scrollY}px`,
                `width:${Math.max(1, width)}px`,
                `height:${Math.max(1, height)}px`,
                'background:rgba(37,99,235,.10)',
                'border:1px solid rgba(37,99,235,.55)',
                'box-sizing:border-box'
            ].join(';');
        },

        renderHighlights(glyphs) {
            const overlay = this.createOverlay(true);
            if (!overlay) return;
            const segments = [];
            glyphs.forEach(glyph => {
                const previous = segments[segments.length - 1];
                const sameLine = previous && previous.pageIndex === glyph.pageIndex && previous.lineIndex === glyph.lineIndex;
                const gap = previous ? glyph.rect.left - previous.right : Infinity;
                if (sameLine && gap <= Math.max(12, glyph.rect.height * 1.5)) {
                    previous.right = Math.max(previous.right, glyph.rect.right);
                    previous.top = Math.min(previous.top, glyph.rect.top);
                    previous.bottom = Math.max(previous.bottom, glyph.rect.bottom);
                } else {
                    segments.push({
                        pageIndex: glyph.pageIndex,
                        lineIndex: glyph.lineIndex,
                        left: glyph.rect.left,
                        right: glyph.rect.right,
                        top: glyph.rect.top,
                        bottom: glyph.rect.bottom
                    });
                }
            });

            segments.forEach(segment => {
                const highlight = document.createElement('span');
                highlight.style.cssText = [
                    'position:absolute',
                    `left:${segment.left + window.scrollX}px`,
                    `top:${segment.top + window.scrollY}px`,
                    `width:${Math.max(1, segment.right - segment.left)}px`,
                    `height:${Math.max(1, segment.bottom - segment.top)}px`,
                    'background:rgba(37,99,235,.28)',
                    'border-radius:2px'
                ].join(';');
                overlay.appendChild(highlight);
            });
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
            DocinSelectionEngine.init();
            this.hide(
                '.docin-mask, .docin-login-mask, .docin-vip-mask, .docin-overlay, [class*="docin-mask"], [class*="docin-login"], [class*="docin-vip"], .login-popup, .vip-popup',
                null,
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
            const isDocin = PageDetector.is('docin');
            const run = Utils.throttle(mutations => {
                mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType !== Node.ELEMENT_NODE) return;
                        if (isDocin) {
                            SiteHandlers.docin(node);
                            return;
                        }
                        DOMUnlocker.unlockTree(node);
                        DOMUnlocker.hideGenericMasks(node);
                        SiteHandlers.apply(node);
                    });
                    if (!isDocin && mutation.type === 'attributes') {
                        DOMUnlocker.unlockElement(mutation.target);
                        SiteHandlers.apply(mutation.target.parentElement || document);
                    }
                });
                if (!isDocin) ShadowDOMHandler.process(document);
            }, CONFIG.MUTATION_DELAY);

            const observer = new MutationObserver(run);
            const observerConfig = {
                childList: true,
                subtree: true
            };
            if (!isDocin) {
                observerConfig.attributes = true;
                observerConfig.attributeFilter = ['style', 'class'];
            }
            observer.observe(document.documentElement, observerConfig);
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

            document.addEventListener('unlockit:docin-selection', event => {
                if (typeof event.detail === 'string') {
                    State.docinSelectionText = event.detail;
                    State.docinSelectionTimestamp = event.detail ? Date.now() : 0;
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
                case 'getDocinSelection':
                    return ClipboardActions.getDocinSelection();
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

            const isDocin = PageDetector.is('docin');
            if (State.settings.copyEnabled && !isDocin) {
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
