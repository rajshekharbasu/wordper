'use strict';

const assert = require('assert');
const integrity = require('../public/integrity.js');

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('verifyHostEvent rejects missing senderId', () => {
    assert.strictEqual(integrity.verifyHostEvent({}, { livePlayers: [{ id: 'h', isHost: true }] }), false);
    assert.strictEqual(integrity.verifyHostEvent(null, { livePlayers: [] }), false);
});

test('verifyHostEvent accepts live presence host with matching generation', () => {
    const players = [
        { id: 'g1', isHost: false },
        { id: 'host1', isHost: true, hostGeneration: 3 }
    ];
    assert.strictEqual(
        integrity.verifyHostEvent({ senderId: 'host1', hostGeneration: 3 }, { livePlayers: players }),
        true
    );
});

test('verifyHostEvent rejects forged senderId even with generation', () => {
    const players = [{ id: 'host1', isHost: true, hostGeneration: 2 }];
    assert.strictEqual(
        integrity.verifyHostEvent({ senderId: 'attacker', hostGeneration: 2 }, { livePlayers: players }),
        false
    );
});

test('verifyHostEvent rejects stale hostGeneration against live host', () => {
    const players = [{ id: 'host1', isHost: true, hostGeneration: 5 }];
    assert.strictEqual(
        integrity.verifyHostEvent({ senderId: 'host1', hostGeneration: 4 }, { livePlayers: players }),
        false
    );
});

test('verifyHostEvent rejects missing hostGeneration once live host publishes one', () => {
    const players = [{ id: 'host1', isHost: true, hostGeneration: 1 }];
    assert.strictEqual(
        integrity.verifyHostEvent({ senderId: 'host1' }, { livePlayers: players }),
        false
    );
});

test('verifyHostEvent does not use lastKnownHostId — only elected id on failover', () => {
    const players = [
        { id: 'a', isHost: false },
        { id: 'b', isHost: false }
    ];
    // elected = lexicographically first = 'a'
    assert.strictEqual(
        integrity.verifyHostEvent(
            { senderId: 'old-host', hostGeneration: 9 },
            { livePlayers: players, electedHostId: 'a', expectedHostGeneration: 9 }
        ),
        false
    );
    assert.strictEqual(
        integrity.verifyHostEvent(
            { senderId: 'a', hostGeneration: 10 },
            { livePlayers: players, electedHostId: 'a', expectedHostGeneration: 9 }
        ),
        true
    );
});

test('verifyHostEvent rejects stale generation during failover', () => {
    const players = [{ id: 'a', isHost: false }, { id: 'b', isHost: false }];
    assert.strictEqual(
        integrity.verifyHostEvent(
            { senderId: 'a', hostGeneration: 2 },
            { livePlayers: players, electedHostId: 'a', expectedHostGeneration: 5 }
        ),
        false
    );
});

test('score ledger ignores forged presence bases', () => {
    const players = [
        { id: 'p1', name: 'Ada', score: 999, totalWords: 50 },
        { id: 'p2', name: 'Bob', score: 0, totalWords: 0 }
    ];
    let ledger = integrity.createScoreLedger(players);
    assert.strictEqual(ledger.p1.score, 0);
    assert.strictEqual(ledger.p2.score, 0);

    let roster = integrity.overlayLedgerScores(players, ledger);
    assert.strictEqual(roster[0].score, 0);

    integrity.applyUniqueWordToLedger(ledger, 'p1', 5);
    integrity.applyUniqueWordToLedger(ledger, 'p1', 3);
    roster = integrity.overlayLedgerScores(players, ledger);
    assert.strictEqual(roster.find(p => p.id === 'p1').score, 8);
    assert.strictEqual(roster.find(p => p.id === 'p1').totalWords, 2);
    // Presence inflation must not leak back in
    assert.notStrictEqual(roster.find(p => p.id === 'p1').score, 999);
});

test('ensureScoreLedger adds newcomers at zero without resetting others', () => {
    const ledger = integrity.createScoreLedger([{ id: 'p1' }]);
    integrity.applyUniqueWordToLedger(ledger, 'p1', 4);
    integrity.ensureScoreLedger(ledger, [{ id: 'p1' }, { id: 'p2' }]);
    assert.strictEqual(ledger.p1.score, 4);
    assert.strictEqual(ledger.p2.score, 0);
});

test('canAcceptWordSubmission requires live non-AI presence', () => {
    const live = [
        { id: 'p1', isAi: false, isDisconnected: false },
        { id: 'bot', isAi: true },
        { id: 'ghost', isDisconnected: true },
        { id: 'pending', isPendingJoin: true }
    ];
    assert.strictEqual(integrity.canAcceptWordSubmission('p1', { livePlayers: live }), true);
    assert.strictEqual(integrity.canAcceptWordSubmission('bot', { livePlayers: live }), false);
    assert.strictEqual(integrity.canAcceptWordSubmission('ghost', { livePlayers: live }), false);
    assert.strictEqual(integrity.canAcceptWordSubmission('pending', { livePlayers: live }), false);
    assert.strictEqual(integrity.canAcceptWordSubmission('invented', { livePlayers: live }), false);
});

test('canAcceptWordSubmission first-write-wins blocks duplicates', () => {
    const live = [{ id: 'p1' }];
    const existing = new Set(['p1']);
    assert.strictEqual(
        integrity.canAcceptWordSubmission('p1', {
            livePlayers: live,
            existingSubmissionIds: existing,
            firstWriteWins: true
        }),
        false
    );
});

test('canAcceptWordSubmission may allow disconnected seat ids when provided', () => {
    assert.strictEqual(
        integrity.canAcceptWordSubmission('seat1', {
            livePlayers: [],
            disconnectedSeatIds: ['seat1']
        }),
        true
    );
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
