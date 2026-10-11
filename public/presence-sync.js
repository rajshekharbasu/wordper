(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.WordperfectPresenceSync = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
        if (state.sameBoard && (state.countdownRunning || state.roundClockRunning || state.roundSubmitted)) {
            return false;
        }
        return true;
    }

    return {
        createLatest: createLatest,
        shouldStartLobby: shouldStartLobby,
        shouldPersistPlayingSession: shouldPersistPlayingSession,
        shouldRestartCountdown: shouldRestartCountdown
    };
}));
