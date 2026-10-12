(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.WordperfectRoundSync = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    // A second connection dialog fires after the timer is already cleared.
    // That call must not erase a pause the first dialog already took.
    function keepPauseFlag(timerIsRunning, alreadyPaused) {
        return alreadyPaused || timerIsRunning;
    }

    // Rebuild the board only when a playing client is still covered by boot or lobby.
    // A live round, or a results screen, stays as it is.
    function shouldRebuildRound(isPlaying, roundSubmitted, bootActive, lobbyActive, resultsActive) {
        if (roundSubmitted || resultsActive || !isPlaying) return false;
        return bootActive || lobbyActive;
    }

    // A guest who already locked this round in must not be pulled back onto the board.
    function shouldEnterRoundFromSync(isPlaying, roundSubmitted) {
        return !isPlaying && !roundSubmitted;
    }

    // A running guest clock is ahead of a host clock that was paused. Do not rewind it.
    function shouldAdoptHostTime(clockPaused, isPlaying) {
        return clockPaused && isPlaying;
    }

    // Takeover may close a round that already ended. A live clock has to finish first.
    // A round that already published results must not be scored a second time.
    function shouldArmTakeoverWatchdog(isPlaying, timeLeft, roundScored) {
        if (roundScored) return false;
        return !isPlaying || timeLeft <= 0;
    }

    // Locked-in words are resent only while the room is still waiting on that round.
    function shouldResubmitDraft(isPlaying, roundScored) {
        return !isPlaying && !roundScored;
    }

    return {
        keepPauseFlag: keepPauseFlag,
        shouldRebuildRound: shouldRebuildRound,
        shouldEnterRoundFromSync: shouldEnterRoundFromSync,
        shouldAdoptHostTime: shouldAdoptHostTime,
        shouldArmTakeoverWatchdog: shouldArmTakeoverWatchdog,
        shouldResubmitDraft: shouldResubmitDraft
    };
}));
