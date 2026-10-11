'use strict';

const assert = require('assert');
const sync = require('../public/presence-sync.js');

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('latest lobby settings win when older presence writes are still in flight', async () => {
    const landed = [];
    const pending = [];
    const send = sync.createLatest((payload) => {
        landed.push(payload);
        return new Promise((resolve) => pending.push(resolve));
    });

    const latest = { rounds: 5, mode: 'scrabble', timer: 30, ready: true };
    const first = send({ rounds: 3, mode: 'classic', ready: true });
    const second = send({ rounds: 5, mode: 'scrabble', ready: false });
    const third = send(latest);

    for (let i = 0; i < 20 && landed.length === 0; i += 1) {
        await Promise.resolve();
    }
    assert.deepStrictEqual(landed, [latest]);
    pending[0]();
    await first;
    await second;
    await third;
    assert.deepStrictEqual(landed, [latest]);
});

test('a presence write that already started still cannot finish after a newer one', async () => {
    const landed = [];
    let releaseFirst;
    const send = sync.createLatest((payload) => {
        if (!releaseFirst) {
            return new Promise((resolve) => {
                releaseFirst = () => {
                    landed.push(payload);
                    resolve();
                };
            });
        }
        landed.push(payload);
        return Promise.resolve();
    });

    const first = send({ rounds: 3, ready: true });
    await Promise.resolve();
    const second = send({ rounds: 8, mode: 'scrabble', ready: true });
    releaseFirst();
    await first;
    await second;

    assert.deepStrictEqual(landed, [
        { rounds: 3, ready: true },
        { rounds: 8, mode: 'scrabble', ready: true }
    ]);
});

test('host does not start from a stale ready echo after a local settings change', () => {
    const players = [
        { id: 'host', isReady: true, isDisconnected: false },
        { id: 'bot', isReady: true, isAi: true, isDisconnected: false }
    ];
    assert.equal(sync.shouldStartLobby({
        isHost: true,
        isPlaying: false,
        isReady: false,
        players
    }), false);
    assert.equal(sync.shouldStartLobby({
        isHost: true,
        isPlaying: false,
        isReady: true,
        players
    }), true);
    assert.equal(sync.shouldStartLobby({
        isHost: true,
        isPlaying: false,
        isReady: true,
        players: players.concat([{ id: 'guest', isReady: false, isDisconnected: false }])
    }), false);
});

test('playing session is saved only after the lobby is gone and the countdown is up', () => {
    assert.equal(sync.shouldPersistPlayingSession({
        lobbyVisible: true,
        countdownVisible: false
    }), false);
    assert.equal(sync.shouldPersistPlayingSession({
        lobbyVisible: false,
        countdownVisible: true
    }), true);
});

test('host countdown does not restart when the same board is announced back', () => {
    assert.equal(sync.shouldRestartCountdown({
        countdownRunning: true,
        sameBoard: true
    }), false);
    assert.equal(sync.shouldRestartCountdown({
        countdownRunning: false,
        sameBoard: true
    }), true);
    assert.equal(sync.shouldRestartCountdown({
        countdownRunning: true,
        sameBoard: false
    }), true);
});

test('a live or finished round does not restart when the same board is announced again', () => {
    assert.equal(sync.shouldRestartCountdown({
        countdownRunning: false,
        roundClockRunning: true,
        sameBoard: true,
        incomingRound: 1,
        currentRound: 1
    }), false);
    assert.equal(sync.shouldRestartCountdown({
        countdownRunning: false,
        roundClockRunning: false,
        roundSubmitted: true,
        sameBoard: true,
        incomingRound: 1,
        currentRound: 1
    }), false);
    assert.equal(sync.shouldRestartCountdown({
        countdownRunning: false,
        roundClockRunning: false,
        roundSubmitted: true,
        sameBoard: false,
        incomingRound: 2,
        currentRound: 2
    }), true);
    assert.equal(sync.shouldRestartCountdown({
        countdownRunning: false,
        roundClockRunning: true,
        sameBoard: false,
        incomingRound: 1,
        currentRound: 2
    }), false);
});

(async function main() {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log('ok -', t.name);
        } catch (err) {
            failed += 1;
            console.error('FAIL -', t.name);
            console.error(err && err.stack ? err.stack : err);
        }
    }
    console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
