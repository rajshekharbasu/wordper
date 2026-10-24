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

test('a new round still starts when it draws the same letters', () => {
    assert.equal(sync.shouldRestartCountdown({
        countdownRunning: false,
        roundClockRunning: false,
        roundSubmitted: true,
        sameBoard: true,
        incomingRound: 2,
        currentRound: 2,
        incomingStartId: 'round-2',
        appliedStartId: 'round-1'
    }), true);
    assert.equal(sync.shouldRestartCountdown({
        countdownRunning: false,
        roundClockRunning: true,
        sameBoard: true,
        incomingRound: 1,
        currentRound: 1,
        incomingStartId: 'round-1',
        appliedStartId: 'round-1'
    }), false);
});

// --- THROTTLED PRESENCE TESTS (BUG 1 FIX) ---

function createFakeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();

    return {
        now: () => now,
        setTimeout(fn, ms) {
            const id = nextId++;
            timers.set(id, { fn, at: now + ms });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        advance(ms) {
            const target = now + ms;
            while (true) {
                let next = null;
                for (const [id, t] of timers) {
                    if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && id < next.id))) {
                        next = { id, fn: t.fn, at: t.at };
                    }
                }
                if (!next) {
                    now = target;
                    return;
                }
                now = next.at;
                timers.delete(next.id);
                next.fn();
            }
        }
    };
}

test('createThrottled limits presence tracks to one per throttle window', async () => {
    const clock = createFakeClock();
    const tracked = [];
    const throttled = sync.createThrottled(
        (payload) => {
            tracked.push({ payload, at: clock.now() });
            return Promise.resolve();
        },
        {
            throttleMs: 1000,
            setTimeout: clock.setTimeout,
            clearTimeout: clock.clearTimeout,
            now: clock.now
        }
    );

    throttled.submit({ ready: false, rounds: 3 });
    throttled.submit({ ready: false, rounds: 5 });
    throttled.submit({ ready: true, rounds: 5 });
    
    await Promise.resolve();
    
    assert.strictEqual(tracked.length, 1, 'only one immediate track should fire');
    assert.deepStrictEqual(tracked[0].payload, { ready: false, rounds: 3 });
    
    clock.advance(1000);
    await Promise.resolve();
    
    assert.strictEqual(tracked.length, 2, 'trailing track should fire after throttle window');
    assert.deepStrictEqual(tracked[1].payload, { ready: true, rounds: 5 });
});

test('createThrottled sends immediately when outside throttle window', async () => {
    const clock = createFakeClock();
    const tracked = [];
    const throttled = sync.createThrottled(
        (payload) => {
            tracked.push({ payload, at: clock.now() });
            return Promise.resolve();
        },
        {
            throttleMs: 1000,
            setTimeout: clock.setTimeout,
            clearTimeout: clock.clearTimeout,
            now: clock.now
        }
    );

    throttled.submit({ rounds: 3 });
    await Promise.resolve();
    assert.strictEqual(tracked.length, 1);
    
    clock.advance(1500);
    
    throttled.submit({ rounds: 5 });
    await Promise.resolve();
    assert.strictEqual(tracked.length, 2, 'should send immediately after throttle window');
    assert.strictEqual(tracked[1].at, 1500);
});

test('createThrottled flush sends pending payload immediately', async () => {
    const clock = createFakeClock();
    const tracked = [];
    const throttled = sync.createThrottled(
        (payload) => {
            tracked.push({ payload, at: clock.now() });
            return Promise.resolve();
        },
        {
            throttleMs: 1000,
            setTimeout: clock.setTimeout,
            clearTimeout: clock.clearTimeout,
            now: clock.now
        }
    );

    throttled.submit({ rounds: 3 });
    await Promise.resolve();
    throttled.submit({ rounds: 5, urgent: true });
    
    assert.strictEqual(tracked.length, 1);
    assert.strictEqual(throttled.hasPending(), true);
    
    await throttled.flush();
    
    assert.strictEqual(tracked.length, 2, 'flush should send pending payload');
    assert.deepStrictEqual(tracked[1].payload, { rounds: 5, urgent: true });
    assert.strictEqual(throttled.hasPending(), false);
});

test('createThrottled cancel discards pending without sending', async () => {
    const clock = createFakeClock();
    const tracked = [];
    const throttled = sync.createThrottled(
        (payload) => {
            tracked.push(payload);
            return Promise.resolve();
        },
        {
            throttleMs: 1000,
            setTimeout: clock.setTimeout,
            clearTimeout: clock.clearTimeout,
            now: clock.now
        }
    );

    throttled.submit({ rounds: 3 });
    await Promise.resolve();
    throttled.submit({ rounds: 5 });
    throttled.cancel();
    
    clock.advance(2000);
    await Promise.resolve();
    
    assert.strictEqual(tracked.length, 1, 'cancel should prevent pending track');
});

// --- HOST ELECTION GRACE PERIOD TESTS (BUG 2 FIX) ---

test('createHostElectionGrace waits before electing new host', () => {
    const clock = createFakeClock();
    let elected = false;
    const grace = sync.createHostElectionGrace({
        graceMs: 3000,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        onElect: () => { elected = true; }
    });

    grace.handlePresenceChange(false, 'me', 'me');
    
    clock.advance(2999);
    assert.strictEqual(elected, false, 'should not elect before grace period');
    
    clock.advance(1);
    assert.strictEqual(elected, true, 'should elect after grace period');
});

test('createHostElectionGrace cancels election if host returns', () => {
    const clock = createFakeClock();
    let elected = false;
    const grace = sync.createHostElectionGrace({
        graceMs: 3000,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        onElect: () => { elected = true; }
    });

    grace.handlePresenceChange(false, 'me', 'me');
    clock.advance(1500);
    
    grace.hostReturned();
    
    clock.advance(5000);
    assert.strictEqual(elected, false, 'host return should cancel pending election');
});

test('createHostElectionGrace does not elect if not the chosen one', () => {
    const clock = createFakeClock();
    let elected = false;
    const grace = sync.createHostElectionGrace({
        graceMs: 3000,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        onElect: () => { elected = true; }
    });

    grace.handlePresenceChange(false, 'me', 'someone-else');
    
    clock.advance(5000);
    assert.strictEqual(elected, false, 'should not elect if not the elected id');
});

test('createHostElectionGrace does not start when host is live', () => {
    const clock = createFakeClock();
    let elected = false;
    const grace = sync.createHostElectionGrace({
        graceMs: 3000,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        onElect: () => { elected = true; }
    });

    grace.handlePresenceChange(true, 'me', 'me');
    
    clock.advance(5000);
    assert.strictEqual(elected, false, 'should not start election when host is live');
    assert.strictEqual(grace.isPending(), false);
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
