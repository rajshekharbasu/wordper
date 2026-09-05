(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.WordperfectConnectionRecovery = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const DISCONNECT_STATUSES = {
        CHANNEL_ERROR: true,
        TIMED_OUT: true,
        CLOSED: true
    };

    function createConnectionRecovery(options = {}) {
        const graceMs = options.graceMs == null ? 3000 : options.graceMs;
        const visibleRetryMs = options.visibleRetryMs == null ? 1500 : options.visibleRetryMs;
        const setTimeoutFn = options.setTimeout || setTimeout;
        const clearTimeoutFn = options.clearTimeout || clearTimeout;
        const isHidden = options.isHidden || function () { return false; };
        const onLost = options.onLost || function () {};
        const onRecovered = options.onRecovered || function () {};

        let everJoined = false;
        let overlayVisible = false;
        let pendingTimer = null;
        let waitingForVisible = false;

        function clearPending() {
            if (pendingTimer != null) {
                clearTimeoutFn(pendingTimer);
                pendingTimer = null;
            }
            waitingForVisible = false;
        }

        function fireLost() {
            if (overlayVisible) return;
            overlayVisible = true;
            onLost();
        }

        function tryFireLost() {
            if (isHidden()) {
                waitingForVisible = true;
                return;
            }
            fireLost();
        }

        function schedule(delay) {
            if (pendingTimer != null || overlayVisible || waitingForVisible) return;
            pendingTimer = setTimeoutFn(function () {
                pendingTimer = null;
                tryFireLost();
            }, delay);
        }

        return {
            handleStatus: function (status, ctx) {
                ctx = ctx || {};

                if (status === 'SUBSCRIBED') {
                    const wasShowing = overlayVisible;
                    everJoined = true;
                    overlayVisible = false;
                    clearPending();
                    if (wasShowing) onRecovered();
                    return;
                }

                if (!DISCONNECT_STATUSES[status]) return;

                if (ctx.intentionalClose) {
                    clearPending();
                    return;
                }

                if (!everJoined && !ctx.allowBeforeJoin) return;
                if (overlayVisible) return;

                schedule(graceMs);
            },

            handleVisibility: function () {
                if (!waitingForVisible) return;
                if (isHidden()) return;
                waitingForVisible = false;
                pendingTimer = setTimeoutFn(function () {
                    pendingTimer = null;
                    tryFireLost();
                }, visibleRetryMs);
            },

            reset: function () {
                clearPending();
                everJoined = false;
                overlayVisible = false;
            }
        };
    }

    return {
        create: createConnectionRecovery,
        createConnectionRecovery: createConnectionRecovery
    };
}));
