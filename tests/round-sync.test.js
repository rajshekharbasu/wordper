'use strict';

const assert = require('assert');
const sync = require('../public/round-sync.js');

assert.equal(sync.keepPauseFlag(true, false), true, 'stopping a running timer pauses the clock');
assert.equal(sync.keepPauseFlag(false, true), true, 'a second dialog keeps the pause');
assert.equal(sync.keepPauseFlag(false, false), false, 'a dialog with no clock does not pause one');

assert.equal(
    sync.shouldRebuildRound(true, false, true, false, false),
    true,
    'a refresh still on the boot screen rebuilds the round'
);
assert.equal(
    sync.shouldRebuildRound(true, false, false, false, false),
    false,
    'a socket recycle on a visible round does not rebuild it'
);
assert.equal(
    sync.shouldRebuildRound(true, true, true, false, false),
    false,
    'a submitted round is not rebuilt'
);
assert.equal(
    sync.shouldRebuildRound(true, false, false, false, true),
    false,
    'results stay up across a resubscribe'
);

assert.equal(sync.shouldEnterRoundFromSync(false, false), true, 'a guest still in the lobby can enter the live round');
assert.equal(sync.shouldEnterRoundFromSync(false, true), false, 'a guest who already submitted is not sent back in');
assert.equal(sync.shouldEnterRoundFromSync(true, false), false, 'a guest already playing is not re-entered');

assert.equal(sync.shouldAdoptHostTime(true, true), true, 'a paused guest takes the host time');
assert.equal(sync.shouldAdoptHostTime(false, true), false, 'a running guest clock is not rewound');

assert.equal(sync.shouldArmTakeoverWatchdog(false, 40), true, 'takeover after lock-in may score');
assert.equal(sync.shouldArmTakeoverWatchdog(true, 0), true, 'a clock that already hit zero may score');
assert.equal(sync.shouldArmTakeoverWatchdog(true, 25), false, 'a live round is not scored on the takeover timer');

console.log('ok round sync decisions');
