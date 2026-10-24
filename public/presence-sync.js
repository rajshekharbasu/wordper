(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.WordperfectPresenceSync = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    var DEFAULT_THROTTLE_MS = 2500;
    var DEFAULT_HOST_ELECTION_GRACE_MS = 3000;

    function createLatest(track) {
        let latest = 0;
        let tail = Promise.resolve();

        return function submit(payload) {
            const ticket = ++latest;
            const run = tail.then(function () {
                if (ticket !== latest) return false;
                return Promise.resolve(track(payload)).then(function () { return true; });
            });
            tail = run.then(function () {}, function () {});
            return run;
        };
    }

    function createThrottled(track, options) {
        var opts = options || {};
        var throttleMs = opts.throttleMs == null ? DEFAULT_THROTTLE_MS : opts.throttleMs;
        var setTimeoutFn = opts.setTimeout || setTimeout;
        var clearTimeoutFn = opts.clearTimeout || clearTimeout;
        var nowFn = opts.now || function () { return Date.now(); };

        var lastSentAt = -Infinity;
        var pendingPayload = null;
        var pendingTimer = null;
        var inFlight = false;
        var flightQueue = [];

        function doSend(payload) {
            inFlight = true;
            lastSentAt = nowFn();
            return Promise.resolve(track(payload)).then(
                function () {
                    inFlight = false;
                    drainQueue(true);
                },
                function (err) {
                    inFlight = false;
                    drainQueue(false);
                    throw err;
                }
            );
        }

        function drainQueue(success) {
            var waiting = flightQueue;
            flightQueue = [];
            waiting.forEach(function (cb) { cb(success); });
        }

        function scheduleTrailing() {
            if (pendingTimer != null) return;
            var elapsed = nowFn() - lastSentAt;
            var delay = Math.max(0, throttleMs - elapsed);
            pendingTimer = setTimeoutFn(function () {
                pendingTimer = null;
                if (pendingPayload == null) return;
                var payload = pendingPayload;
                pendingPayload = null;
                doSend(payload);
            }, delay);
        }

        return {
            submit: function submit(payload) {
                pendingPayload = payload;
                var elapsed = nowFn() - lastSentAt;
                if (!inFlight && elapsed >= throttleMs) {
                    pendingPayload = null;
                    return doSend(payload);
                }
                scheduleTrailing();
                return new Promise(function (resolve) {
                    flightQueue.push(resolve);
                });
            },
            flush: function flush() {
                if (pendingTimer != null) {
                    clearTimeoutFn(pendingTimer);
                    pendingTimer = null;
                }
                if (pendingPayload == null) return Promise.resolve(false);
                var payload = pendingPayload;
                pendingPayload = null;
                return doSend(payload).then(function () { return true; });
            },
            cancel: function cancel() {
                if (pendingTimer != null) {
                    clearTimeoutFn(pendingTimer);
                    pendingTimer = null;
                }
                pendingPayload = null;
                drainQueue(false);
            },
            hasPending: function hasPending() {
                return pendingPayload != null;
            }
        };
    }

    function shouldStartLobby(state) {
        if (!state || !state.isHost || state.isPlaying || !state.isReady) return false;
        const readyPlayers = (state.players || []).filter(function (player) {
            return player && !player.isDisconnected;
        });
        return readyPlayers.length > 0 && readyPlayers.every(function (player) {
            return player.isReady;
        });
    }

    function shouldPersistPlayingSession(state) {
        return !!(state && state.countdownVisible && !state.lobbyVisible);
    }

    function shouldRestartCountdown(state) {
        if (!state) return true;
        if (state.incomingRound != null && state.currentRound != null
            && Number(state.incomingRound) < Number(state.currentRound)) {
            return false;
        }
        if (state.incomingStartId != null && state.appliedStartId != null
            && state.incomingStartId === state.appliedStartId) {
            return false;
        }
        if ((state.countdownRunning || state.roundClockRunning) && state.sameBoard) {
            return false;
        }
        if (state.roundSubmitted && state.sameBoard) {
            if (state.incomingStartId != null && state.incomingStartId !== state.appliedStartId) {
                return true;
            }
            return false;
        }
        return true;
    }

    function createHostElectionGrace(options) {
        var opts = options || {};
        var graceMs = opts.graceMs == null ? DEFAULT_HOST_ELECTION_GRACE_MS : opts.graceMs;
        var setTimeoutFn = opts.setTimeout || setTimeout;
        var clearTimeoutFn = opts.clearTimeout || clearTimeout;
        var onElect = opts.onElect || function () {};

        var pendingTimer = null;
        var lastSeenHostId = null;

        function clearPending() {
            if (pendingTimer != null) {
                clearTimeoutFn(pendingTimer);
                pendingTimer = null;
            }
        }

        return {
            handlePresenceChange: function handlePresenceChange(hasLiveHost, myId, electedId) {
                if (hasLiveHost) {
                    clearPending();
                    return;
                }
                if (electedId !== myId) {
                    clearPending();
                    return;
                }
                if (pendingTimer != null) return;
                pendingTimer = setTimeoutFn(function () {
                    pendingTimer = null;
                    onElect();
                }, graceMs);
            },
            hostReturned: function hostReturned() {
                clearPending();
            },
            reset: function reset() {
                clearPending();
            },
            isPending: function isPending() {
                return pendingTimer != null;
            }
        };
    }

    return {
        createLatest: createLatest,
        createThrottled: createThrottled,
        createHostElectionGrace: createHostElectionGrace,
        DEFAULT_THROTTLE_MS: DEFAULT_THROTTLE_MS,
        DEFAULT_HOST_ELECTION_GRACE_MS: DEFAULT_HOST_ELECTION_GRACE_MS,
        shouldStartLobby: shouldStartLobby,
        shouldPersistPlayingSession: shouldPersistPlayingSession,
        shouldRestartCountdown: shouldRestartCountdown
    };
}));
