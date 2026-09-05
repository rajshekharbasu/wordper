'use strict';

const assert = require('assert');
const { createConnectionRecovery } = require('../public/connection-recovery.js');

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

function setup(overrides = {}) {
    const clock = createFakeClock();
    let hidden = false;
    const lost = [];
    const recovered = [];
    const recovery = createConnectionRecovery({
        graceMs: 3000,
        visibleRetryMs: 1500,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        isHidden: () => hidden,
        onLost: () => lost.push(clock.now()),
        onRecovered: () => recovered.push(clock.now()),
        ...overrides
    });
    return { clock, recovery, lost, recovered, setHidden: (value) => { hidden = value; } };
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('a brief CHANNEL_ERROR after join does not show CONNECTION LOST if SUBSCRIBED returns within the grace window', () => {
    const { clock, recovery, lost } = setup();
    recovery.handleStatus('SUBSCRIBED');
    recovery.handleStatus('CHANNEL_ERROR');
    clock.advance(2999);
    assert.deepStrictEqual(lost, []);
    recovery.handleStatus('SUBSCRIBED');
    clock.advance(5000);
    assert.deepStrictEqual(lost, []);
});

test('CHANNEL_ERROR that lasts past the grace window shows CONNECTION LOST once', () => {
    const { clock, recovery, lost } = setup();
    recovery.handleStatus('SUBSCRIBED');
    recovery.handleStatus('CHANNEL_ERROR');
    recovery.handleStatus('TIMED_OUT');
    recovery.handleStatus('CLOSED');
    clock.advance(3000);
    assert.deepStrictEqual(lost, [3000]);
    recovery.handleStatus('CHANNEL_ERROR');
    clock.advance(3000);
    assert.deepStrictEqual(lost, [3000]);
});

test('intentional channel teardown never shows CONNECTION LOST', () => {
    const { clock, recovery, lost } = setup();
    recovery.handleStatus('SUBSCRIBED');
    recovery.handleStatus('CHANNEL_ERROR', { intentionalClose: true });
    recovery.handleStatus('CLOSED', { intentionalClose: true });
    clock.advance(10000);
    assert.deepStrictEqual(lost, []);
});

test('CHANNEL_ERROR before the first successful join is not a connection-lost overlay', () => {
    const { clock, recovery, lost } = setup();
    recovery.handleStatus('CHANNEL_ERROR');
    recovery.handleStatus('TIMED_OUT');
    clock.advance(10000);
    assert.deepStrictEqual(lost, []);
});

test('a mid-game refresh that never subscribes can still show CONNECTION LOST after grace', () => {
    const { clock, recovery, lost } = setup();
    recovery.handleStatus('CHANNEL_ERROR', { allowBeforeJoin: true });
    clock.advance(3000);
    assert.deepStrictEqual(lost, [3000]);
});

test('a drop while the tab is hidden waits until the tab is visible and a reconnect window misses', () => {
    const { clock, recovery, lost, setHidden } = setup();
    recovery.handleStatus('SUBSCRIBED');
    setHidden(true);
    recovery.handleStatus('CHANNEL_ERROR');
    clock.advance(3000);
    assert.deepStrictEqual(lost, []);
    setHidden(false);
    recovery.handleVisibility();
    clock.advance(1499);
    assert.deepStrictEqual(lost, []);
    clock.advance(1);
    assert.deepStrictEqual(lost, [4500]);
});

test('coming back to a hidden tab that already reconnected never shows CONNECTION LOST', () => {
    const { clock, recovery, lost, recovered, setHidden } = setup();
    recovery.handleStatus('SUBSCRIBED');
    setHidden(true);
    recovery.handleStatus('CHANNEL_ERROR');
    clock.advance(3000);
    setHidden(false);
    recovery.handleVisibility();
    recovery.handleStatus('SUBSCRIBED');
    clock.advance(5000);
    assert.deepStrictEqual(lost, []);
    assert.deepStrictEqual(recovered, []);
});

test('SUBSCRIBED after an overlay hide recovers exactly once', () => {
    const { clock, recovery, lost, recovered } = setup();
    recovery.handleStatus('SUBSCRIBED');
    recovery.handleStatus('CHANNEL_ERROR');
    clock.advance(3000);
    recovery.handleStatus('SUBSCRIBED');
    assert.deepStrictEqual(lost, [3000]);
    assert.deepStrictEqual(recovered, [3000]);
    recovery.handleStatus('SUBSCRIBED');
    assert.deepStrictEqual(recovered, [3000]);
});

test('reset cancels a pending overlay so leaving the room cannot flash CONNECTION LOST', () => {
    const { clock, recovery, lost } = setup();
    recovery.handleStatus('SUBSCRIBED');
    recovery.handleStatus('CHANNEL_ERROR');
    recovery.reset();
    clock.advance(10000);
    assert.deepStrictEqual(lost, []);
});

let failed = 0;
for (const { name, fn } of tests) {
    try {
        fn();
        console.log(`ok  ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`not ok  ${name}`);
        console.error(`  ${error.message}`);
    }
}

if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
}

console.log(`\n${tests.length} passed`);
