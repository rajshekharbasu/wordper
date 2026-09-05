(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.WordperfectIntegrity = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * Residual risk: anon public Realtime broadcast cannot cryptographically authenticate
     * senders. Live presence host id + hostGeneration only stop casual spoofing.
     * Determined attackers on the same channel can still forge presence/broadcast fields.
     * Real fix: private channels + signed user auth.
     */

    function getLiveHostPlayer(players) {
        return (players || []).find(function (p) {
            return p && p.isHost && !p.isAi && !p.isDisconnected;
        }) || null;
    }

    function getLiveHostId(players) {
        const host = getLiveHostPlayer(players);
        return host ? host.id : null;
    }

    function getElectedHostId(players) {
        const realPlayers = (players || []).filter(function (p) {
            return p && !p.isAi && !p.isDisconnected;
        });
        if (realPlayers.length === 0) return null;
        return realPlayers
            .map(function (p) { return p.id; })
            .sort(function (a, b) { return String(a).localeCompare(String(b)); })[0];
    }

    /**
     * Soft host auth for public broadcast payloads.
     * - Prefer live presence host (not lastKnownHostId alone).
     * - During failover (no live host), accept only the deterministic election winner.
     * - When the live host publishes hostGeneration, require matching payload.hostGeneration.
     */
    function verifyHostEvent(data, options) {
        const opts = options || {};
        if (!data || data.senderId == null) return false;

        const livePlayers = opts.livePlayers || [];
        const liveHost = getLiveHostPlayer(livePlayers);
        const liveHostId = liveHost ? liveHost.id : null;

        if (liveHostId) {
            if (data.senderId !== liveHostId) return false;
            if (liveHost.hostGeneration != null) {
                if (data.hostGeneration == null) return false;
                if (Number(data.hostGeneration) !== Number(liveHost.hostGeneration)) return false;
            } else if (opts.expectedHostGeneration != null) {
                if (data.hostGeneration == null) return false;
                if (Number(data.hostGeneration) !== Number(opts.expectedHostGeneration)) return false;
            }
            return true;
        }

        // No lastKnownHostId fallback — that widened the spoof window after the host left.
        const electedId = opts.electedHostId != null
            ? opts.electedHostId
            : getElectedHostId(livePlayers);
        if (!electedId || data.senderId !== electedId) return false;

        if (opts.expectedHostGeneration != null && data.hostGeneration != null) {
            // New host must bump generation; reject stale/old-host payloads.
            if (Number(data.hostGeneration) < Number(opts.expectedHostGeneration)) return false;
        }
        return true;
    }

    function createScoreLedger(players) {
        const ledger = Object.create(null);
        (players || []).forEach(function (p) {
            if (!p || p.id == null) return;
            ledger[p.id] = { score: 0, totalWords: 0 };
        });
        return ledger;
    }

    function ensureScoreLedger(ledger, players) {
        const next = ledger && typeof ledger === 'object' ? ledger : Object.create(null);
        (players || []).forEach(function (p) {
            if (!p || p.id == null) return;
            if (!next[p.id]) next[p.id] = { score: 0, totalWords: 0 };
        });
        return next;
    }

    function applyUniqueWordToLedger(ledger, playerId, points) {
        if (!ledger[playerId]) ledger[playerId] = { score: 0, totalWords: 0 };
        ledger[playerId].score += Number(points) || 0;
        ledger[playerId].totalWords += 1;
        return ledger[playerId];
    }

    function overlayLedgerScores(players, ledger) {
        return (players || []).map(function (p) {
            const entry = ledger && ledger[p.id];
            if (!entry) {
                return Object.assign({}, p, { score: 0, totalWords: 0 });
            }
            return Object.assign({}, p, {
                score: entry.score,
                totalWords: entry.totalWords
            });
        });
    }

    /**
     * Accept submit_words only for ids currently in live presence (or reclaim seats).
     * firstWriteWins blocks later overwrites (incl. some spoof races).
     */
    function canAcceptWordSubmission(playerId, options) {
        const opts = options || {};
        if (playerId == null || playerId === '') return false;

        if (opts.firstWriteWins && opts.existingSubmissionIds) {
            const existing = opts.existingSubmissionIds;
            const has = typeof existing.has === 'function'
                ? existing.has(playerId)
                : Object.prototype.hasOwnProperty.call(existing, playerId);
            if (has) return false;
        }

        const liveOk = (opts.livePlayers || []).some(function (p) {
            return p
                && p.id === playerId
                && !p.isAi
                && !p.isDisconnected
                && !p.isPendingJoin;
        });
        if (liveOk) return true;

        const seats = opts.disconnectedSeatIds || [];
        if (typeof seats.has === 'function') return seats.has(playerId);
        return seats.indexOf(playerId) !== -1;
    }

    return {
        getLiveHostId: getLiveHostId,
        getLiveHostPlayer: getLiveHostPlayer,
        getElectedHostId: getElectedHostId,
        verifyHostEvent: verifyHostEvent,
        createScoreLedger: createScoreLedger,
        ensureScoreLedger: ensureScoreLedger,
        applyUniqueWordToLedger: applyUniqueWordToLedger,
        overlayLedgerScores: overlayLedgerScores,
        canAcceptWordSubmission: canAcceptWordSubmission
    };
}));
