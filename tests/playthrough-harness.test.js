'use strict';

const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try {
    ({ JSDOM } = require('jsdom'));
} catch (err) {
    JSDOM = null;
}

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SCRIPTS = [
    'public/connection-recovery.js',
    'public/integrity.js',
    'public/round-sync.js',
    'public/presence-sync.js',
    'public/script.js'
].map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'));

function dictionaryText() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const words = [];
    for (const a of alphabet) {
        for (const b of alphabet) {
            for (const c of alphabet) {
                for (const d of alphabet) words.push(a + b + c + d);
            }
        }
    }
    return words.join('\n');
}

const DICTIONARY = dictionaryText();

function createBus() {
    const rooms = new Map();
    let delayMs = 0;

    function roomFor(name) {
        let room = rooms.get(name);
        if (!room) {
            room = { presence: new Map(), channels: new Set() };
            rooms.set(name, room);
        }
        return room;
    }

    return {
        setDelay(ms) { delayMs = ms; },
        channel(name, options, win) {
            const room = roomFor(name);
            const key = (options && options.config && options.config.presence && options.config.presence.key)
                || ('anon-' + Math.random().toString(36).slice(2));
            const presenceHandlers = [];
            const broadcastHandlers = {};
            const view = new Map();

            function emit() {
                view.clear();
                for (const [id, payload] of room.presence) view.set(id, payload);
                presenceHandlers.forEach((fn) => fn());
            }

            function scheduleSync() {
                const wait = delayMs;
                for (const other of room.channels) {
                    other.win.setTimeout(() => other.emit(), wait);
                }
            }

            const channel = {
                on(type, filter, cb) {
                    if (type === 'presence') presenceHandlers.push(cb);
                    else if (type === 'broadcast' && filter && filter.event) broadcastHandlers[filter.event] = cb;
                    return channel;
                },
                track(payload) {
                    room.presence.set(key, payload);
                    entry.lastPayload = payload;
                    scheduleSync();
                    return Promise.resolve('ok');
                },
                send(args) {
                    const event = args && args.event;
                    const payload = args && args.payload;
                    for (const other of room.channels) {
                        const fn = other.broadcastHandlers[event];
                        if (!fn) continue;
                        other.win.setTimeout(() => fn({ payload }), 0);
                    }
                    return Promise.resolve('ok');
                },
                subscribe(cb) {
                    room.channels.add(entry);
                    win.setTimeout(() => {
                        if (typeof cb === 'function') cb('SUBSCRIBED');
                        scheduleSync();
                    }, 0);
                    return channel;
                },
                unsubscribe() {
                    room.channels.delete(entry);
                    room.presence.delete(key);
                    scheduleSync();
                    return Promise.resolve('ok');
                },
                presenceState() {
                    const state = {};
                    for (const [id, payload] of view) state[id] = [payload];
                    return state;
                }
            };

            const entry = { win, emit, broadcastHandlers, key };
            return channel;
        },
        disconnectWhere(roomCode, pred) {
            const room = rooms.get('room:' + roomCode);
            if (!room) throw new Error('no room ' + roomCode);
            for (const entry of [...room.channels]) {
                if (!entry.lastPayload || !pred(entry.lastPayload)) continue;
                room.channels.delete(entry);
                room.presence.delete(entry.key);
            }
            for (const entry of room.channels) entry.win.setTimeout(() => entry.emit(), 0);
        }
    };
}

function installClock(window) {
    let now = 0;
    let seq = 1;
    const timers = [];
    function add(fn, ms, interval) {
        const id = seq++;
        const every = Number(ms) || 0;
        timers.push({ id, fn, at: now + every, interval, every });
        return id;
    }
    window.setTimeout = (fn, ms) => add(fn, ms, false);
    window.setInterval = (fn, ms) => add(fn, ms, true);
    window.clearTimeout = window.clearInterval = (id) => {
        const timer = timers.find((item) => item.id === id);
        if (timer) timer.dead = true;
    };
    window.requestAnimationFrame = (fn) => window.setTimeout(() => fn(now), 16);
    window.cancelAnimationFrame = window.clearTimeout;
    window.__flush = (ms) => {
        const end = now + ms;
        let guard = 0;
        while (guard++ < 100000) {
            const pending = timers.filter((timer) => !timer.dead && timer.at <= end);
            if (!pending.length) break;
            pending.sort((a, b) => a.at - b.at);
            const next = pending[0];
            now = next.at;
            if (next.interval) next.at = now + next.every;
            else next.dead = true;
            next.fn();
        }
        now = end;
    };
}

function installPage(window, bus) {
    installClock(window);
    window.matchMedia = (query) => ({
        matches: String(query).includes('reduce'),
        media: query,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {}
    });
    window.fetch = async (url) => {
        const target = String(url);
        if (target.includes('unsorted.txt')) {
            return { ok: true, text: async () => DICTIONARY, clone() { return this; } };
        }
        return { ok: false, text: async () => '', json: async () => ({}) };
    };
    window.supabase = {
        createClient() {
            return {
                channel(name, options) {
                    return bus.channel(name, options, window);
                }
            };
        }
    };
    const errors = [];
    window.addEventListener('error', (event) => {
        errors.push(event.message || String(event.error));
    });
    window.__errors = errors;
    for (const source of SCRIPTS) {
        const script = window.document.createElement('script');
        script.textContent = source;
        window.document.body.appendChild(script);
    }
}

function bootDom(bus) {
    const dom = new JSDOM(HTML, {
        url: 'http://localhost/index.html',
        runScripts: 'dangerously',
        pretendToBeVisual: true
    });
    installPage(dom.window, bus);
    return dom;
}

async function pump(windows, ms) {
    const step = 50;
    let left = ms;
    while (left > 0) {
        const slice = Math.min(step, left);
        for (const win of windows) win.__flush(slice);
        left -= slice;
        for (let i = 0; i < 30; i++) await Promise.resolve();
    }
}

function active(win, id) {
    const el = win.document.getElementById(id);
    return !!(el && el.classList.contains('active'));
}

function text(win, id) {
    const el = win.document.getElementById(id);
    return el ? el.textContent.trim() : '';
}

async function waitFor(windows, predicate, ms, label) {
    let waited = 0;
    while (waited < ms) {
        await pump(windows, 50);
        waited += 50;
        if (predicate()) return;
    }
    throw new Error('timed out waiting for ' + label);
}

function assert(condition, message) {
    if (!condition) {
        const error = new Error(message);
        error.failure = message;
        throw error;
    }
}

async function playRound(windows, host, guest) {
    const guestReady = guest.document.getElementById('btn-ready-up');
    const hostReady = host.document.getElementById('btn-ready-up');
    const guestNext = guest.document.getElementById('btn-standings-ready');
    const hostNext = host.document.getElementById('btn-standings-ready');
    const useNext = active(host, 'screen-standings') || active(host, 'screen-results');
    (useNext ? guestNext : guestReady).click();
    await pump(windows, 200);
    (useNext ? hostNext : hostReady).click();
    await pump(windows, 6000);

    function wordFrom(win, start) {
        const tiles = [...win.document.querySelectorAll('.tile')].map((tile) => tile.textContent.trim());
        return tiles.slice(start, start + 4).join('');
    }
    const hostWord = wordFrom(host, 0);
    const guestWord = wordFrom(guest, 4);
    assert(hostWord.length === 4 && guestWord.length === 4 && hostWord !== guestWord, 'board did not yield two different words: ' + hostWord + ' / ' + guestWord);

    for (const [win, word] of [[host, hostWord], [guest, guestWord]]) {
        const input = win.document.getElementById('word-input');
        const form = win.document.getElementById('word-form');
        input.value = word;
        form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    }
    await pump(windows, 200);
    host.document.getElementById('submit-round').click();
    guest.document.getElementById('submit-round').click();
    await pump(windows, 400);
    return { hostWord, guestWord };
}

async function main() {
    const failures = [];
    const bus = createBus();
    const hostDom = bootDom(bus);
    const guestDom = bootDom(bus);
    const host = hostDom.window;
    const guest = guestDom.window;
    const windows = [host, guest];

    try {
        await waitFor(windows, () => !host.document.getElementById('multiplayer-controls').classList.contains('hidden'), 2000, 'dictionary boot');

        host.document.getElementById('input-player-name').value = 'Ada';
        host.document.getElementById('btn-create-room').click();
        await waitFor(windows, () => active(host, 'screen-lobby'), 2000, 'host lobby');
        const code = text(host, 'display-room-code');
        assert(/^[A-Z]{4}$/.test(code), 'host lobby did not show a 4 letter room code, saw ' + JSON.stringify(code));

        guest.document.getElementById('input-player-name').value = 'Bea';
        guest.document.getElementById('input-room-code').value = code;
        guest.document.getElementById('btn-join-room').click();
        await waitFor(windows, () => active(guest, 'screen-lobby'), 2000, 'guest lobby');
        await waitFor(windows, () => text(host, 'lobby-player-list').includes('Bea'), 2000, 'host sees Bea');
        assert(text(guest, 'lobby-player-list').includes('Ada'), 'guest lobby does not show Ada');
        console.log('PASS immediate join', code);

        const { hostWord, guestWord } = await playRound(windows, host, guest);
        await waitFor(windows, () => active(host, 'screen-results'), 2000, 'round 1 results');
        const round1 = text(host, 'total-score-display');
        assert(round1 === 'Total: 4 pts', 'round 1 host total, saw ' + JSON.stringify(round1) + ' for ' + hostWord);
        host.document.getElementById('btn-next-round').click();
        await pump(windows, 200);
        const standings1 = text(host, 'standings-list');
        assert(standings1.includes('4'), 'round 1 standings missing 4, saw ' + standings1);
        await pump(windows, 500);
        const standingsAfterPresence = text(host, 'standings-list');
        assert(standingsAfterPresence === standings1, 'standings changed after presence:\n' + standings1 + '\n---\n' + standingsAfterPresence);

        await playRound(windows, host, guest);
        await waitFor(windows, () => active(host, 'screen-results'), 2000, 'round 2 results');
        const round2 = text(host, 'total-score-display');
        assert(round2 === 'Total: 8 pts', 'round 2 host total, saw ' + JSON.stringify(round2) + ' after ' + hostWord + ' then next word; guest ' + guestWord);
        console.log('PASS two round scores', round1, '->', round2);
    } catch (error) {
        failures.push(error.failure || error.stack || String(error));
        console.error('FAIL happy play', failures[failures.length - 1]);
        console.error('host errors', host.__errors);
        console.error('guest errors', guest.__errors);
        console.error('host screen', ['screen-boot', 'screen-lobby', 'screen-countdown', 'screen-results', 'screen-standings'].filter((id) => active(host, id)).join(','));
        console.error('guest screen', ['screen-boot', 'screen-lobby', 'screen-countdown', 'screen-results', 'screen-standings'].filter((id) => active(guest, id)).join(','));
        console.error('guest status', text(guest, 'join-error-msg'));
    }

    hostDom.window.close();
    guestDom.window.close();

    const slowBus = createBus();
    slowBus.setDelay(0);
    const slowHostDom = bootDom(slowBus);
    const slowGuestDom = bootDom(slowBus);
    const slowHost = slowHostDom.window;
    const slowGuest = slowGuestDom.window;
    const slowWindows = [slowHost, slowGuest];
    try {
        await waitFor(slowWindows, () => !slowHost.document.getElementById('multiplayer-controls').classList.contains('hidden'), 2000, 'slow dictionary boot');
        slowHost.document.getElementById('input-player-name').value = 'Ada';
        slowHost.document.getElementById('btn-create-room').click();
        await waitFor(slowWindows, () => active(slowHost, 'screen-lobby'), 2000, 'slow host lobby');
        const slowCode = text(slowHost, 'display-room-code');
        slowBus.setDelay(4000);
        slowGuest.document.getElementById('input-player-name').value = 'Bea';
        slowGuest.document.getElementById('input-room-code').value = slowCode;
        slowGuest.document.getElementById('btn-join-room').click();
        await pump(slowWindows, 5000);
        const guestLobby = active(slowGuest, 'screen-lobby');
        const guestStatus = text(slowGuest, 'join-error-msg');
        assert(guestLobby && !/No room with that code/.test(guestStatus), 'guest missed a live room when presence took 4s. lobby=' + guestLobby + ' status=' + JSON.stringify(guestStatus));
        console.log('PASS slow presence join');

        const missingDom = bootDom(slowBus);
        const missing = missingDom.window;
        slowBus.setDelay(0);
        await waitFor([missing], () => !missing.document.getElementById('multiplayer-controls').classList.contains('hidden'), 2000, 'missing-room boot');
        missing.document.getElementById('input-player-name').value = 'Cy';
        missing.document.getElementById('input-room-code').value = 'ZZZZ';
        missing.document.getElementById('btn-join-room').click();
        await pump([missing], 14900);
        assert(!/No room with that code/.test(text(missing, 'join-error-msg')), 'a missing room was rejected before the grace window');
        await pump([missing], 200);
        assert(active(missing, 'screen-boot') && /No room with that code/.test(text(missing, 'join-error-msg')), 'a missing room stayed open, status=' + JSON.stringify(text(missing, 'join-error-msg')));
        console.log('PASS missing room still rejected');
        missingDom.window.close();
    } catch (error) {
        failures.push(error.failure || error.message || String(error));
        console.error('FAIL slow join', failures[failures.length - 1]);
        console.error('slow guest status', text(slowGuest, 'join-error-msg'));
        console.error('slow guest screen', ['screen-boot', 'screen-lobby'].filter((id) => active(slowGuest, id)).join(','));
    }
    slowHostDom.window.close();
    slowGuestDom.window.close();

    if (failures.length) {
        throw new Error(failures.join('\n'));
    }
}

async function bootPair(bus) {
    const hostDom = bootDom(bus);
    const guestDom = bootDom(bus);
    const host = hostDom.window;
    const guest = guestDom.window;
    const windows = [host, guest];
    await waitFor(windows, () => !host.document.getElementById('multiplayer-controls').classList.contains('hidden'), 2000, 'dictionary boot');
    host.document.getElementById('input-player-name').value = 'Ada';
    host.document.getElementById('btn-create-room').click();
    await waitFor(windows, () => active(host, 'screen-lobby'), 2000, 'host lobby');
    const code = text(host, 'display-room-code');
    guest.document.getElementById('input-player-name').value = 'Bea';
    guest.document.getElementById('input-room-code').value = code;
    guest.document.getElementById('btn-join-room').click();
    await waitFor(windows, () => active(guest, 'screen-lobby') && text(host, 'lobby-player-list').includes('Bea'), 2000, 'guest in lobby');
    return { hostDom, guestDom, host, guest, windows, code };
}

function submitWord(win, word) {
    const input = win.document.getElementById('word-input');
    const form = win.document.getElementById('word-form');
    input.value = word;
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
}

async function hostLeavesAfterAScoredRound() {
    const bus = createBus();
    const room = await bootPair(bus);
    try {
        await playRound(room.windows, room.host, room.guest);
        await waitFor(room.windows, () => active(room.host, 'screen-results'), 2000, 'round 1 results');
        const hostTotal = text(room.host, 'total-score-display');
        const guestTotal = text(room.guest, 'total-score-display');
        assert(hostTotal === 'Total: 4 pts' && guestTotal === 'Total: 4 pts', 'round 1 totals host=' + hostTotal + ' guest=' + guestTotal);

        bus.disconnectWhere(room.code, (payload) => payload.isHost);
        await pump(room.windows, 800);
        const afterDrop = text(room.guest, 'total-score-display');
        const afterTitle = text(room.guest, 'results-title');
        const afterRound = text(room.guest, 'nav-round-display');
        assert(afterDrop === 'Total: 4 pts', 'guest total changed when the host dropped, saw ' + JSON.stringify(afterDrop) + ' title=' + afterTitle + ' round=' + afterRound);
        assert(afterTitle === 'Round 1 Results', 'dropping the host changed the round, title=' + JSON.stringify(afterTitle) + ' round=' + afterRound);

        room.guest.document.getElementById('btn-standings-ready').click();
        await pump(room.windows, 6000);
        const tiles = [...room.guest.document.querySelectorAll('.tile')].map((tile) => tile.textContent.trim());
        const word = tiles.slice(0, 4).join('');
        submitWord(room.guest, word);
        await pump(room.windows, 200);
        room.guest.document.getElementById('submit-round').click();
        await pump(room.windows, 800);
        const round2 = text(room.guest, 'total-score-display');
        const roundLabel = text(room.guest, 'results-title');
        assert(round2 === 'Total: 8 pts', 'after the host dropped, the next round showed ' + JSON.stringify(round2) + ' (' + roundLabel + ') for ' + word);
        console.log('PASS score survives host drop', round2, roundLabel);
    } finally {
        room.hostDom.window.close();
        room.guestDom.window.close();
    }
}

test('a slow host presence still joins, and round points carry', { skip: JSDOM ? false : 'jsdom is not installed' }, async () => {
    await main();
});

async function lockedWordSurvivesMidRoundHostDrop() {
    const bus = createBus();
    const room = await bootPair(bus);
    try {
        room.guest.document.getElementById('btn-ready-up').click();
        await pump(room.windows, 200);
        room.host.document.getElementById('btn-ready-up').click();
        await pump(room.windows, 6000);
        const tiles = [...room.guest.document.querySelectorAll('.tile')].map((tile) => tile.textContent.trim());
        const word = tiles.slice(0, 4).join('');
        submitWord(room.guest, word);
        await pump(room.windows, 100);
        room.guest.document.getElementById('submit-round').click();
        await pump(room.windows, 200);
        assert(!active(room.guest, 'screen-results'), 'the round scored before the host locked in');

        bus.disconnectWhere(room.code, (payload) => payload.isHost);
        await pump(room.windows, 800);
        const total = text(room.guest, 'total-score-display');
        assert(total === 'Total: 4 pts', 'a locked word was dropped with the host, saw ' + JSON.stringify(total) + ' for ' + word);
        console.log('PASS locked word survives host drop');
    } finally {
        room.hostDom.window.close();
        room.guestDom.window.close();
    }
}

async function sameNameIsRejected() {
    const bus = createBus();
    const room = await bootPair(bus);
    const twinDom = bootDom(bus);
    const twin = twinDom.window;
    try {
        await waitFor([twin], () => !twin.document.getElementById('multiplayer-controls').classList.contains('hidden'), 2000, 'twin boot');
        twin.document.getElementById('input-player-name').value = 'Bea';
        twin.document.getElementById('input-room-code').value = room.code;
        twin.document.getElementById('btn-join-room').click();
        await pump([twin, ...room.windows], 1000);
        const status = text(twin, 'join-error-msg');
        const roster = text(room.host, 'lobby-player-list');
        assert(/already taken/i.test(status), 'a second Bea joined, status=' + JSON.stringify(status) + ' roster=' + roster);
        assert(roster.split('Bea').length === 2, 'host roster listed two Beas: ' + roster);
        console.log('PASS same name rejected');
    } finally {
        twinDom.window.close();
        room.hostDom.window.close();
        room.guestDom.window.close();
    }
}

test('points survive the host dropping', { skip: JSDOM ? false : 'jsdom is not installed' }, async () => {
    await hostLeavesAfterAScoredRound();
});

test('a locked word still scores if the host drops first', { skip: JSDOM ? false : 'jsdom is not installed' }, async () => {
    await lockedWordSurvivesMidRoundHostDrop();
});

test('a second player cannot take a name already in the room', { skip: JSDOM ? false : 'jsdom is not installed' }, async () => {
    await sameNameIsRejected();
});
