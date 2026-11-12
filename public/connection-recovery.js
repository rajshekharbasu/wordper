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

    // Supabase reconnects at 1s, then 2s, then 5s, then every 10s.
    // A 3s grace opened this dialog on the third attempt, while the
    // socket was still coming back and broadcast send() was falling
    // back to REST. Fifteen seconds of actual silence is the outage.
    const DEFAULT_GRACE_MS = 15000;

    const DEFAULT_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];
    const MAX_RECONNECT_ATTEMPTS = 5;

    function createReconnectManager(options) {
        var opts = options || {};
        var delays = opts.delays || DEFAULT_RECONNECT_DELAYS;
        var maxAttempts = opts.maxAttempts == null ? MAX_RECONNECT_ATTEMPTS : opts.maxAttempts;
        var setTimeoutFn = opts.setTimeout || setTimeout;
        var clearTimeoutFn = opts.clearTimeout || clearTimeout;
        var onReconnect = opts.onReconnect || function () { return Promise.resolve(); };
        var onGiveUp = opts.onGiveUp || function () {};

        var attempt = 0;
        var pendingTimer = null;
        var active = false;

        function clearPending() {
            if (pendingTimer != null) {
                clearTimeoutFn(pendingTimer);
                pendingTimer = null;
            }
        }

        function scheduleNext() {
            if (!active) return;
            if (attempt >= maxAttempts) {
                active = false;
                onGiveUp();
                return;
            }
            var delay = delays[Math.min(attempt, delays.length - 1)];
            pendingTimer = setTimeoutFn(function () {
                pendingTimer = null;
                if (!active) return;
                attempt++;
                Promise.resolve(onReconnect(attempt)).then(
                    function () {},
                    function () {
                        scheduleNext();
                    }
                );
            }, delay);
        }

        return {
            start: function start() {
                if (active) return;
                active = true;
                attempt = 0;
                scheduleNext();
            },
            stop: function stop() {
                active = false;
                clearPending();
            },
            success: function success() {
                active = false;
                attempt = 0;
                clearPending();
            },
            reset: function reset() {
                active = false;
                attempt = 0;
                clearPending();
            },
            getAttempt: function getAttempt() {
                return attempt;
            },
            isActive: function isActive() {
                return active;
            }
        };
    }

    function createConnectionRecovery(options = {}) {
        const graceMs = options.graceMs == null ? DEFAULT_GRACE_MS : options.graceMs;
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
        let unhealthy = false;

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

        function markHealthy() {
            const wasShowing = overlayVisible;
            everJoined = true;
            unhealthy = false;
            overlayVisible = false;
            clearPending();
            if (wasShowing) onRecovered();
        }

        return {
            handleStatus: function (status, ctx) {
                ctx = ctx || {};

                if (status === 'SUBSCRIBED') {
                    markHealthy();
                    return;
                }

                if (!DISCONNECT_STATUSES[status]) return;

                if (ctx.intentionalClose) {
                    unhealthy = false;
                    clearPending();
                    return;
                }

                if (!everJoined && !ctx.allowBeforeJoin) return;

                unhealthy = true;
                if (overlayVisible) return;

                schedule(graceMs);
            },

            // Inbound room traffic, or a broadcast that actually reached
            // Supabase over REST, means this player is still in the game.
            // Restart the silence clock instead of treating CLOSED as final.
            noteContact: function () {
                if (!unhealthy) return;
                const wasShowing = overlayVisible;
                clearPending();
                if (wasShowing) {
                    overlayVisible = false;
                    onRecovered();
                }
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
                unhealthy = false;
            }
        };
    }

    return {
        create: createConnectionRecovery,
        createConnectionRecovery: createConnectionRecovery,
        createReconnectManager: createReconnectManager,
        graceMs: DEFAULT_GRACE_MS,
        DEFAULT_RECONNECT_DELAYS: DEFAULT_RECONNECT_DELAYS,
        MAX_RECONNECT_ATTEMPTS: MAX_RECONNECT_ATTEMPTS
    };
}));
