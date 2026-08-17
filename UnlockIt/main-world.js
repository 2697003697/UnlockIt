(function() {
    'use strict';

    if (window.__unlockItMainWorldInstalled) return;
    window.__unlockItMainWorldInstalled = true;

    const SETTINGS_EVENT = 'unlockit:settings';
    const SELECTION_EVENT = 'unlockit:dingtalk-selection';
    const state = {
        mainEnabled: false,
        copyEnabled: true,
        pasteEnabled: true
    };

    let fetchWrapper = null;
    let xhrSendWrapper = null;
    let previousFetch = null;
    let previousXhrSend = null;
    let dingTalkSelectionText = '';
    let dingTalkSelectionRange = null;
    let dingTalkSelectionTimestamp = 0;
    const DINGTALK_SELECTION_TTL = 60000;

    const updateState = settings => {
        if (!settings || typeof settings !== 'object') return;
        ['mainEnabled', 'copyEnabled', 'pasteEnabled'].forEach(key => {
            if (typeof settings[key] === 'boolean') {
                state[key] = settings[key];
            }
        });

        if (state.mainEnabled && state.copyEnabled) {
            installNetworkInterceptors();
        } else {
            uninstallNetworkInterceptors();
            clearDingTalkSelection();
        }
    };

    const isDingTalkEditorNode = node => {
        if (!node) return false;
        const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        return Boolean(element?.closest?.('article[data-cangjie-content="true"], article.body-editor-content'));
    };

    const publishDingTalkSelection = () => {
        document.dispatchEvent(new CustomEvent(SELECTION_EVENT, {
            detail: dingTalkSelectionText
        }));
    };

    const clearDingTalkSelection = () => {
        dingTalkSelectionText = '';
        dingTalkSelectionRange = null;
        dingTalkSelectionTimestamp = 0;
        publishDingTalkSelection();
    };

    const hasFreshDingTalkSelection = () => {
        return Boolean(dingTalkSelectionText &&
            Date.now() - dingTalkSelectionTimestamp <= DINGTALK_SELECTION_TTL);
    };

    const cacheDingTalkSelection = (publishCached = false) => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            if (!hasFreshDingTalkSelection()) clearDingTalkSelection();
            if (publishCached && dingTalkSelectionText) publishDingTalkSelection();
            return dingTalkSelectionText;
        }
        if (!isDingTalkEditorNode(selection.anchorNode) && !isDingTalkEditorNode(selection.focusNode)) {
            if (!hasFreshDingTalkSelection()) clearDingTalkSelection();
            if (publishCached && dingTalkSelectionText) publishDingTalkSelection();
            return dingTalkSelectionText;
        }

        const text = selection.toString();
        if (!text) return dingTalkSelectionText;

        dingTalkSelectionText = text;
        dingTalkSelectionRange = selection.getRangeAt(0).cloneRange();
        dingTalkSelectionTimestamp = Date.now();
        publishDingTalkSelection();
        return text;
    };

    const restoreDingTalkSelection = () => {
        if (!dingTalkSelectionRange) return;
        try {
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(dingTalkSelectionRange.cloneRange());
        } catch {
            dingTalkSelectionRange = null;
        }
    };

    const getSelectedText = () => {
        const activeElement = document.activeElement;
        if (activeElement &&
            (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA') &&
            typeof activeElement.selectionStart === 'number' &&
            typeof activeElement.selectionEnd === 'number') {
            return activeElement.value.slice(activeElement.selectionStart, activeElement.selectionEnd);
        }
        if (!hasFreshDingTalkSelection()) clearDingTalkSelection();
        return window.getSelection()?.toString() || dingTalkSelectionText || '';
    };

    document.addEventListener('selectionchange', () => cacheDingTalkSelection(), true);
    window.addEventListener('mouseup', () => setTimeout(cacheDingTalkSelection, 0), true);
    window.addEventListener('mousedown', event => {
        if (event.button === 0) clearDingTalkSelection();
    }, true);
    window.addEventListener('contextmenu', event => {
        if (!isDingTalkEditorNode(event.target)) {
            clearDingTalkSelection();
            return;
        }
        cacheDingTalkSelection(true);
    }, true);

    document.addEventListener(SETTINGS_EVENT, event => {
        try {
            updateState(typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail);
        } catch {
            // Ignore malformed settings events.
        }
    }, true);

    window.addEventListener('keydown', event => {
        if (!state.mainEnabled || event.altKey || !(event.ctrlKey || event.metaKey)) return;

        const key = event.key.toLowerCase();
        if (key === 'c' && state.copyEnabled && getSelectedText()) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!window.getSelection()?.toString() && dingTalkSelectionText) {
                restoreDingTalkSelection();
            }
            document.execCommand('copy');
        } else if (key === 'v' && state.pasteEnabled) {
            event.stopImmediatePropagation();
        }
    }, true);

    window.addEventListener('copy', event => {
        if (!state.mainEnabled || !state.copyEnabled || !event.clipboardData) return;

        const text = getSelectedText();
        if (!text) return;

        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);

    window.addEventListener('cut', event => {
        if (state.mainEnabled && state.copyEnabled) {
            event.stopImmediatePropagation();
        }
    }, true);

    window.addEventListener('paste', event => {
        if (state.mainEnabled && state.pasteEnabled) {
            event.stopImmediatePropagation();
        }
    }, true);

    window.addEventListener('beforeinput', event => {
        if (state.mainEnabled &&
            state.pasteEnabled &&
            event.inputType === 'insertFromPaste') {
            event.stopImmediatePropagation();
        }
    }, true);

    ['contextmenu', 'selectstart', 'dragstart'].forEach(eventName => {
        window.addEventListener(eventName, event => {
            if (state.mainEnabled && state.copyEnabled) {
                event.stopImmediatePropagation();
            }
        }, true);
    });

    const patchCopyPermission = data => {
        if (!state.mainEnabled || !state.copyEnabled ||
            !data || typeof data !== 'object' ||
            !data.data?.actions || data.data.actions.copy === undefined) {
            return data;
        }

        data.data.actions.copy = 1;
        return data;
    };

    function installNetworkInterceptors() {
        if (typeof window.fetch === 'function' && !fetchWrapper) {
            previousFetch = window.fetch;
            fetchWrapper = async function(...args) {
                const response = await previousFetch.apply(this, args);
                if (!state.mainEnabled || !state.copyEnabled ||
                    !response.headers.get('content-type')?.includes('application/json')) {
                    return response;
                }

                try {
                    const data = patchCopyPermission(await response.clone().json());
                    if (data?.data?.actions?.copy === 1) {
                        return new Response(JSON.stringify(data), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    }
                } catch {
                    // Return the original response when it is not compatible JSON.
                }
                return response;
            };
            window.fetch = fetchWrapper;
        }

        if (!xhrSendWrapper) {
            previousXhrSend = XMLHttpRequest.prototype.send;
            xhrSendWrapper = function(...args) {
                this.addEventListener('readystatechange', () => {
                    if (this.readyState !== 4 || !state.mainEnabled || !state.copyEnabled) return;

                    try {
                        if (!this.getResponseHeader('content-type')?.includes('application/json')) return;
                        const data = patchCopyPermission(JSON.parse(this.responseText));
                        if (data?.data?.actions?.copy === 1) {
                            Object.defineProperty(this, 'responseText', {
                                configurable: true,
                                value: JSON.stringify(data)
                            });
                        }
                    } catch {
                        // Ignore responses whose properties cannot be replaced.
                    }
                });
                return previousXhrSend.apply(this, args);
            };
            XMLHttpRequest.prototype.send = xhrSendWrapper;
        }
    }

    function uninstallNetworkInterceptors() {
        if (fetchWrapper && window.fetch === fetchWrapper) {
            window.fetch = previousFetch;
        }
        fetchWrapper = null;
        previousFetch = null;

        if (xhrSendWrapper && XMLHttpRequest.prototype.send === xhrSendWrapper) {
            XMLHttpRequest.prototype.send = previousXhrSend;
        }
        xhrSendWrapper = null;
        previousXhrSend = null;
    }

    /*
     * Network wrappers are installed only while copy unlocking is enabled.
     * Event listeners stay installed once but are strict no-ops when disabled.
     */
    if (state.mainEnabled && state.copyEnabled) {
        installNetworkInterceptors();
    }
})();
