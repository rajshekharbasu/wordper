// --- THEME INITIALIZATION & TOGGLE ---
(function() {
    const savedTheme = localStorage.getItem('wordperfect_theme');
    if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.body.classList.add('dark-theme');
    }
})();

document.addEventListener('DOMContentLoaded', () => {
    const themeToggleBtn = document.getElementById('theme-toggle');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const isDark = document.body.classList.toggle('dark-theme');
            localStorage.setItem('wordperfect_theme', isDark ? 'dark' : 'light');
        });
    }
});

// Ripple spinner + countdown digits from flicker-dot (Made with Flicker · flicker.laurie.fyi)
let countdownFlickerMarkup = '';

(function injectFlickerSpinner() {
    const host = document.getElementById('boot-spinner-host');
    fetch('flicker-boot.svg')
        .then((r) => (r.ok ? r.text() : Promise.reject()))
        .then((svg) => {
            if (host) host.innerHTML = svg;
        })
        .catch(() => {
            if (host) host.classList.add('boot-spinner-fallback');
        });

    fetch('flicker-countdown.svg')
        .then((r) => (r.ok ? r.text() : Promise.reject()))
        .then((svg) => { countdownFlickerMarkup = svg; })
        .catch(() => {});
})();

// --- NETWORK STATE (SUPABASE) ---
const SUPABASE_URL = 'https://lnjcbqdcaikndbllyhkc.supabase.co'; // Keep your actual URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxuamNicWRjYWlrbmRibGx5aGtjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3ODIyNjgsImV4cCI6MjA5MzM1ODI2OH0.zIt87ajVwBUEstCiQdHbrqUWRmEcQvrcRmY109bT_QE'; // Keep your actual Key
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// Safe ID generation (prevents local dev failures, preserved across refresh)
let myPlayerId = sessionStorage.getItem('wordperfect_player_id');
if (!myPlayerId) {
    myPlayerId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).substring(2);
    sessionStorage.setItem('wordperfect_player_id', myPlayerId);
}

let isReady = false;
let isHost = false
let roomChannel = null;
let myRoomCode = '';
let myPlayerName = '';
// Host-specific memory for collision checking
let hostSubmissions = {};
let roundFinalized = false;
let finalizeWatchdog = null;
let activePlayersList = []; // Kept in sync via presence
let hostElectionInProgress = false;
let lastKnownHostId = null;
let hostGeneration = 0; // bumps on host election; soft auth for host-gated broadcasts
let expectedHostGeneration = null; // guests mirror live host presence hostGeneration
let hostScoreLedger = Object.create(null); // host-authoritative scores; never trust presence.score
let lastKnownAiPlayers = []; // survives host leave so a new host can adopt the bots
let reconcilingBots = false;
let cachedBoardWords = null;
let cachedBoardKey = '';
let myLocalAiPlayers = [];
// Host-only: whether a bot should fill in while the host waits alone
let aiEnabled = true;
const RECONNECT_WINDOW_MS = 3 * 60 * 1000;
let disconnectedSeats = [];
let lastKnownDisconnectedSeats = [];
let previousLivePlayers = [];
let recentDepartedPlayers = [];
let intentionalLeavers = new Set();
let draftSnapshots = {};
let reclaimRequestPending = false;
let reclaimingSeat = false;
let connectionLost = false;
let reconnectInProgress = false;
let recoveringAsFormerHost = false;
let reconnectCleanupTimer = null;
const intentionallyClosedChannels = new WeakSet();
const btnOpenTutorial = document.getElementById('btnOpenTutorial');

// Escape user-controlled strings before interpolating into innerHTML
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getBroadcastData(response) {
    if (!response) return {};
    if (response.payload && typeof response.payload === 'object') return response.payload;
    return response;
}

function getHostPlayerId() {
    return WordperfectIntegrity.getLiveHostId(activePlayersList);
}

function getElectedHostId() {
    return WordperfectIntegrity.getElectedHostId(activePlayersList);
}

function hostPayload(extra) {
    return Object.assign({ senderId: myPlayerId, hostGeneration }, extra || {});
}

// Soft auth: ignore game-control broadcasts that aren't from the current live host.
// Residual: public broadcast cannot authenticate; hostGeneration + live presence only
// stop casual senderId spoofing. Need private channels + auth for determined attackers.
function isFromCurrentHost(data) {
    return WordperfectIntegrity.verifyHostEvent(data, {
        livePlayers: activePlayersList,
        electedHostId: getElectedHostId(),
        expectedHostGeneration
    });
}

function bumpHostGeneration() {
    const base = Math.max(
        Number(hostGeneration) || 0,
        Number(expectedHostGeneration) || 0
    );
    hostGeneration = base + 1;
    expectedHostGeneration = hostGeneration;
    sessionStorage.setItem('wordperfect_host_generation', String(hostGeneration));
}

function persistHostScoreLedger() {
    if (!isHost) return;
    try {
        sessionStorage.setItem('wordperfect_host_score_ledger', JSON.stringify(hostScoreLedger));
        sessionStorage.setItem('wordperfect_host_generation', String(hostGeneration));
    } catch (e) { /* ignore quota */ }
}

function restoreHostScoreLedger() {
    try {
        const raw = sessionStorage.getItem('wordperfect_host_score_ledger');
        if (raw) hostScoreLedger = JSON.parse(raw) || Object.create(null);
    } catch (e) {
        hostScoreLedger = Object.create(null);
    }
    const gen = sessionStorage.getItem('wordperfect_host_generation');
    if (gen != null && gen !== '') hostGeneration = Number(gen) || hostGeneration;
}

// Host re-validates every submitted word so a modified client can't score junk
function sanitizeSubmittedWords(words) {
    if (!Array.isArray(words)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of words) {
        const w = String(raw || '').trim().toUpperCase();
        if (w.length < 4 || seen.has(w)) continue;
        if (!isWordInGrid(w) || !dictionarySet.has(w) || isPlural(w)) continue;
        seen.add(w);
        out.push(w);
    }
    return out;
}

// The old 4-card popup is gone; "How to Play" now runs the guided tutorial defined further
// down, which teaches on the real game chassis instead of describing it.
btnOpenTutorial.addEventListener('click', (e) => {
    e.preventDefault(); // <--- This violently stops any accidental form submissions!
    startTutorial();
});
// --- LOCAL GAME STATE ---
const letterBag = [
    'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'E', 'E', 'E', 'E', 'E', 'E', 'E', 'E', 'E', 'E', 'E', 'E',
    'I', 'I', 'I', 'I', 'I', 'I', 'I', 'I', 'I', 'O', 'O', 'O', 'O', 'O', 'O', 'O', 'O', 'U', 'U', 'U', 'U',
    'N', 'N', 'N', 'N', 'N', 'N', 'R', 'R', 'R', 'R', 'R', 'R', 'T', 'T', 'T', 'T', 'T', 'T',
    'L', 'L', 'L', 'L', 'S', 'S', 'S', 'S', 'D', 'D', 'D', 'D', 'G', 'G', 'G',
    'B', 'B', 'C', 'C', 'M', 'M', 'P', 'P', 'F', 'F', 'H', 'H', 'V', 'V', 'W', 'W', 'Y', 'Y',
    'K', 'J', 'X', 'Q', 'Z'
];

let timeLeft = 60;
let timerInterval = null;
let countdownInterval = null;
let draftedWords = [];
let boardLetters = [];
let isPlaying = false;

// --- SESSION PERSISTENCE HELPERS ---
function saveGameStateToSession() {
    sessionStorage.setItem('wordperfect_is_playing', isPlaying ? 'true' : 'false');
    sessionStorage.setItem('wordperfect_board_letters', JSON.stringify(boardLetters));
    sessionStorage.setItem('wordperfect_current_round', currentRound.toString());
    sessionStorage.setItem('wordperfect_max_rounds', maxRounds.toString());
    sessionStorage.setItem('wordperfect_seconds_per_round', secondsPerRound.toString());
    sessionStorage.setItem('wordperfect_score_mode', scoreMode);
    sessionStorage.setItem('wordperfect_time_left', timeLeft.toString());
    sessionStorage.setItem('wordperfect_total_score', myTotalScore.toString());
    sessionStorage.setItem('wordperfect_word_attempts', wordAttempts.toString());
    sessionStorage.setItem('wordperfect_word_errors', wordErrors.toString());
    // Bots live only on the host — persist so a host refresh mid-round doesn't erase them
    if (isHost) {
        sessionStorage.setItem('wordperfect_bots', JSON.stringify(myLocalAiPlayers));
        sessionStorage.setItem('wordperfect_ai_enabled', aiEnabled ? 'true' : 'false');
        persistHostScoreLedger();
    }
}

function clearGameStateFromSession() {
    sessionStorage.removeItem('wordperfect_is_playing');
    sessionStorage.removeItem('wordperfect_board_letters');
    sessionStorage.removeItem('wordperfect_current_round');
    sessionStorage.removeItem('wordperfect_max_rounds');
    sessionStorage.removeItem('wordperfect_seconds_per_round');
    sessionStorage.removeItem('wordperfect_score_mode');
    sessionStorage.removeItem('wordperfect_time_left');
    // Every caller here is starting a fresh game, so the carried score must go too —
    // otherwise a refresh after "Play Again" restores the previous game's total.
    sessionStorage.removeItem('wordperfect_total_score');
    sessionStorage.removeItem('wordperfect_total_words');
    sessionStorage.removeItem('wordperfect_word_attempts');
    sessionStorage.removeItem('wordperfect_word_errors');
    sessionStorage.removeItem('wordperfect_bots');
    sessionStorage.removeItem('wordperfect_ai_enabled');
    sessionStorage.removeItem('wordperfect_host_score_ledger');
    sessionStorage.removeItem('wordperfect_host_generation');

    // Clear draft words for all rounds
    for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('wordperfect_drafted_')) {
            sessionStorage.removeItem(key);
            i--; // Adjust index since list size shrank
        }
    }
}


// --- PHYSICS SIMULATION STATE (MATTER.JS) ---
let physicsEngine = null;
let physicsWorld = null;
let physicsWordBodies = [];
let physicsAnimId = null;
let physicsResizeTimer = null;
let physicsLayoutSize = '';
let scorePopups = []; // non-physics particles: {x, y, text, bornAt} — drawn on top of pills

const SCORE_POPUP_DELAY_MS = 600;
const SCORE_POPUP_LIFETIME_MS = 900;

let currentRound = 1;
let maxRounds = 3;
let secondsPerRound = 60;
let scoreMode = 'classic'; // 'classic' = 1pt/letter, 'scrabble' = letter-value scoring
let myTotalScore = 0;
let myTotalWords = 0;
let wordAttempts = 0; // successes + the 2 "genuine miss" rejections only
let wordErrors = 0;   // just the 2 "genuine miss" rejections (board letters / not a word)
let dictionarySet = new Set();
let penaltyActive = false;
let penaltyTimeLeft = 5;
let penaltyInterval = null;

// --- DOM NODES ---
const tiles = document.querySelectorAll('.tile');
const timerDisplay = document.getElementById('master-timer');
const wordForm = document.getElementById('word-form');
const wordInput = document.getElementById('word-input');
const sendBtn = document.getElementById('send-word-btn');
const draftList = document.getElementById('drafted-words');
const actionBtn = document.getElementById('submit-round');

const roundIndicator = document.getElementById('round-indicator');
const totalScoreDisplay = document.getElementById('total-score-display');
const roundScoreDisplay = document.getElementById('round-score-display');
const lobbyRoundText = document.getElementById('lobby-round-text');
const navRoomDisplay = document.getElementById('nav-room-display');
const navRoundDisplay = document.getElementById('nav-round-display');

// Screens
const screenBoot = document.getElementById('screen-boot');
const screenLobby = document.getElementById('screen-lobby');
const screenCountdown = document.getElementById('screen-countdown');
const screenResults = document.getElementById('screen-results');
const screenStandings = document.getElementById('screen-standings');
const screenWinner = document.getElementById('screen-winner');
const penaltyModal = document.getElementById('penalty-modal');
const connectionErrorModal = document.getElementById('connection-error-modal');

// Controls
const bootStatus = document.getElementById('boot-status');
const multiplayerControls = document.getElementById('multiplayer-controls');
const inputPlayerName = document.getElementById('input-player-name');
const inputRoomCode = document.getElementById('input-room-code');
const lobbyInputRounds = document.getElementById('lobby-input-rounds');
const lobbyRoundsDisplay = document.getElementById('lobby-rounds-display');
const lobbyInputTime = document.getElementById('lobby-input-time');
const lobbyTimeDisplay = document.getElementById('lobby-time-display');
const lobbyModeToggle = document.getElementById('lobby-mode-toggle');
const modeToggleHint = document.getElementById('mode-toggle-hint');
const modeToggleBtns = lobbyModeToggle ? Array.from(lobbyModeToggle.querySelectorAll('.mode-toggle-btn')) : [];
const btnCreateRoom = document.getElementById('btn-create-room');
const btnJoinRoom = document.getElementById('btn-join-room');
const joinErrorMsg = document.getElementById('join-error-msg');
const btnReadyUp = document.getElementById('btn-ready-up');
const btnStandingsReady = document.getElementById('btn-standings-ready');
const countdownTimer = document.getElementById('countdown-timer');
const countdownRound = document.getElementById('countdown-round');
const standingsTitle = document.getElementById('standings-title');
const displayRoomCode = document.getElementById('display-room-code');
const lobbyPlayerList = document.getElementById('lobby-player-list');
const btnNextRound = document.getElementById('btn-next-round');
const btnShuffle = document.getElementById('btn-shuffle');
const btnStandingsViewWords = document.getElementById('btn-standings-view-words');
const btnCopyLink = document.getElementById('btn-copy-link');
// (Removed the dead btnStandingsToLobby reference here)
const resultsList = document.getElementById('results-list');
const resultsFilterBar = document.getElementById('results-filter-bar');
const resultsEmptyMsg = document.getElementById('results-empty-msg');
const toastStack = document.getElementById('toast-stack');
const idlePrompt = document.getElementById('results-idle-prompt');
const btnIdleRefresher = document.getElementById('btn-idle-refresher');
const rulesRecapModal = document.getElementById('rules-recap-modal');
const btnCloseRecap = document.getElementById('btn-close-recap');
const standingsList = document.getElementById('standings-list');
const resultsTitle = document.getElementById('results-title');
const winnerList = document.getElementById('winner-list');
const btnPlayAgain = document.getElementById('btn-play-again');
const guestWaitingMsg = document.getElementById('guest-waiting-msg');
const penStatus = document.getElementById('penalty-status');
const penTimerEl = document.getElementById('penalty-timer');
const btnRejoinGame = document.getElementById('btn-rejoin-game');
const btnConnectionLeave = document.getElementById('btn-connection-leave');
const connectionRetryStatus = document.getElementById('connection-retry-status');

function showOverlay(element) { element.classList.add('active'); }
function hideOverlay(element) { element.classList.remove('active'); }

// Read live rather than cached: the preference can change mid-session (apple-design §14)
function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// --- JOIN VALIDATION ---
// Supabase has no room registry: subscribing to a channel for a made-up code succeeds
// and leaves you alone in an empty room forever. A host's presence is the only proof
// the room is real, so guests stay on the boot screen until one shows up.
let awaitingHostConfirm = false;
let roomProbeTimer = null;
const ROOM_PROBE_MS = 3000;

function showJoinStatus(msg, isError) {
    joinErrorMsg.textContent = msg;
    joinErrorMsg.classList.toggle('text-danger', isError);
    joinErrorMsg.classList.toggle('text-muted', !isError);
    joinErrorMsg.classList.remove('hidden');
}

function hideJoinStatus() {
    joinErrorMsg.classList.add('hidden');
}

function setJoinBusy(busy) {
    btnJoinRoom.disabled = busy;
    btnCreateRoom.disabled = busy;
}

// --- NAME UNIQUENESS ---
// Scoring attributes each word to its author by NAME, so two players sharing one in the same
// room silently merge their submissions: the collision rule stops firing between them and
// the points all land on whoever the lookup finds first. Names must be unique per room.
const NAME_TAKEN_MSG = 'That name is already taken in this room. Pick another.';

function nameKey(name) {
    return (name || '').trim().toUpperCase();
}

function findNameClash(players, name, excludeId) {
    const key = nameKey(name);
    return players.find(p => p.id !== excludeId && nameKey(p.name) === key);
}

// Two guests can clear the join check at the same instant, before either shows up in the
// other's presence. Both then re-evaluate here against the same roster, so the rule has to
// be deterministic and pick exactly one loser. The host owns the room and never yields;
// bots are the host's, so they don't yield to guests either; otherwise lowest id wins.
function enforceNameUniqueness() {
    if (isHost || awaitingHostConfirm || !roomChannel) return;

    const clash = findNameClash(activePlayersList, myPlayerName, myPlayerId);
    if (!clash) return;

    if (clash.isHost || clash.isAi || String(clash.id) < String(myPlayerId)) {
        failJoin(NAME_TAKEN_MSG, inputPlayerName, 'TAKEN');
    }
}

function revealRoom() {
    hideOverlay(screenBoot);
    if (isPlaying) {
        hideOverlay(screenLobby);
        initRound(timeLeft);
    } else {
        showOverlay(screenLobby);
    }
}

function confirmRoomExists() {
    if (!awaitingHostConfirm) return;
    awaitingHostConfirm = false;
    clearTimeout(roomProbeTimer);
    roomProbeTimer = null;
    setJoinBusy(false);
    hideJoinStatus();
    syncMyState();
    revealRoom();
}

async function failJoin(message, field = inputRoomCode, hint = 'NO ROOM') {
    awaitingHostConfirm = false;
    clearTimeout(roomProbeTimer);
    roomProbeTimer = null;
    await leaveRoomAndGoHome(); // tears the channel down and returns to boot
    // Keep what they typed: it is likely nearly right and only needs an edit
    flashFieldError(field, hint, 1600, { keepValue: true });
    showJoinStatus(message, true);
}

// --- BOOT SEQUENCE ---
const BOOT_TIPS = [
    'If two of you found it, nobody gets it.',
    'RAIN scores. RAINS is just the S talking.',
    'Classic pays for length. Scrabble pays for the ugly letters.',
    'Done early? Lock in. The clock will not miss you.',
    'The obvious word is the one everyone else typed too.',
];

let bootTipTimer = null;

function startBootTips() {
    const tipEl = document.getElementById('boot-tip');
    if (!tipEl || prefersReducedMotion()) {
        if (tipEl) tipEl.textContent = BOOT_TIPS[0];
        return;
    }
    let i = 0;
    tipEl.textContent = BOOT_TIPS[0];
    bootTipTimer = setInterval(() => {
        tipEl.classList.add('is-fading');
        setTimeout(() => {
            i = (i + 1) % BOOT_TIPS.length;
            tipEl.textContent = BOOT_TIPS[i];
            tipEl.classList.remove('is-fading');
        }, 220);
    }, 2800);
}

function stopBootTips() {
    clearInterval(bootTipTimer);
    bootTipTimer = null;
}

async function bootEngine() {
    const bootLoading = document.getElementById('boot-loading');
    startBootTips();
    try {
        const response = await fetch('https://raw.githubusercontent.com/MagicOctopusUrn/wordListsByLength/master/unsorted.txt');
        const text = await response.text();
        const words = text.split(/\r?\n/).filter(word => word.trim().length > 0);
        dictionarySet = new Set(words.map(word => word.trim().toUpperCase()));

        stopBootTips();
        if (bootLoading) bootLoading.classList.add('hidden');
        multiplayerControls.classList.remove('hidden');

        // Check for saved session to auto-rejoin
        const savedRoom = sessionStorage.getItem('wordperfect_room');
        const savedName = sessionStorage.getItem('wordperfect_name');
        const savedIsHost = sessionStorage.getItem('wordperfect_is_host') === 'true';

        if (savedRoom && savedName) {
            console.log("Auto-rejoining room:", savedRoom, "as", savedName);
            
            const savedScore = sessionStorage.getItem('wordperfect_total_score');
            if (savedScore) {
                myTotalScore = parseInt(savedScore);
                totalScoreDisplay.textContent = `Total: ${myTotalScore} pts`;
            }
            
            const savedWords = sessionStorage.getItem('wordperfect_total_words');
            if (savedWords) {
                myTotalWords = parseInt(savedWords);
            }

            const savedAttempts = sessionStorage.getItem('wordperfect_word_attempts');
            if (savedAttempts) wordAttempts = parseInt(savedAttempts);
            const savedErrors = sessionStorage.getItem('wordperfect_word_errors');
            if (savedErrors) wordErrors = parseInt(savedErrors);

            // Restore round state if we were playing mid-round
            const savedIsPlaying = sessionStorage.getItem('wordperfect_is_playing') === 'true';
            if (savedIsPlaying) {
                const savedBoard = sessionStorage.getItem('wordperfect_board_letters');
                const savedCurRound = sessionStorage.getItem('wordperfect_current_round');
                const savedMaxRounds = sessionStorage.getItem('wordperfect_max_rounds');
                const savedSecondsPerRound = sessionStorage.getItem('wordperfect_seconds_per_round');
                const savedScoreMode = sessionStorage.getItem('wordperfect_score_mode');
                const savedTimeLeft = sessionStorage.getItem('wordperfect_time_left');

                if (savedBoard) {
                    try {
                        boardLetters = JSON.parse(savedBoard);
                        if (!Array.isArray(boardLetters)) boardLetters = [];
                    } catch (e) {
                        boardLetters = [];
                    }
                }
                if (savedCurRound) {
                    currentRound = parseInt(savedCurRound);
                }
                if (savedMaxRounds) {
                    maxRounds = parseInt(savedMaxRounds);
                }
                if (savedSecondsPerRound) {
                    secondsPerRound = parseInt(savedSecondsPerRound);
                }
                if (savedScoreMode) {
                    scoreMode = savedScoreMode;
                }
                if (savedTimeLeft) {
                    timeLeft = parseInt(savedTimeLeft);
                }
                isPlaying = true;
            }

            // Host refresh: restore bots so mid-round scoring still has an opponent
            if (savedIsHost) {
                const savedAiEnabled = sessionStorage.getItem('wordperfect_ai_enabled');
                if (savedAiEnabled !== null) aiEnabled = savedAiEnabled === 'true';
                const savedBots = sessionStorage.getItem('wordperfect_bots');
                if (savedBots) {
                    try {
                        const parsed = JSON.parse(savedBots);
                        if (Array.isArray(parsed)) {
                            myLocalAiPlayers = parsed;
                            lastKnownAiPlayers = parsed.map(b => ({ ...b }));
                        }
                    } catch (e) {
                        myLocalAiPlayers = [];
                    }
                }
            }
            
            await joinRealtimeRoom(savedRoom, savedName, savedIsHost, true);
        } else {
            // Check for room code in URL params to auto-fill
            const urlParams = new URLSearchParams(window.location.search);
            const urlRoom = urlParams.get('room');
            if (urlRoom) {
                inputRoomCode.value = urlRoom.toUpperCase();
                inputPlayerName.focus();
            }
        }
    } catch (error) {
        stopBootTips();
        bootStatus.textContent = 'Network Error. Could not load dictionary.';
        const tipEl = document.getElementById('boot-tip');
        if (tipEl) tipEl.textContent = 'Check your connection and refresh to try again.';
        const spinner = document.querySelector('.boot-spinner') || document.getElementById('boot-spinner-host');
        if (spinner) spinner.style.display = 'none';
    }
}

lobbyInputRounds.addEventListener('input', (e) => {
    if (!isHost) return;
    maxRounds = parseInt(e.target.value);
    lobbyRoundsDisplay.textContent = `${maxRounds} Round${maxRounds > 1 ? 's' : ''}`;
    refreshLobbySettingsSummary();
    updateLobbyRoundText();
    if (isReady) {
        isReady = false;
        resetReadyButtons();
    }
});

lobbyInputRounds.addEventListener('change', async () => {
    if (!isHost) return;
    await syncMyState();
});

lobbyInputTime.addEventListener('input', (e) => {
    if (!isHost) return;
    secondsPerRound = parseInt(e.target.value);
    lobbyTimeDisplay.textContent = `${secondsPerRound}s`;
    refreshLobbySettingsSummary();
    if (isReady) {
        isReady = false;
        resetReadyButtons();
    }
});

lobbyInputTime.addEventListener('change', async () => {
    if (!isHost) return;
    await syncMyState();
});

// Reflects scoreMode onto the toggle buttons + hint caption. Called for local changes,
// remote guest sync, and on (re)join — the one place that knows how to paint this state.

function refreshLobbySettingsSummary() {
    const roundsLabel = document.getElementById('lobby-step-rounds-label');
    const timeLabel = document.getElementById('lobby-step-time-label');
    const modeLabelEl = document.getElementById('lobby-step-mode-label');
    const modeLabel = scoreMode === 'scrabble' ? 'Scrabble' : 'Classic';
    if (roundsLabel) roundsLabel.textContent = `${maxRounds} round${maxRounds > 1 ? 's' : ''}`;
    if (timeLabel) timeLabel.textContent = `${secondsPerRound}s`;
    if (modeLabelEl) modeLabelEl.textContent = modeLabel;
}

function setModeToggleUI(mode) {
    modeToggleBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    if (modeToggleHint) {
        modeToggleHint.textContent = mode === 'scrabble'
            ? 'Rare letters score more (Scrabble values).'
            : '1 point per letter.';
    }
    refreshLobbySettingsSummary();
}

if (lobbyModeToggle) {
    lobbyModeToggle.addEventListener('click', async (e) => {
        if (!isHost) return;
        const btn = e.target.closest('.mode-toggle-btn');
        if (!btn || btn.dataset.mode === scoreMode) return;

        scoreMode = btn.dataset.mode;
        setModeToggleUI(scoreMode);
        if (isReady) {
            isReady = false;
            resetReadyButtons();
        }
        await syncMyState();
    });
}

function bumpLobbyRange(inputEl, delta) {
    if (!inputEl) return false;
    const min = parseInt(inputEl.min, 10);
    const max = parseInt(inputEl.max, 10);
    const step = parseInt(inputEl.step, 10) || 1;
    const cur = parseInt(inputEl.value, 10);
    const next = Math.min(max, Math.max(min, cur + delta * step));
    if (next === cur) return false;
    inputEl.value = String(next);
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

async function stepLobbyMode(dir) {
    const modes = ['classic', 'scrabble'];
    const idx = modes.indexOf(scoreMode);
    const next = modes[(idx + (dir >= 0 ? 1 : -1) + modes.length) % modes.length];
    if (next === scoreMode) return;
    scoreMode = next;
    setModeToggleUI(scoreMode);
    if (isReady) {
        isReady = false;
        resetReadyButtons();
    }
    await syncMyState();
}

const lobbySteppers = document.getElementById('lobby-settings-summary');
if (lobbySteppers && lobbySteppers.classList.contains('lobby-steppers')) {
    async function applyLobbyStep(step, dir) {
        if (!step || !dir) return;
        if (!isHost) {
            showToast('Only the host can change that');
            return;
        }
        const kind = step.dataset.step;
        if (kind === 'rounds') {
            bumpLobbyRange(lobbyInputRounds, dir);
        } else if (kind === 'time') {
            bumpLobbyRange(lobbyInputTime, dir);
        } else if (kind === 'mode') {
            await stepLobbyMode(dir);
        }
    }

    lobbySteppers.addEventListener('click', async (e) => {
        const step = e.target.closest('.lobby-step');
        if (!step || !lobbySteppers.contains(step)) return;
        const btn = e.target.closest('.lobby-step-btn');
        if (!btn) return;
        const dir = parseInt(btn.dataset.dir, 10) || 0;
        await applyLobbyStep(step, dir);
    });

    // Host-only: wheel on a chip steps its value. Guests keep page scroll.
    let wheelLock = false;
    lobbySteppers.addEventListener('wheel', (e) => {
        const step = e.target.closest('.lobby-step');
        if (!step || !lobbySteppers.contains(step)) return;
        if (!isHost) return;
        e.preventDefault();
        if (wheelLock) return;
        const dy = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        if (!dy) return;
        wheelLock = true;
        const dir = dy > 0 ? 1 : -1;
        applyLobbyStep(step, dir);
        setTimeout(() => { wheelLock = false; }, 80);
    }, { passive: false });

    // Host-only horizontal swipe. Vertical motion is left for lobby scroll.
    let drag = null;
    lobbySteppers.addEventListener('pointerdown', (e) => {
        if (!isHost) return;
        const step = e.target.closest('.lobby-step');
        if (!step || !lobbySteppers.contains(step)) return;
        if (e.target.closest('.lobby-step-btn')) return;
        drag = { step, x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId };
        try { step.setPointerCapture(e.pointerId); } catch (_) {}
    });
    lobbySteppers.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) < 18) return;
        if (Math.abs(dx) < Math.abs(dy)) return;
        if (Math.abs(dx) < 18) return;
        drag.moved = true;
        const dir = dx > 0 ? 1 : -1;
        drag.x = e.clientX;
        drag.y = e.clientY;
        applyLobbyStep(drag.step, dir);
    });
    const endDrag = (e) => {
        if (!drag || (e && e.pointerId !== drag.pointerId)) return;
        drag = null;
    };
    lobbySteppers.addEventListener('pointerup', endDrag);
    lobbySteppers.addEventListener('pointercancel', endDrag);
}


// --- SUPABASE REALTIME LOGIC ---

function makeDisconnectedSeat(player) {
    const snapshot = draftSnapshots[player.id];
    return {
        id: player.id,
        name: player.name,
        score: Number(player.score) || 0,
        totalWords: Number(player.totalWords) || 0,
        wordAttempts: Number(player.wordAttempts) || 0,
        wordErrors: Number(player.wordErrors) || 0,
        isReady: false,
        isHost: false,
        isAi: false,
        isDisconnected: true,
        disconnectedAt: Date.now(),
        reconnectUntil: Date.now() + RECONNECT_WINDOW_MS,
        disconnectedRound: currentRound,
        draftedWords: snapshot && snapshot.round === currentRound
            ? [...snapshot.words]
            : [],
        updatedAt: Date.now()
    };
}

function rememberDepartedPlayers(departed) {
    if (!departed.length) return false;
    recentDepartedPlayers = departed.map(player => ({ ...player }));
    if (!isHost) return false;

    let changed = false;
    departed.forEach(player => {
        if (intentionalLeavers.has(player.id)) {
            intentionalLeavers.delete(player.id);
            return;
        }
        if (disconnectedSeats.some(seat => seat.id === player.id)) return;
        const seat = makeDisconnectedSeat(player);
        disconnectedSeats.push(seat);
        if (!roundFinalized && boardLetters.length === 16) {
            hostSubmissions[seat.id] = sanitizeSubmittedWords(seat.draftedWords);
        }
        scheduleDisconnectedSeatCleanup();
        changed = true;
    });
    return changed;
}

function reconcileDisconnectedSeats(livePlayers) {
    if (!isHost || disconnectedSeats.length === 0) return false;
    const liveIds = new Set(livePlayers.map(player => player.id));
    const before = disconnectedSeats.length;
    disconnectedSeats = disconnectedSeats.filter(seat => !liveIds.has(seat.id));
    if (disconnectedSeats.length !== before) scheduleDisconnectedSeatCleanup();
    return disconnectedSeats.length !== before;
}

function dropDisconnectedSeatsForNextRound() {
    if (!isHost || disconnectedSeats.length === 0) return;
    const now = Date.now();
    disconnectedSeats = disconnectedSeats.filter(
        seat => seat.disconnectedRound >= currentRound || seat.reconnectUntil > now
    );
    scheduleDisconnectedSeatCleanup();
}

function scheduleDisconnectedSeatCleanup() {
    clearTimeout(reconnectCleanupTimer);
    reconnectCleanupTimer = null;
    if (!isHost || disconnectedSeats.length === 0) return;

    const now = Date.now();
    const futureExpiries = disconnectedSeats
        .map(seat => seat.reconnectUntil)
        .filter(expiry => expiry > now);
    if (futureExpiries.length === 0) return;
    const nextExpiry = Math.min(...futureExpiries);
    const delay = nextExpiry - now;
    reconnectCleanupTimer = setTimeout(async () => {
        reconnectCleanupTimer = null;
        const before = disconnectedSeats.length;
        dropDisconnectedSeatsForNextRound();
        if (disconnectedSeats.length !== before) await syncMyState();
    }, delay);
}

function restoreClaimedSeat(seat) {
    myPlayerId = seat.id;
    sessionStorage.setItem('wordperfect_player_id', myPlayerId);
    myTotalScore = Number(seat.score) || 0;
    myTotalWords = Number(seat.totalWords) || 0;
    wordAttempts = Number(seat.wordAttempts) || 0;
    wordErrors = Number(seat.wordErrors) || 0;
    draftedWords = Array.isArray(seat.draftedWords) ? [...seat.draftedWords] : [];

    sessionStorage.setItem('wordperfect_total_score', String(myTotalScore));
    sessionStorage.setItem('wordperfect_total_words', String(myTotalWords));
    sessionStorage.setItem('wordperfect_word_attempts', String(wordAttempts));
    sessionStorage.setItem('wordperfect_word_errors', String(wordErrors));
    sessionStorage.setItem(
        `wordperfect_drafted_${myRoomCode}_round_${seat.disconnectedRound}`,
        JSON.stringify(draftedWords)
    );
    totalScoreDisplay.textContent = `Total: ${myTotalScore} pts`;
}

function showConnectionError(message = 'Rejoin within 3 minutes to reclaim your seat, score, and current-round words.') {
    connectionLost = true;
    reconnectInProgress = false;
    clearInterval(timerInterval);
    timerInterval = null;
    connectionRetryStatus.textContent = message;
    connectionRetryStatus.classList.remove('is-error');
    btnRejoinGame.disabled = false;
    btnRejoinGame.textContent = 'Rejoin game';
    showOverlay(connectionErrorModal);
}

function setReconnectBusy(busy, message = '') {
    reconnectInProgress = busy;
    btnRejoinGame.disabled = busy;
    btnRejoinGame.textContent = busy ? 'Rejoining…' : 'Rejoin game';
    connectionRetryStatus.textContent = message;
    connectionRetryStatus.classList.toggle('is-error', !busy && !!message);
}

// Phoenix/Supabase fires CHANNEL_ERROR on every socket blip and auto-rejoins.
// Hold the overlay until that recovery actually fails.
const connectionRecovery = WordperfectConnectionRecovery.create({
    isHidden: () => document.hidden,
    onLost() {
        showConnectionError(
            reconnectInProgress
                ? 'Rejoin failed. Check your connection and try again.'
                : undefined
        );
    },
    onRecovered() {
        hideOverlay(connectionErrorModal);
    }
});

document.addEventListener('visibilitychange', () => {
    connectionRecovery.handleVisibility();
});


async function syncMyState() {
    if (!roomChannel) return;

    console.log("Broadcasting my state: Ready =", isReady);

    const trackPayload = {
        id: myPlayerId,
        name: myPlayerName,
        isReady: isReady,
        score: myTotalScore,
        totalWords: myTotalWords,
        wordAttempts: wordAttempts,
        wordErrors: wordErrors,
        isHost: isHost,
        isPlaying: isPlaying,
        isPendingJoin: awaitingHostConfirm && !reclaimingSeat,
        updatedAt: Date.now() // FIX: Forces Supabase to broadcast the change
    };

    if (isHost) {
        trackPayload.maxRounds = maxRounds;
        trackPayload.roundTime = secondsPerRound;
        trackPayload.scoreMode = scoreMode;
        trackPayload.aiPlayers = myLocalAiPlayers;
        trackPayload.disconnectedSeats = disconnectedSeats;
        trackPayload.hostGeneration = hostGeneration;
    }

    await roomChannel.track(trackPayload);
}

async function maybeElectNewHost() {
    if (!roomChannel || hostElectionInProgress) return;

    const realPlayers = activePlayersList.filter(p => !p.isAi && !p.isDisconnected);
    if (realPlayers.length === 0) return;
    if (realPlayers.some(p => p.isHost)) return;

    const electedId = [...realPlayers]
        .map(p => p.id)
        .sort((a, b) => String(a).localeCompare(String(b)))[0];
    if (electedId !== myPlayerId) return;

    hostElectionInProgress = true;
    try {
        console.log('Host left — taking over as host');
        isHost = true;
        lastKnownHostId = myPlayerId;
        bumpHostGeneration();
        // Takeover starts at zero. Presence scores are forgeable; only a
        // session restore (original host refresh) is a trusted ledger.
        if (!hostScoreLedger || Object.keys(hostScoreLedger).length === 0) {
            hostScoreLedger = WordperfectIntegrity.createScoreLedger(activePlayersList);
        } else {
            hostScoreLedger = WordperfectIntegrity.ensureScoreLedger(hostScoreLedger, activePlayersList);
        }
        persistHostScoreLedger();
        sessionStorage.setItem('wordperfect_is_host', 'true');

        disconnectedSeats = lastKnownDisconnectedSeats.map(seat => ({ ...seat }));
        recentDepartedPlayers.forEach(player => {
            if (
                player.id === myPlayerId ||
                intentionalLeavers.has(player.id) ||
                disconnectedSeats.some(seat => seat.id === player.id)
            ) return;
            disconnectedSeats.push(makeDisconnectedSeat(player));
        });
        scheduleDisconnectedSeatCleanup();

        // Adopt the previous host's bots (presence drops them with the old host)
        if (myLocalAiPlayers.length === 0 && lastKnownAiPlayers.length > 0) {
            myLocalAiPlayers = lastKnownAiPlayers.map(b => ({ ...b, updatedAt: Date.now() }));
            aiEnabled = true;
            syncAiSwitch();
        }

        lobbyInputRounds.disabled = false;
        lobbyInputTime.disabled = false;
        if (lobbyModeToggle) lobbyModeToggle.classList.remove('disabled');
        resetReadyButtons();
        await syncMyState();

        // Recover submissions lost when the previous host dropped or refreshed
        // Fresh bag so first-write-wins still accepts client resubmits after takeover
        hostSubmissions = {};
        roundFinalized = false;
        await roomChannel.send({
            type: 'broadcast',
            event: 'request_resubmit',
            payload: hostPayload()
        });

        clearTimeout(finalizeWatchdog);
        finalizeWatchdog = setTimeout(() => {
            if (isHost && !roundFinalized) {
                console.warn('Finalize watchdog fired after host takeover.');
                finalizeRound();
            }
        }, 10000);
    } finally {
        hostElectionInProgress = false;
    }
}

async function joinRealtimeRoom(code, name, hostFlag, isRecovery = false) {
    myRoomCode = code;
    myPlayerName = name;
    isHost = hostFlag;
    recoveringAsFormerHost = hostFlag && isRecovery;
    if (hostFlag) {
        if (isRecovery) {
            restoreHostScoreLedger();
            if (!hostGeneration) bumpHostGeneration();
        } else {
            hostScoreLedger = Object.create(null);
            bumpHostGeneration();
        }
    }
    if (!hostFlag && !isPlaying && !reclaimingSeat) awaitingHostConfirm = true;

    // Persist session details across page refreshes
    sessionStorage.setItem('wordperfect_room', code);
    sessionStorage.setItem('wordperfect_name', name);
    sessionStorage.setItem('wordperfect_is_host', hostFlag ? 'true' : 'false');

    // Tear down any previous channel so re-join doesn't orphan listeners / ghost presence
    if (roomChannel) {
        try {
            intentionallyClosedChannels.add(roomChannel);
            await roomChannel.unsubscribe();
        } catch (e) {
            console.error('Error unsubscribing previous channel:', e);
        }
        roomChannel = null;
    }

    // FIX: Explicitly configure the channel to accept Presence and Broadcast features
    roomChannel = supabaseClient.channel(`room:${myRoomCode}`, {
        config: {
            presence: {
                key: myPlayerId,
            },
            broadcast: {
                self: true, // Allows the host to hear their own commands
                ack: false,
            }
        }
    });
    const channel = roomChannel;

    // 1. Presence Sync (Lobby Updates)
    const handlePresenceUpdate = () => {
        if (channel !== roomChannel) return;
        const state = channel.presenceState();

        const livePresencePlayers = [];
        let aiPlayersToAppend = [];
        for (const id in state) {
            if (state[id] && state[id].length > 0) {
                // FIX: Sort the history array by our timestamp so we always grab the newest state!
                const playerStates = state[id];
                playerStates.sort((a, b) => b.updatedAt - a.updatedAt);
                const activeState = playerStates[0];
                livePresencePlayers.push(activeState);
                
                // If this connected player is the host and has bots, save them
                if (activeState.isHost && activeState.aiPlayers) {
                    aiPlayersToAppend = activeState.aiPlayers;
                }
            }
        }

        const anotherHost = livePresencePlayers.find(
            player => player.isHost && !player.isAi && player.id !== myPlayerId
        );
        if (isHost && recoveringAsFormerHost && anotherHost) {
            isHost = false;
            disconnectedSeats = [];
            sessionStorage.setItem('wordperfect_is_host', 'false');
            const myLiveState = livePresencePlayers.find(player => player.id === myPlayerId);
            if (myLiveState) myLiveState.isHost = false;
            syncMyState();
        }
        const liveIds = new Set(livePresencePlayers.map(player => player.id));
        const departed = previousLivePlayers.filter(
            player => !liveIds.has(player.id) && !player.isPendingJoin
        );
        previousLivePlayers = livePresencePlayers
            .filter(player => !player.isAi)
            .map(player => ({ ...player }));
        const departedChanged = rememberDepartedPlayers(departed);
        const reclaimedChanged = reconcileDisconnectedSeats(livePresencePlayers);

        const liveHost = livePresencePlayers.find(p => p.isHost && !p.isAi);
        if (liveHost && Array.isArray(liveHost.disconnectedSeats)) {
            lastKnownDisconnectedSeats = liveHost.disconnectedSeats.map(seat => ({ ...seat }));
        }
        const seatsForRoster = isHost
            ? disconnectedSeats
            : (liveHost && Array.isArray(liveHost.disconnectedSeats) ? liveHost.disconnectedSeats : []);

        // A pending guest is only probing the room. It becomes visible after lobby
        // validation, or after the host grants a disconnected-seat claim.
        const visibleLivePlayers = livePresencePlayers.filter(player => !player.isPendingJoin);
        activePlayersList = [...visibleLivePlayers, ...aiPlayersToAppend, ...seatsForRoster];
        if (isHost && (departedChanged || reclaimedChanged)) syncMyState();

        // Cache bots whenever we see them — host leave removes them from presence, but
        // the elected replacement still needs the roster mid-round.
        if (aiPlayersToAppend.length > 0) {
            lastKnownAiPlayers = aiPlayersToAppend.map(b => ({ ...b }));
        }

        if (liveHost) {
            lastKnownHostId = liveHost.id;
            if (liveHost.hostGeneration != null) {
                expectedHostGeneration = Number(liveHost.hostGeneration);
            }
        }

        // Guest synchronizes with the host's settings (maxRounds, secondsPerRound) in real-time
        const hostPlayer = liveHost;
        if (hostPlayer) {
            if (!isHost) {
                let settingsChanged = false;
                if (hostPlayer.maxRounds !== undefined && hostPlayer.maxRounds !== maxRounds) {
                    maxRounds = hostPlayer.maxRounds;
                    lobbyInputRounds.value = maxRounds;
                    lobbyRoundsDisplay.textContent = `${maxRounds} Round${maxRounds > 1 ? 's' : ''}`;
                    refreshLobbySettingsSummary();
                    settingsChanged = true;
                }
                if (hostPlayer.roundTime !== undefined && hostPlayer.roundTime !== secondsPerRound) {
                    secondsPerRound = hostPlayer.roundTime;
                    lobbyInputTime.value = secondsPerRound;
                    lobbyTimeDisplay.textContent = `${secondsPerRound}s`;
                    refreshLobbySettingsSummary();
                    settingsChanged = true;
                }
                if (hostPlayer.scoreMode !== undefined && hostPlayer.scoreMode !== scoreMode) {
                    scoreMode = hostPlayer.scoreMode;
                    setModeToggleUI(scoreMode);
                    settingsChanged = true;
                }
                if (settingsChanged) {
                    updateLobbyRoundText();
                    if (isReady) {
                        isReady = false;
                        resetReadyButtons();
                        syncMyState();
                    }
                }
            }
        }

        // A lone host gets a bot automatically; the toggle stays visible so they can opt out
        const realPlayerCount = activePlayersList.filter(p => !p.isAi && !p.isDisconnected).length;
        const aiToastEl = document.getElementById('ai-toast');
        if (aiToastEl) {
            aiToastEl.classList.toggle('visible', isHost && realPlayerCount === 1 && !isPlaying);
        }
        reconcileBots(realPlayerCount);

        renderLobbyPlayers(activePlayersList);
        if (screenStandings.classList.contains('active')) {
            renderStandingsScreen(activePlayersList, currentRound > 1 ? currentRound - 1 : 1);
        }

        // Host checks if everyone is ready to start
        if (isHost && activePlayersList.length > 0) {
            const readyPlayers = activePlayersList.filter(p => !p.isDisconnected);
            const allReady = readyPlayers.length > 0 && readyPlayers.every(p => p.isReady);

            if (allReady && !isPlaying) {
                console.log("Host detected all players are ready. Starting game...");
                startGameAsHost();
            }
        }

        // A host in presence is the proof we were waiting for. The roster it brings is also
        // the first chance to see whether our name is already spoken for — or if a round
        // is already live (late joins softlock finalize by becoming required submitters).
        if (awaitingHostConfirm && activePlayersList.some(p => p.isHost)) {
            const hostPlayer = activePlayersList.find(p => p.isHost);
            const claimableSeat = seatsForRoster.find(seat => nameKey(seat.name) === nameKey(myPlayerName));
            if (reclaimRequestPending) {
                // The host may publish the seat removal before our targeted grant arrives.
                // Keep waiting rather than turning that harmless ordering race into a denial.
            } else if (claimableSeat) {
                reclaimRequestPending = true;
                showJoinStatus('Reclaiming your seat…', false);
                channel.send({
                    type: 'broadcast',
                    event: 'claim_seat',
                    payload: { requesterId: myPlayerId, name: myPlayerName }
                });
            } else if (hostPlayer && hostPlayer.isPlaying) {
                failJoin('That game is already in progress. Only disconnected players can rejoin.');
            } else if (findNameClash(activePlayersList, myPlayerName, myPlayerId)) {
                failJoin(NAME_TAKEN_MSG, inputPlayerName, 'TAKEN');
            } else {
                confirmRoomExists();
            }
        } else {
            enforceNameUniqueness();
        }

        // Someone leaving can be the event that completes the round
        maybeFinalizeRound();
        // If the host vanished mid-session, elect a replacement so the room isn't softlocked
        maybeElectNewHost();
    };
    // FIX: Bind to all three events to guarantee we don't miss any updates
    roomChannel.on('presence', { event: 'sync' }, handlePresenceUpdate);
    roomChannel.on('presence', { event: 'join' }, handlePresenceUpdate);
    roomChannel.on('presence', { event: 'leave' }, handlePresenceUpdate);

    // 2. Broadcasts (The Game Engine)
    roomChannel.on('broadcast', { event: 'draft_snapshot' }, (response) => {
        const data = getBroadcastData(response);
        if (!data.playerId || !Array.isArray(data.words)) return;
        draftSnapshots[data.playerId] = {
            round: Number(data.round) || currentRound,
            words: sanitizeSubmittedWords(data.words)
        };
        if (!isHost) return;
        const seat = disconnectedSeats.find(item => item.id === data.playerId);
        if (seat && seat.disconnectedRound === draftSnapshots[data.playerId].round) {
            seat.draftedWords = [...draftSnapshots[data.playerId].words];
            syncMyState();
        }
    });

    roomChannel.on('broadcast', { event: 'intentional_leave' }, (response) => {
        const data = getBroadcastData(response);
        if (!data.playerId) return;
        intentionalLeavers.add(data.playerId);
        if (!isHost) return;
        disconnectedSeats = disconnectedSeats.filter(seat => seat.id !== data.playerId);
        delete draftSnapshots[data.playerId];
        scheduleDisconnectedSeatCleanup();
        syncMyState();
    });

    roomChannel.on('broadcast', { event: 'claim_seat' }, async (response) => {
        if (!isHost) return;
        const data = getBroadcastData(response);
        const seat = disconnectedSeats.find(item => nameKey(item.name) === nameKey(data.name));
        if (!seat || !data.requesterId) {
            await roomChannel.send({
                type: 'broadcast',
                event: 'claim_denied',
                payload: hostPayload({ requesterId: data.requesterId })
            });
            return;
        }

        await roomChannel.send({
            type: 'broadcast',
            event: 'claim_granted',
            payload: hostPayload({ requesterId: data.requesterId, seat, isPlaying })
        });
        disconnectedSeats = disconnectedSeats.filter(item => item.id !== seat.id);
        lastKnownDisconnectedSeats = disconnectedSeats.map(item => ({ ...item }));
        scheduleDisconnectedSeatCleanup();
        await syncMyState();
    });

    roomChannel.on('broadcast', { event: 'claim_granted' }, async (response) => {
        const data = getBroadcastData(response);
        if (!isFromCurrentHost(data)) {
            console.warn('Ignoring claim_granted from non-host');
            return;
        }
        if (data.requesterId !== myPlayerId || !data.seat) return;

        reclaimRequestPending = false;
        reclaimingSeat = true;
        awaitingHostConfirm = false;
        restoreClaimedSeat(data.seat);
        isPlaying = data.isPlaying === true;
        await joinRealtimeRoom(myRoomCode, data.seat.name, false);
    });

    roomChannel.on('broadcast', { event: 'claim_denied' }, (response) => {
        const data = getBroadcastData(response);
        if (!isFromCurrentHost(data)) {
            console.warn('Ignoring claim_denied from non-host');
            return;
        }
        if (data.requesterId !== myPlayerId) return;
        reclaimRequestPending = false;
        failJoin('That reconnect seat is no longer available. Ask the host to start a new game.');
    });

    roomChannel.on('broadcast', { event: 'trigger_game' }, (response) => {
        console.log("Raw trigger_game response:", response); // For debugging

        const data = getBroadcastData(response);
        if (!isFromCurrentHost(data)) {
            console.warn('Ignoring trigger_game from non-host');
            return;
        }

        boardLetters = data.board;
        maxRounds = data.maxRounds || 3;
        secondsPerRound = data.roundTime || 60;
        scoreMode = data.scoreMode || 'classic';
        setModeToggleUI(scoreMode);
        cachedBoardWords = null;
        cachedBoardKey = '';

        isReady = false;
        isPlaying = true; // guests must lock this before countdown finishes
        roundFinalized = false;
        resetReadyButtons();

        // Persist to session storage
        sessionStorage.setItem('wordperfect_board_letters', JSON.stringify(boardLetters));
        sessionStorage.setItem('wordperfect_max_rounds', maxRounds.toString());
        sessionStorage.setItem('wordperfect_seconds_per_round', secondsPerRound.toString());
        sessionStorage.setItem('wordperfect_score_mode', scoreMode);
        sessionStorage.setItem('wordperfect_current_round', currentRound.toString());
        sessionStorage.setItem('wordperfect_is_playing', 'true');

        hideOverlay(screenLobby);
        hideOverlay(screenStandings);
        startCountdown();
    });

    // Listen for request_sync (Host responds to rejoining clients)
    roomChannel.on('broadcast', { event: 'request_sync' }, async (response) => {
        const data = getBroadcastData(response);
        if (isHost && isPlaying) {
            console.log("Host received request_sync from requester:", data.requesterId);
            await roomChannel.send({
                type: 'broadcast',
                event: 'sync_game_state',
                payload: hostPayload({
                    board: boardLetters,
                    currentRound: currentRound,
                    maxRounds: maxRounds,
                    roundTime: secondsPerRound,
                    scoreMode: scoreMode,
                    timeLeft: timeLeft
                })
            });
        }
    });

    // Host (or newly elected host) asks locked-in clients to resend their drafts
    roomChannel.on('broadcast', { event: 'request_resubmit' }, async (response) => {
        const data = getBroadcastData(response);
        if (!isFromCurrentHost(data) || !roomChannel) return;
        // Already locked in for this round — resend so the host can score
        if (!isPlaying && Array.isArray(draftedWords)) {
            await roomChannel.send({
                type: 'broadcast',
                event: 'submit_words',
                payload: { playerId: myPlayerId, words: draftedWords }
            });
        }
    });

    // Listen for sync_game_state (Guests align with Host)
    roomChannel.on('broadcast', { event: 'sync_game_state' }, (response) => {
        const data = getBroadcastData(response);
        if (!isFromCurrentHost(data)) {
            console.warn('Ignoring sync_game_state from non-host');
            return;
        }
        if (!isHost) {
            console.log("Received sync_game_state from host:", data);
            
            // Sync game parameters
            boardLetters = data.board;
            currentRound = data.currentRound;
            maxRounds = data.maxRounds;
            secondsPerRound = data.roundTime || 60;
            scoreMode = data.scoreMode || 'classic';
            setModeToggleUI(scoreMode);
            cachedBoardWords = null;
            cachedBoardKey = '';

            const syncedLeft = typeof data.timeLeft === 'number' ? data.timeLeft : secondsPerRound;

            // Persist to session storage
            sessionStorage.setItem('wordperfect_board_letters', JSON.stringify(boardLetters));
            sessionStorage.setItem('wordperfect_current_round', currentRound.toString());
            sessionStorage.setItem('wordperfect_max_rounds', maxRounds.toString());
            sessionStorage.setItem('wordperfect_seconds_per_round', secondsPerRound.toString());
            sessionStorage.setItem('wordperfect_score_mode', scoreMode);
            sessionStorage.setItem('wordperfect_is_playing', 'true');
            sessionStorage.setItem('wordperfect_time_left', String(syncedLeft));

            if (!isPlaying) {
                hideOverlay(screenLobby);
                hideOverlay(screenStandings);
                hideOverlay(screenResults);
                updateLobbyRoundText();
                initRound(syncedLeft);
            } else {
                // Just sync the timeLeft
                timeLeft = syncedLeft;
            }
        }
    });

    // Always bind — isHost can flip after failover; gate inside the handler
    roomChannel.on('broadcast', { event: 'submit_words' }, (response) => {
        if (!isHost) return;
        const data = getBroadcastData(response);
        if (!data.playerId) return;
        // Disconnected seats are host-filled from drafts — ignore spoofed broadcast ids
        const existingSubmissionIds = new Set(Object.keys(hostSubmissions));
        if (!WordperfectIntegrity.canAcceptWordSubmission(data.playerId, {
            livePlayers: activePlayersList,
            disconnectedSeatIds: [],
            existingSubmissionIds,
            firstWriteWins: true
        })) {
            console.warn('Ignoring submit_words for unknown/disconnected/duplicate playerId');
            return;
        }
        hostSubmissions[data.playerId] = sanitizeSubmittedWords(data.words);
        maybeFinalizeRound();
    });

    roomChannel.on('broadcast', { event: 'round_results' }, async (response) => {
        const data = getBroadcastData(response);
        if (!isFromCurrentHost(data) || !Array.isArray(data.results)) {
            console.warn('Ignoring round_results from non-host or malformed payload');
            return;
        }

        hideOverlay(screenCountdown);
        showOverlay(screenResults);

        // draftedWords still holds this round's finds (initRound clears it for the next
        // one), so an empty list means they sat the round out.
        idlePrompt.classList.toggle('hidden', draftedWords.length > 0);

        isReady = false;
        resetReadyButtons();

        // Sort results: active words first, highest points first — word length isn't a
        // proxy for points in Scrabble mode (a short QUIZ can outscore a long, low-value
        // word), so this has to key on the actual points, not the word's length.
        const sortedResults = [...data.results].sort((a, b) => {
            if (a.isDuplicate !== b.isDuplicate) {
                return a.isDuplicate ? 1 : -1;
            }
            if (b.points !== a.points) return b.points - a.points;
            return b.word.length - a.word.length; // tie-break: longer word first
        });

        // A fresh round starts with nobody's likes counted yet — old counts must not bleed
        // into this round's freshly-rebuilt rows.
        wordLikes = {};

        // Render the results list — tap any word (cancelled or not) to look up its meaning
        resultsList.innerHTML = '';
        sortedResults.forEach(res => {
            const li = document.createElement('li');
            li.className = `result-row ${res.isDuplicate ? 'duplicate-word' : 'unique-word'}`;
            li.dataset.authors = JSON.stringify(res.authors); // read by the player filter
            li.dataset.word = res.word; // read by the like listener
            const authorsText = escapeHtml(res.authors.join(', '));
            const safeWord = escapeHtml(res.word);
            const pointsText = res.isDuplicate ? 'CANCELLED' : `+${res.points} pts`;
            // Omitted entirely (not just disabled) on your own word — including as a
            // co-author of a cancelled duplicate — liking your own word notifies no one.
            const iAmAuthor = res.authors.includes(myPlayerName);
            const heartHtml = iAmAuthor ? '' : `
                        <button type="button" class="heart-btn" title="Like this word" aria-label="Like this word" aria-pressed="false">
                            <svg class="heart-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                            </svg>
                        </button>`;

            li.innerHTML = `
                <div class="result-row-header">
                    <div style="display:flex; flex-direction:column;">
                        <span class="result-word">${safeWord}</span>
                        <span class="caption result-authors">${authorsText}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        ${heartHtml}<span class="result-points">${pointsText}</span>
                        <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px; transition: transform 0.3s var(--ease-out); opacity: 0.5; flex-shrink: 0;">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </div>
                </div>
                <div class="def-collapse" style="max-height: 0px; opacity: 0; transition: all 0.3s var(--ease-out);">
                    <p class="caption def-text">Tap to see meaning</p>
                </div>
            `;
            li.addEventListener('click', () => toggleResultDefinition(li, res.word));

            const heartBtn = li.querySelector('.heart-btn');
            if (heartBtn) {
                heartBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // don't also trigger the row's definition expand
                    toggleWordLike(res.word, res.authors);
                });
            }

            resultsList.appendChild(li);
        });

        // Filter pills: one per player in the room this round (ranked like the podium),
        // reset to "All" on every fresh round rather than carrying a stale selection.
        const roundPlayerNames = [...data.players].sort((a, b) => b.score - a.score).map(p => p.name);
        renderResultsFilterBar(roundPlayerNames);
        applyResultsFilter('all');

        // Update my local score
        const myResult = data.players.find(p => p.id === myPlayerId);
        if (myResult) {
            myTotalScore = myResult.score;
            myTotalWords = myResult.totalWords || 0;
            sessionStorage.setItem('wordperfect_total_score', myTotalScore.toString());
            sessionStorage.setItem('wordperfect_total_words', myTotalWords.toString());
            totalScoreDisplay.textContent = `Total: ${myTotalScore} pts`;
            await syncMyState(); // Update presence with new score
        }

        if (data.isGameOver) {
            resultsTitle.textContent = "Final Round Results";
            btnNextRound.textContent = "View Final Standings";
            btnNextRound.onclick = () => renderWinnerScreen(data.players, data.currentRound);
        } else {
            currentRound = data.currentRound + 1;
            updateLobbyRoundText();
            resultsTitle.textContent = `Round ${data.currentRound} Results`;
            btnNextRound.textContent = "View Current Standings";
            btnNextRound.onclick = () => {
                hideOverlay(screenResults);
                showOverlay(screenStandings);
                renderStandingsScreen(data.players, data.currentRound);
            };
        }
    });

    roomChannel.on('broadcast', { event: 'game_reset' }, async (response) => {
        const data = getBroadcastData(response);
        if (!isFromCurrentHost(data)) {
            console.warn('Ignoring game_reset from non-host');
            return;
        }

        currentRound = 1;
        myTotalScore = 0;
        myTotalWords = 0;
        wordAttempts = 0;
        wordErrors = 0;
        isReady = false;
        // Bots now carry their score between rounds, so a new game has to clear it too
        myLocalAiPlayers = myLocalAiPlayers.map(bot => ({
            ...bot, score: 0, totalWords: 0, updatedAt: Date.now()
        }));
        resetReadyButtons();
        updateLobbyRoundText();

        // Clear cached game states
        clearGameStateFromSession();

        // Re-seed after clearGameStateFromSession wipes the session ledger keys
        hostScoreLedger = WordperfectIntegrity.createScoreLedger(
            [...activePlayersList, ...myLocalAiPlayers]
        );
        if (isHost) persistHostScoreLedger();

        await syncMyState();

        hideOverlay(screenWinner);
        showOverlay(screenLobby);
    });

    // Word likes — room-wide, no host gating, every client both sends and listens
    roomChannel.on('broadcast', { event: 'word_like' }, (response) => {
        const data = getBroadcastData(response);
        if (!data.word || !data.likerName) return;
        updateWordLikeUI(data.word, data.likerName, data.liked);
        // Only the like transition toasts the author, never the unlike, and never yourself
        if (data.liked && Array.isArray(data.authorNames) && data.authorNames.includes(myPlayerName) && data.likerName !== myPlayerName) {
            showToast(`${data.likerName} liked ${data.word}`);
        }
    });

    // 3. Subscribe
    roomChannel.subscribe(async (status) => {
        if (channel !== roomChannel) return;
        connectionRecovery.handleStatus(status, {
            intentionalClose: intentionallyClosedChannels.has(channel),
            allowBeforeJoin: reconnectInProgress || isPlaying
        });
        if (status === 'SUBSCRIBED') {
            connectionLost = false;
            reconnectInProgress = false;
            reclaimingSeat = false;
            reclaimRequestPending = false;
            hideOverlay(connectionErrorModal);
            // Configure lobby settings sliders for Host vs Guest
            if (isHost) {
                lobbyInputRounds.disabled = false;
                lobbyInputTime.disabled = false;
                if (lobbyModeToggle) lobbyModeToggle.classList.remove('disabled');
            } else {
                lobbyInputRounds.disabled = true;
                lobbyInputTime.disabled = true;
                if (lobbyModeToggle) lobbyModeToggle.classList.add('disabled');
            }
            setModeToggleUI(scoreMode);

            // isHost is settled by now, so the ready button can claim its real label
            resetReadyButtons();
            syncAiSwitch();

            await syncMyState();
            displayRoomCode.textContent = myRoomCode;
            navRoomDisplay.textContent = `Room: ${myRoomCode}`;
            updateLobbyRoundText();

            if (isHost || isPlaying) {
                // The host IS the room, and a mid-game rejoin was already in it — restoring
                // from session is proof enough. Probing here would risk kicking a player out
                // of a live round just because presence was slow.
                revealRoom();
            } else if (screenBoot.classList.contains('active') && !screenLobby.classList.contains('active')) {
                // Stay on the boot screen until the host's presence proves this room is real.
                // Skip this on an automatic rejoin — the guest is already in the lobby.
                awaitingHostConfirm = true;
                setJoinBusy(true);
                showJoinStatus('Looking for that room...', false);
                clearTimeout(roomProbeTimer);
                roomProbeTimer = setTimeout(() => {
                    failJoin('No room with that code. Check it and try again.');
                }, ROOM_PROBE_MS);
            }

            // Always broadcast request_sync to ensure alignment with Host or catch up
            console.log("Sending request_sync...");
            await roomChannel.send({
                type: 'broadcast',
                event: 'request_sync',
                payload: { requesterId: myPlayerId }
            });

            // Host refresh mid-round: ask locked-in clients to resend submissions
            if (isHost && isPlaying) {
                hostSubmissions = {};
                roundFinalized = false;
                await roomChannel.send({
                    type: 'broadcast',
                    event: 'request_resubmit',
                    payload: hostPayload()
                });
            }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            if (!intentionallyClosedChannels.has(channel)) {
                console.warn('Realtime channel interrupted:', status);
            }
        }
    });
}

// --- HOST AUTHORITATIVE FUNCTIONS ---
async function startGameAsHost() {
    isPlaying = true; // FIX: Lock the game state so this doesn't double-fire
    hostSubmissions = {};
    roundFinalized = false;
    dropDisconnectedSeatsForNextRound();
    cachedBoardWords = null;
    cachedBoardKey = '';
    // Host-owned score ledger — never read presence.score when finalizing
    hostScoreLedger = WordperfectIntegrity.createScoreLedger(activePlayersList);
    persistHostScoreLedger();
    const newBoard = [];
    for (let i = 0; i < 16; i++) {
        newBoard.push(letterBag[Math.floor(Math.random() * letterBag.length)]);
    }

    boardLetters = newBoard;
    saveGameStateToSession();
    await syncMyState();

    await roomChannel.send({
        type: 'broadcast',
        event: 'trigger_game',
        payload: hostPayload({
            board: newBoard,
            maxRounds: maxRounds,
            roundTime: secondsPerRound,
            scoreMode: scoreMode
        })
    });
}

function getAllValidBoardWords() {
    const key = boardLetters.join('');
    if (cachedBoardKey === key && cachedBoardWords) return cachedBoardWords;

    const validWords = [];
    for (const word of dictionarySet) {
        if (word.length >= 4 && !isPlural(word) && isWordInGrid(word)) {
            validWords.push(word);
        }
    }
    cachedBoardKey = key;
    cachedBoardWords = validWords;
    return validWords;
}

function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Difficulty profiles: Easy finds short/common-ish words and collides more;
// Hard finds longer / higher-value words and tries to dodge human finds.
const BOT_DIFFICULTY = {
    Easy: {
        minCount: 2, maxCount: 4, maxLen: 5,
        avoidHumanChance: 0.25, preferHighValue: false, lengthBias: 'short'
    },
    Medium: {
        minCount: 4, maxCount: 7, maxLen: 7,
        avoidHumanChance: 0.55, preferHighValue: true, lengthBias: 'mid'
    },
    Hard: {
        minCount: 7, maxCount: 12, maxLen: 16,
        avoidHumanChance: 0.85, preferHighValue: true, lengthBias: 'long'
    }
};

function botWordScore(word) {
    // Ranking key for preferential picks — Scrabble mode weights letter values
    if (scoreMode === 'scrabble') return scoreWord(word) * 10 + word.length;
    return word.length * 10 + (scoreWord(word) || 0);
}

function generateBotWords(bot, allValidWords, humanWordSet) {
    const cfg = BOT_DIFFICULTY[bot.difficulty] || BOT_DIFFICULTY.Medium;
    const targetCount = cfg.minCount + Math.floor(Math.random() * (cfg.maxCount - cfg.minCount + 1));

    // Prefer the difficulty's length band; if the board is sparse, widen until we have a pool
    let pool = allValidWords.filter(w => w.length >= 4 && w.length <= cfg.maxLen);
    if (pool.length < targetCount) {
        pool = allValidWords.filter(w => w.length >= 4 && w.length <= Math.min(cfg.maxLen + 2, 16));
    }
    if (pool.length === 0) pool = [...allValidWords];

    // Shuffle first, then stable-sort by preference — ties keep random order
    pool = shuffleInPlace([...pool]);
    pool.sort((a, b) => {
        if (cfg.lengthBias === 'short') return a.length - b.length;
        if (cfg.lengthBias === 'long') return botWordScore(b) - botWordScore(a);
        // mid: mild preference for mid-length, with score awareness when enabled
        const midA = Math.abs(a.length - 5);
        const midB = Math.abs(b.length - 5);
        if (cfg.preferHighValue) {
            const scoreDelta = botWordScore(b) - botWordScore(a);
            if (Math.abs(scoreDelta) > 8) return scoreDelta;
        }
        return midA - midB;
    });

    const picked = [];
    const pickedSet = new Set();

    // First pass: respect avoid-human preference
    for (const word of pool) {
        if (picked.length >= targetCount) break;
        if (pickedSet.has(word)) continue;
        if (humanWordSet.has(word) && Math.random() < cfg.avoidHumanChance) continue;
        picked.push(word);
        pickedSet.add(word);
    }

    // Second pass: fill remaining slots even if they collide (Easy often does; Hard rarely needs this)
    if (picked.length < targetCount) {
        const remainder = shuffleInPlace(pool.filter(w => !pickedSet.has(w)));
        for (const word of remainder) {
            if (picked.length >= targetCount) break;
            picked.push(word);
            pickedSet.add(word);
        }
    }

    return picked;
}

// A round ends when everyone still in the room has reported. This must be re-checked on
// presence changes, not just on submission: if a player drops after the others have
// already submitted, no further submit_words ever arrives and the round hangs forever.
function maybeFinalizeRound() {
    if (!isHost || roundFinalized) return;

    const realPlayers = activePlayersList.filter(p => !p.isAi && !p.isDisconnected);
    if (realPlayers.length === 0) return;

    // Submissions from players who have since left must not count toward the total,
    // or a leaver's stale entry could satisfy the check on someone else's behalf.
    const present = new Set(realPlayers.map(p => p.id));
    const received = Object.keys(hostSubmissions).filter(id => present.has(id));

    if (received.length >= realPlayers.length) finalizeRound();
}

function finalizeRound() {
    if (!isHost || roundFinalized) return;
    roundFinalized = true; // one scoring pass per round, whichever trigger gets here first
    clearTimeout(finalizeWatchdog);
    finalizeWatchdog = null;
    clearTimeout(reconnectCleanupTimer);
    reconnectCleanupTimer = null;
    calculateScoresAndBroadcast();
}

const SCRABBLE_VALUES = {
    A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3,
    N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10
};

// The one place points are computed, so a new mode is a new branch here — everything
// downstream (results, standings, winner) already just reads `points`/`score` generically.
function scoreWord(word) {
    if (scoreMode === 'scrabble') {
        return [...word].reduce((sum, ch) => sum + (SCRABBLE_VALUES[ch] || 0), 0);
    }
    return word.length; // classic
}

async function calculateScoresAndBroadcast() {
    let wordMap = {};

    // Human words already in hostSubmissions — bots try (by difficulty) not to cancel them
    const humanWordSet = new Set();
    for (const playerId of Object.keys(hostSubmissions)) {
        const player = activePlayersList.find(p => p.id === playerId);
        if (player && player.isAi) continue;
        for (const w of hostSubmissions[playerId] || []) humanWordSet.add(w);
    }

    // Prefer host-owned bots; fall back to whatever is still on the roster (failover)
    const aiPlayers = (myLocalAiPlayers.length > 0
        ? myLocalAiPlayers
        : activePlayersList.filter(p => p.isAi));

    const allValidWords = getAllValidBoardWords();
    aiPlayers.forEach(bot => {
        hostSubmissions[bot.id] = generateBotWords(bot, allValidWords, humanWordSet);
    });

    // Ensure AI entries are on the scoring roster even if presence briefly dropped them
    let tempPlayers = JSON.parse(JSON.stringify(activePlayersList));
    aiPlayers.forEach(bot => {
        if (!tempPlayers.some(p => p.id === bot.id)) {
            tempPlayers.push(JSON.parse(JSON.stringify(bot)));
        }
    });

    // Authority: hostScoreLedger, not presence.score (clients can forge presence)
    hostScoreLedger = WordperfectIntegrity.ensureScoreLedger(hostScoreLedger, tempPlayers);
    tempPlayers = WordperfectIntegrity.overlayLedgerScores(tempPlayers, hostScoreLedger);

    // Map words to authors
    for (let playerId in hostSubmissions) {
        let words = hostSubmissions[playerId];
        let player = tempPlayers.find(p => p.id === playerId) || activePlayersList.find(p => p.id === playerId);
        let playerName = player ? player.name : "Unknown";

        words.forEach(w => {
            if (!wordMap[w]) wordMap[w] = [];
            if (!wordMap[w].includes(playerName)) {
                wordMap[w].push(playerName);
            }
        });
    }

    let results = [];

    for (let word in wordMap) {
        let authors = wordMap[word];
        let isDuplicate = authors.length > 1;
        let points = isDuplicate ? 0 : scoreWord(word);

        results.push({ word, authors, isDuplicate, points });

        if (!isDuplicate) {
            let playerRef = tempPlayers.find(p => p.name === authors[0]);
            if (playerRef) {
                const entry = WordperfectIntegrity.applyUniqueWordToLedger(
                    hostScoreLedger, playerRef.id, points
                );
                playerRef.score = entry.score;
                playerRef.totalWords = entry.totalWords;
            }
        }
    }

    results.sort((a, b) => a.isDuplicate - b.isDuplicate);
    const isGameOver = currentRound >= maxRounds;

    // Real players each persist their own score and re-publish it via presence, but
    // nobody owns the bots except us — without this write-back the next presence sync
    // re-publishes them at their pre-round score and the points vanish.
    myLocalAiPlayers = myLocalAiPlayers.map(bot => {
        const scored = tempPlayers.find(p => p.id === bot.id);
        if (!scored) return bot;
        return { ...bot, score: scored.score, totalWords: scored.totalWords || 0, updatedAt: Date.now() };
    });
    disconnectedSeats = disconnectedSeats.map(seat => {
        const scored = tempPlayers.find(player => player.id === seat.id);
        if (!scored) return seat;
        return {
            ...seat,
            score: scored.score,
            totalWords: scored.totalWords || 0,
            updatedAt: Date.now()
        };
    });
    lastKnownDisconnectedSeats = disconnectedSeats.map(seat => ({ ...seat }));
    lastKnownAiPlayers = myLocalAiPlayers.map(b => ({ ...b }));
    persistHostScoreLedger();
    saveGameStateToSession();
    if (isHost) await syncMyState();

    await roomChannel.send({
        type: 'broadcast',
        event: 'round_results',
        payload: hostPayload({
            results,
            players: tempPlayers,
            isGameOver: isGameOver,
            currentRound: currentRound
        })
    });
}


const soccerPlayers = [
    "Messi", "Ronaldo", "Neymar", "Mbappe", "Haaland", 
    "Salah", "DeBruyne", "Kane", "Lewandowski", "Modric", 
    "Benzema", "Kroos", "Ronaldinho", "Zidane", "Pele", "Maradona"
];

function getRandomAiName() {
    const currentNames = activePlayersList.map(p => p.name.toUpperCase());
    // Also avoid colliding with names of bots we're about to keep
    const botNames = myLocalAiPlayers.map(p => p.name.toUpperCase());
    const taken = new Set([...currentNames, ...botNames]);
    const availablePlayers = soccerPlayers.filter(name => !taken.has(name.toUpperCase()));
    
    const baseName = availablePlayers.length > 0 
        ? availablePlayers[Math.floor(Math.random() * availablePlayers.length)]
        : "Striker";
        
    return `${baseName}_${Math.floor(10 + Math.random() * 90)}`;
}

function createBot() {
    return {
        id: 'ai-' + Math.random().toString(36).substring(2),
        name: getRandomAiName(),
        isReady: true,
        score: 0,
        totalWords: 0,
        difficulty: 'Medium',
        isAi: true,
        updatedAt: Date.now()
    };
}

// A bot only exists to keep a lone host company: it joins automatically and steps
// aside as soon as a second real player arrives. Host-authoritative, since bots
// live in the host's presence payload.
async function reconcileBots(realPlayerCount) {
    if (!isHost || isPlaying || reconcilingBots) return;
    reconcilingBots = true;

    try {
        const hasBot = myLocalAiPlayers.length > 0;

        if (realPlayerCount >= 2 && hasBot) {
            myLocalAiPlayers = [];
            lastKnownAiPlayers = [];
            saveGameStateToSession();
            await syncMyState();
        } else if (realPlayerCount === 1 && !hasBot && aiEnabled) {
            // Assign synchronously before any await so overlapping presence events
            // can't spawn a second bot.
            myLocalAiPlayers = [createBot()];
            lastKnownAiPlayers = myLocalAiPlayers.map(b => ({ ...b }));
            saveGameStateToSession();
            await syncMyState();
        }
    } finally {
        reconcilingBots = false;
    }
}

async function leaveRoomAndGoHome() {
    console.log("Leaving room and cleaning up state...");
    
    // Every timer has to die here. A survivor fires against a torn-down room:
    // the countdown would start a phantom round, and endRound() would then hit
    // roomChannel after it has been nulled.
    clearInterval(timerInterval);
    timerInterval = null;
    clearInterval(countdownInterval);
    countdownInterval = null;
    clearInterval(penaltyInterval);
    penaltyInterval = null;
    penaltyActive = false;
    clearTimeout(finalizeWatchdog);
    finalizeWatchdog = null;
    clearTimeout(roomProbeTimer);
    roomProbeTimer = null;
    clearTimeout(physicsResizeTimer);
    physicsResizeTimer = null;
    physicsLayoutSize = '';
    awaitingHostConfirm = false;
    setJoinBusy(false);
    connectionRecovery.reset();
    document.body.classList.remove('counting-down', 'penalized');

    if (roomChannel) {
        try {
            await roomChannel.send({
                type: 'broadcast',
                event: 'intentional_leave',
                payload: { playerId: myPlayerId }
            });
            intentionallyClosedChannels.add(roomChannel);
            await roomChannel.unsubscribe();
        } catch (e) {
            console.error("Error unsubscribing:", e);
        }
        roomChannel = null;
    }

    if (physicsEngine) {
        Matter.World.clear(physicsWorld);
        Matter.Engine.clear(physicsEngine);
        physicsEngine = null;
        physicsWorld = null;
    }
    if (physicsAnimId) {
        cancelAnimationFrame(physicsAnimId);
        physicsAnimId = null;
    }
    physicsWordBodies = [];

    isPlaying = false;
    currentRound = 1;
    myTotalScore = 0;
    myTotalWords = 0;
    wordAttempts = 0;
    wordErrors = 0;
    myLocalAiPlayers = [];
    lastKnownAiPlayers = [];
    disconnectedSeats = [];
    lastKnownDisconnectedSeats = [];
    previousLivePlayers = [];
    recentDepartedPlayers = [];
    intentionalLeavers.clear();
    draftSnapshots = {};
    reclaimRequestPending = false;
    reclaimingSeat = false;
    connectionLost = false;
    reconnectInProgress = false;
    recoveringAsFormerHost = false;
    aiEnabled = true;
    isReady = false;
    isHost = false;
    hostGeneration = 0;
    expectedHostGeneration = null;
    hostScoreLedger = Object.create(null);
    hostSubmissions = {};
    cachedBoardWords = null;
    cachedBoardKey = '';

    clearGameStateFromSession();
    sessionStorage.removeItem('wordperfect_room');
    sessionStorage.removeItem('wordperfect_name');
    sessionStorage.removeItem('wordperfect_is_host');
    sessionStorage.removeItem('wordperfect_total_score');
    sessionStorage.removeItem('wordperfect_total_words');

    resetReadyButtons();
    syncAiSwitch();
    totalScoreDisplay.textContent = `Total: 0 pts`;
    roundScoreDisplay.textContent = `Drafted: 0 words`;
    displayRoomCode.textContent = '----';
    navRoomDisplay.textContent = 'Room: ----';
    navRoundDisplay.textContent = 'Round 1';
    roundIndicator.textContent = 'Round 1';

    const overlays = [
        screenLobby, screenCountdown, screenResults,
        screenStandings, screenWinner, penaltyModal,
        document.getElementById('confirm-leave-modal'),
        connectionErrorModal,
        document.getElementById('rules-recap-modal')
    ];
    overlays.forEach(o => {
        if (o) hideOverlay(o);
    });

    showOverlay(screenBoot);
}

// --- UI EVENT LISTENERS ---
[inputPlayerName, inputRoomCode, wordInput].forEach(el => {
    el.addEventListener('input', () => clearFieldError(el));
});

// Validates the name field in place, returning false once it has flagged itself
function hasValidName() {
    const name = inputPlayerName.value.trim();
    if (name.length === 0) {
        flashFieldError(inputPlayerName, 'Enter your name here');
        return false;
    }
    if (name.length < 2) {
        flashFieldError(inputPlayerName, 'Name needs 2+ letters');
        return false;
    }
    return true;
}

btnCreateRoom.addEventListener('click', async () => {
    maxRounds = 3; // Default starting rounds
    secondsPerRound = 60; // Default starting round duration
    scoreMode = 'classic'; // Default starting mode
    if (!hasValidName()) return;
    myPlayerName = inputPlayerName.value.trim();

    myLocalAiPlayers = [];
    aiEnabled = true;

    // Pre-initialize lobby setting displays for the Host
    lobbyInputRounds.value = maxRounds;
    lobbyRoundsDisplay.textContent = `${maxRounds} Round${maxRounds > 1 ? 's' : ''}`;
    refreshLobbySettingsSummary();
    lobbyInputTime.value = secondsPerRound;
    lobbyTimeDisplay.textContent = `${secondsPerRound}s`;
    refreshLobbySettingsSummary();
    setModeToggleUI(scoreMode);

    clearGameStateFromSession();

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));

    await joinRealtimeRoom(code, myPlayerName, true);
});

btnJoinRoom.addEventListener('click', async () => {
    hideJoinStatus();
    if (!hasValidName()) return;

    const code = inputRoomCode.value.trim().toUpperCase();
    if (code.length === 0) {
        flashFieldError(inputRoomCode, 'CODE?');
        return;
    }
    if (code.length !== 4) {
        flashFieldError(inputRoomCode, '4 LETTERS');
        return;
    }

    myPlayerName = inputPlayerName.value.trim();
    myLocalAiPlayers = [];
    aiEnabled = true;
    clearGameStateFromSession();

    await joinRealtimeRoom(code, myPlayerName, false);
});

btnReadyUp.addEventListener('click', async () => {
    isReady = !isReady;
    btnReadyUp.style.backgroundColor = isReady ? 'var(--surface-black)' : 'var(--primary)';
    btnReadyUp.textContent = isReady ? 'Waiting for others...' : lobbyReadyLabel();
    await syncMyState();
});

btnStandingsReady.addEventListener('click', async () => {
    isReady = !isReady;
    btnStandingsReady.style.backgroundColor = isReady ? 'var(--surface-black)' : 'var(--primary)';
    btnStandingsReady.textContent = isReady ? 'Waiting for others...' : 'Ready for Next Round';
    await syncMyState();
});

btnStandingsViewWords.addEventListener('click', () => {
    hideOverlay(screenStandings);
    showOverlay(screenResults);
});

const btnWinnerViewWords = document.getElementById('btn-winner-view-words');
if (btnWinnerViewWords) {
    btnWinnerViewWords.addEventListener('click', () => {
        hideOverlay(screenWinner);
        showOverlay(screenResults);
    });
}

btnCopyLink.addEventListener('click', () => {
    const inviteLink = `${window.location.origin}${window.location.pathname}?room=${myRoomCode}`;
    navigator.clipboard.writeText(inviteLink).then(() => {
        const wrapper = btnCopyLink.querySelector('.icon-wrapper');
        const copySvg = document.getElementById('copy-icon-svg');
        const checkSvg = document.getElementById('check-icon-svg');
        if (!wrapper || !copySvg || !checkSvg) return;

        // Phase 1: Start transition (fade out and blur)
        wrapper.classList.add('transitioning');

        setTimeout(() => {
            // Swap icons only (icon-only button — no label text)
            copySvg.style.opacity = '0';
            checkSvg.style.opacity = '1';
            wrapper.classList.remove('transitioning');
        }, 150);

        // Revert to copy icon after ~1.8s
        setTimeout(() => {
            wrapper.classList.add('transitioning');
            setTimeout(() => {
                copySvg.style.opacity = '1';
                checkSvg.style.opacity = '0';
                wrapper.classList.remove('transitioning');
            }, 150);
        }, 1800);
    }).catch(err => {
        alert('Could not copy link. Share this code: ' + myRoomCode);
    });
});

// (Removed the dead btnStandingsToLobby listener)

btnPlayAgain.addEventListener('click', async () => {
    if (isHost) {
        await roomChannel.send({ type: 'broadcast', event: 'game_reset', payload: hostPayload() });
    }
});

// Fisher-Yates, then repaint the faces. Split out so the reduced-motion path can shuffle
// without the fly-to-centre choreography.
function applyShuffle() {
    for (let i = boardLetters.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [boardLetters[i], boardLetters[j]] = [boardLetters[j], boardLetters[i]];
    }
    tiles.forEach((tile, index) => {
        tile.textContent = boardLetters[index];
    });
}

btnShuffle.addEventListener('click', () => {
    if (!isPlaying) return;

    // The board still shuffles — it just doesn't perform (§14)
    if (prefersReducedMotion()) {
        applyShuffle();
        return;
    }

    const board = document.getElementById('board');
    const boardRect = board.getBoundingClientRect();
    const boardCenterX = boardRect.left + boardRect.width / 2;
    const boardCenterY = boardRect.top + boardRect.height / 2;

    // Phase 1: Animate tiles translating to the exact center of the board with card-like rotations
    tiles.forEach(tile => {
        const tileRect = tile.getBoundingClientRect();
        const tileCenterX = tileRect.left + tileRect.width / 2;
        const tileCenterY = tileRect.top + tileRect.height / 2;

        const dx = boardCenterX - tileCenterX;
        const dy = boardCenterY - tileCenterY;

        // Generate a random angle for messy card stack look
        const angle = (Math.random() - 0.5) * 30; // -15deg to +15deg

        tile.style.transition = 'transform 250ms cubic-bezier(0.23, 1, 0.32, 1), opacity 250ms ease, filter 250ms ease';
        tile.style.transform = `translate(${dx}px, ${dy}px) scale(0.8) rotate(${angle}deg)`;
        tile.style.opacity = '0.2';
        tile.style.filter = 'blur(1px)';
    });

    setTimeout(() => {
        applyShuffle();

        // Phase 2: Animate back to original grid positions and fade/scale in springily
        tiles.forEach(tile => {
            tile.style.transition = 'transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 300ms ease, filter 300ms ease';
            tile.style.transform = 'translate(0, 0) scale(1) rotate(0deg)';
            tile.style.opacity = '1';
            tile.style.filter = 'none';
        });

        // Phase 3: Clean up inline styles so standard CSS hover/active states work normally
        setTimeout(() => {
            tiles.forEach(tile => {
                tile.style.transform = '';
                tile.style.opacity = '';
                tile.style.filter = '';
                tile.style.transition = '';
            });
        }, 300);
    }, 250); // Matches the outbound transition duration
});

// --- RENDER HELPERS ---
// The host's click still just flips their own ready flag — the game auto-starts once
// everyone is ready — but the label frames it as the host's call to make.
function lobbyReadyLabel() {
    return isHost ? 'Start Game' : 'Ready to Play';
}

function resetReadyButtons() {
    btnReadyUp.style.backgroundColor = 'var(--primary)';
    btnReadyUp.textContent = lobbyReadyLabel();
    btnStandingsReady.style.backgroundColor = 'var(--primary)';
    btnStandingsReady.textContent = 'Ready for Next Round';
}

function updateLobbyRoundText() {
    lobbyRoundText.textContent = `Round ${currentRound} of ${maxRounds}`;
    navRoundDisplay.textContent = `Round ${currentRound}/${maxRounds}`;
    roundIndicator.textContent = `Round ${currentRound}/${maxRounds}`;
}

// --- RESULTS PLAYER FILTER ---
// Rows are never re-rendered when the filter changes — only shown/hidden — so an already
// expanded definition (and its cached text) survives switching between players.
let currentResultsFilter = 'all';

function renderResultsFilterBar(playerNames) {
    resultsFilterBar.innerHTML = '';
    resultsFilterBar.classList.toggle('hidden', playerNames.length === 0);
    if (playerNames.length === 0) return;

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'filter-pill active';
    allBtn.dataset.player = 'all';
    allBtn.textContent = 'All';
    resultsFilterBar.appendChild(allBtn);

    playerNames.forEach(name => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'filter-pill';
        btn.dataset.player = name;
        btn.textContent = name === myPlayerName ? `${name} (You)` : name;
        resultsFilterBar.appendChild(btn);
    });
}

function applyResultsFilter(playerName) {
    currentResultsFilter = playerName;

    let anyVisible = false;
    resultsList.querySelectorAll('.result-row').forEach(li => {
        let authors = [];
        try { authors = JSON.parse(li.dataset.authors || '[]'); } catch (e) { /* leave empty */ }
        const show = playerName === 'all' || authors.includes(playerName);
        li.classList.toggle('hidden', !show);
        if (show) anyVisible = true;
    });
    resultsEmptyMsg.classList.toggle('hidden', anyVisible);

    resultsFilterBar.querySelectorAll('.filter-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.player === playerName);
    });
}

if (resultsFilterBar) {
    resultsFilterBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-pill');
        if (btn) applyResultsFilter(btn.dataset.player);
    });
}

// --- WORD LIKES + TOAST ---
// No host gating needed — like submit_words/request_sync, this is a plain room-wide
// broadcast every client both sends and listens for. word: Set<likerName>.
let wordLikes = {};

// Sends only — never touches the DOM itself. The channel already has broadcast:{self:true},
// so the sender gets their own echo back and updateWordLikeUI (called only from the
// listener) is the single code path for both the sender's and everyone else's UI update.
async function toggleWordLike(word, authors) {
    if (!roomChannel) return;
    const likedNow = !!wordLikes[word]?.has(myPlayerName);
    await roomChannel.send({
        type: 'broadcast',
        event: 'word_like',
        payload: { word, authorNames: authors, likerName: myPlayerName, liked: !likedNow }
    });
}

function updateWordLikeUI(word, likerName, liked) {
    if (!wordLikes[word]) wordLikes[word] = new Set();
    if (liked) wordLikes[word].add(likerName);
    else wordLikes[word].delete(likerName);

    const li = [...resultsList.querySelectorAll('.result-row')].find(el => el.dataset.word === word);
    if (!li) return; // a late broadcast for a word no longer on screen — nothing to update
    const heartBtn = li.querySelector('.heart-btn');
    if (!heartBtn) return; // the row's own author has no heart button to update

    const likedByMe = wordLikes[word].has(myPlayerName);
    heartBtn.classList.toggle('liked', likedByMe);
    heartBtn.setAttribute('aria-pressed', likedByMe ? 'true' : 'false');
    heartBtn.title = likedByMe ? 'Unlike this word' : 'Like this word';
    heartBtn.setAttribute('aria-label', heartBtn.title);
    const icon = heartBtn.querySelector('.heart-icon');
    icon.classList.toggle('filled', likedByMe);
    icon.classList.remove('pop');
    if (likedByMe && !prefersReducedMotion()) {
        void icon.offsetWidth;
        icon.classList.add('pop');
    }
}

function showToast(message) {
    const card = document.createElement('div');
    card.className = 'toast-card';
    card.innerHTML = `
        <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>
        <span class="body-strong" style="font-size: 14px;"></span>
    `;
    card.querySelector('span').textContent = message;
    toastStack.appendChild(card);

    setTimeout(() => {
        card.classList.add('leaving');
        setTimeout(() => card.remove(), 220);
    }, 3200);
}

function adjustSelectWidth(select) {
    const tempSpan = document.createElement('span');
    tempSpan.style.visibility = 'hidden';
    tempSpan.style.position = 'absolute';
    tempSpan.style.fontFamily = getComputedStyle(select).fontFamily || 'sans-serif';
    tempSpan.style.fontSize = getComputedStyle(select).fontSize || '11px';
    tempSpan.style.fontWeight = getComputedStyle(select).fontWeight || '600';
    tempSpan.style.textTransform = 'uppercase';
    tempSpan.style.letterSpacing = '0.5px';
    tempSpan.textContent = select.options[select.selectedIndex].text;
    document.body.appendChild(tempSpan);
    const width = tempSpan.getBoundingClientRect().width;
    select.style.width = `${width + 28}px`; // 8px left + 20px right for arrow
    document.body.removeChild(tempSpan);
}

function renderLobbyPlayers(players) {
    lobbyPlayerList.innerHTML = '';
    players.forEach((p, index) => {
        const li = document.createElement('li');
        li.className = `lobby-player-item ${p.isAi ? 'ai-player' : ''} ${p.isDisconnected ? 'reconnecting-player' : ''}`;
        li.style.animationDelay = `${index * 50}ms`;
        
        const readyIndicator = p.isDisconnected
            ? `<span class="ready-indicator reconnecting-indicator" title="Reconnecting"></span>`
            : p.isReady
            ? `<span class="ready-indicator ready" title="Ready"></span>`
            : `<span class="ready-indicator" title="Not Ready"></span>`;
            
        const nameDisplay = p.id === myPlayerId ? `${escapeHtml(p.name)} (You)` : escapeHtml(p.name);
        
        li.innerHTML = `
            <div class="player-info-group">
                <span class="player-name">${nameDisplay}</span>
                ${p.isDisconnected ? '<span class="reconnecting-label">Reconnecting…</span>' : ''}
                ${p.isAi ? (isHost ? `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <select class="ai-difficulty-select-pill" data-ai-id="${escapeHtml(p.id)}">
                        <option value="Easy" ${p.difficulty === 'Easy' ? 'selected' : ''}>Easy</option>
                        <option value="Medium" ${p.difficulty === 'Medium' ? 'selected' : ''}>Medium</option>
                        <option value="Hard" ${p.difficulty === 'Hard' ? 'selected' : ''}>Hard</option>
                    </select>
                    <button class="btn-remove-ai-inline" data-ai-id="${escapeHtml(p.id)}" title="Remove Bot">×</button>
                </div>
                ` : `<span class="ai-badge">${escapeHtml(p.difficulty)}</span>`) : ''}
            </div>

            <div style="display: flex; align-items: center; gap: 12px;">
                <span class="lobby-player-score">${p.score} pts</span>
                <span style="display: flex; align-items: center; justify-content: flex-end; width: 30px;">${readyIndicator}</span>
            </div>
        `;
        lobbyPlayerList.appendChild(li);
    });

    if (isHost) {
        const selects = lobbyPlayerList.querySelectorAll('.ai-difficulty-select-pill');
        selects.forEach(select => {
            adjustSelectWidth(select);

            select.addEventListener('change', async (e) => {
                adjustSelectWidth(select);
                const aiId = select.getAttribute('data-ai-id');
                const newDifficulty = select.value;
                const ai = myLocalAiPlayers.find(bot => bot.id === aiId);
                if (ai) {
                    ai.difficulty = newDifficulty;
                    ai.updatedAt = Date.now();
                    lastKnownAiPlayers = myLocalAiPlayers.map(b => ({ ...b }));
                    saveGameStateToSession();
                    await syncMyState();
                }
            });
        });

        const removeBtns = lobbyPlayerList.querySelectorAll('.btn-remove-ai-inline');
        removeBtns.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const aiId = btn.getAttribute('data-ai-id');
                console.log("Removing bot with ID:", aiId);
                myLocalAiPlayers = myLocalAiPlayers.filter(bot => bot.id !== aiId);
                // Dismissing the bot means opting out, or auto-join would bring it straight back
                aiEnabled = false;
                lastKnownAiPlayers = [];
                syncAiSwitch();
                saveGameStateToSession();
                await syncMyState();
            });
        });
    }
}

const STAT_TIPS = {
    ptsRound: 'Average points earned each round',
    wordsRound: 'Average unique words that scored each round',
    avgRatio: 'Average points per scoring word',
    errorRate: 'Percent of typed attempts that were invalid'
};

function statsGridHtml({ ptsPerRound, wordsPerRound, ptsPerWord, errorRate, borderColor }) {
    return `
            <div class="stats-collapse" style="max-height: 0px; overflow: hidden; opacity: 0; transition: opacity 0.3s var(--ease-out), max-height 0.3s var(--ease-out);">
                <div class="stats-grid" style="border-top: 1px solid ${borderColor};">
                    <div class="stat-cell" tabindex="0" data-tip="${STAT_TIPS.ptsRound}">
                        <div class="body-strong">${ptsPerRound}</div>
                        <div class="caption text-muted">Pts/Round</div>
                    </div>
                    <div class="stat-cell" tabindex="0" data-tip="${STAT_TIPS.wordsRound}">
                        <div class="body-strong">${wordsPerRound}</div>
                        <div class="caption text-muted">Words/Round</div>
                    </div>
                    <div class="stat-cell" tabindex="0" data-tip="${STAT_TIPS.avgRatio}">
                        <div class="body-strong">${ptsPerWord}</div>
                        <div class="caption text-muted">Avg Ratio</div>
                    </div>
                    <div class="stat-cell" tabindex="0" data-tip="${STAT_TIPS.errorRate}">
                        <div class="body-strong">${errorRate}%</div>
                        <div class="caption text-muted">Error Rate</div>
                    </div>
                </div>
            </div>`;
}

function renderStandingsScreen(players, roundsPlayed = currentRound > 1 ? currentRound - 1 : 1) {
    // Name the round these points came from rather than a generic "Current Standings"
    if (standingsTitle) standingsTitle.textContent = `Round ${roundsPlayed} of ${maxRounds}`;

    const sorted = [...players].sort((a, b) => b.score - a.score);
    standingsList.innerHTML = '';

    sorted.forEach((p, index) => {
        const rank = index + 1;
        const div = document.createElement('div');
        div.className = `winner-card ${rank === 1 ? 'rank-1' : ''}`;
        div.style.flexDirection = 'column';
        div.style.alignItems = 'stretch';
        div.style.cursor = 'pointer';

        let rankLabel = rank === 1 ? '1st' : rank === 2 ? '2nd' : rank === 3 ? '3rd' : `${rank}th`;
        const nameDisplay = p.id === myPlayerId ? `${escapeHtml(p.name)} (You)` : escapeHtml(p.name);
        const readyIndicator = p.isReady
            ? `<span class="ready-indicator ready" title="Ready"></span>`
            : `<span class="ready-indicator" title="Not Ready"></span>`;

        const tWords = p.totalWords || 0;
        const ptsPerRound = (p.score / roundsPlayed).toFixed(1);
        const wordsPerRound = (tWords / roundsPlayed).toFixed(1);
        const ptsPerWord = tWords > 0 ? (p.score / tWords).toFixed(1) : "0.0";
        // Bots never call attemptSubmitWord (their words are host-generated), so they
        // naturally read as 0/0 here — same "0.0"-not-a-placeholder convention as ptsPerWord.
        const pAttempts = p.wordAttempts || 0;
        const pErrors = p.wordErrors || 0;
        const errorRate = pAttempts > 0 ? ((pErrors / pAttempts) * 100).toFixed(0) : "0";
        const borderColor = rank === 1 ? 'rgba(0,102,204,0.15)' : 'var(--hairline)';

        div.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                <div style="display: flex; align-items: center;">
                    <span class="caption-strong rank-text" style="margin-right: 12px;">${rankLabel}</span>
                    <span class="body-strong">${nameDisplay}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 16px;">
                    <span style="display: flex; align-items: center; justify-content: flex-end; min-width: 30px;">${readyIndicator}</span>
                    <span class="display-md" style="min-width: 60px; text-align: right;">${p.score}</span>
                    <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px; transition: transform 0.3s var(--ease-out); opacity: 0.5;">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </div>
            </div>
            ${statsGridHtml({ ptsPerRound, wordsPerRound, ptsPerWord, errorRate, borderColor })}
        `;

        div.addEventListener('click', () => {
            const collapse = div.querySelector('.stats-collapse');
            const chevron = div.querySelector('.chevron');
            const isExpanded = collapse.style.maxHeight !== '0px';
            
            if (isExpanded) {
                collapse.style.maxHeight = '0px';
                collapse.style.opacity = '0';
                collapse.style.overflow = 'hidden';
                chevron.style.transform = 'rotate(0deg)';
            } else {
                collapse.style.maxHeight = '180px';
                collapse.style.opacity = '1';
                collapse.style.overflow = 'visible';
                chevron.style.transform = 'rotate(180deg)';
            }
        });

        standingsList.appendChild(div);
    });
}

function renderWinnerScreen(players, roundsPlayed = maxRounds) {
    hideOverlay(screenResults);
    showOverlay(screenWinner);

    const sorted = [...players].sort((a, b) => b.score - a.score);
    winnerList.innerHTML = '';

    sorted.forEach((p, index) => {
        const rank = index + 1;
        const div = document.createElement('div');
        div.className = `winner-card ${rank === 1 ? 'rank-1' : ''}`;
        div.style.flexDirection = 'column';
        div.style.alignItems = 'stretch';
        div.style.cursor = 'pointer';

        let rankLabel = rank === 1 ? '1st' : rank === 2 ? '2nd' : rank === 3 ? '3rd' : `${rank}th`;
        const nameDisplay = p.id === myPlayerId ? `${escapeHtml(p.name)} (You)` : escapeHtml(p.name);

        const tWords = p.totalWords || 0;
        const ptsPerRound = (p.score / roundsPlayed).toFixed(1);
        const wordsPerRound = (tWords / roundsPlayed).toFixed(1);
        const ptsPerWord = tWords > 0 ? (p.score / tWords).toFixed(1) : "0.0";
        // Bots never call attemptSubmitWord (their words are host-generated), so they
        // naturally read as 0/0 here — same "0.0"-not-a-placeholder convention as ptsPerWord.
        const pAttempts = p.wordAttempts || 0;
        const pErrors = p.wordErrors || 0;
        const errorRate = pAttempts > 0 ? ((pErrors / pAttempts) * 100).toFixed(0) : "0";
        const borderColor = rank === 1 ? 'rgba(0,102,204,0.15)' : 'var(--hairline)';

        div.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                <div style="display: flex; align-items: center;">
                    <span class="caption-strong rank-text" style="margin-right: 12px;">${rankLabel}</span>
                    <span class="body-strong">${nameDisplay}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 16px;">
                    <span class="display-md" style="text-align: right;">${p.score} <span class="caption text-muted">pts</span></span>
                    <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px; transition: transform 0.3s var(--ease-out); opacity: 0.5;">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </div>
            </div>
            ${statsGridHtml({ ptsPerRound, wordsPerRound, ptsPerWord, errorRate, borderColor })}
        `;
        
        div.addEventListener('click', () => {
            const collapse = div.querySelector('.stats-collapse');
            const chevron = div.querySelector('.chevron');
            const isExpanded = collapse.style.maxHeight !== '0px';
            
            if (isExpanded) {
                collapse.style.maxHeight = '0px';
                collapse.style.opacity = '0';
                collapse.style.overflow = 'hidden';
                chevron.style.transform = 'rotate(0deg)';
            } else {
                collapse.style.maxHeight = '180px';
                collapse.style.opacity = '1';
                collapse.style.overflow = 'visible';
                chevron.style.transform = 'rotate(180deg)';
            }
        });

        winnerList.appendChild(div);
    });

    if (isHost) {
        btnPlayAgain.classList.remove('hidden');
        guestWaitingMsg.classList.add('hidden');
    } else {
        btnPlayAgain.classList.add('hidden');
        guestWaitingMsg.classList.remove('hidden');
    }
}

function playCountdownFlicker() {
    const host = document.getElementById('countdown-flicker');
    if (!host || prefersReducedMotion()) return;

    const mount = (svg) => {
        host.innerHTML = svg;
    };

    if (countdownFlickerMarkup) {
        mount(countdownFlickerMarkup);
        return;
    }

    fetch('flicker-countdown.svg')
        .then((r) => (r.ok ? r.text() : Promise.reject()))
        .then((svg) => {
            countdownFlickerMarkup = svg;
            if (screenCountdown.classList.contains('active')) mount(svg);
        })
        .catch(() => {});
}

function paintCountdownCount(count) {
    if (!countdownTimer) return;
    countdownTimer.textContent = String(count);
    if (!prefersReducedMotion()) return;
    countdownTimer.classList.remove('animate-pop');
    void countdownTimer.offsetWidth;
    countdownTimer.classList.add('animate-pop');
}

// --- COUNTDOWN SEQUENCE ---
function startCountdown() {
    // Held at module scope so leaving the room can cancel a countdown in flight —
    // otherwise it fires initRound() on a player who has already gone home.
    clearInterval(countdownInterval);

    document.body.classList.add('counting-down');
    if (countdownRound) countdownRound.textContent = `ROUND ${currentRound} OF ${maxRounds}`;
    showOverlay(screenCountdown);
    playCountdownFlicker();
    let count = 5;
    paintCountdownCount(count);

    countdownInterval = setInterval(() => {
        count--;
        if (count > 0) {
            paintCountdownCount(count);
        } else {
            clearInterval(countdownInterval);
            countdownInterval = null;
            document.body.classList.remove('counting-down');
            hideOverlay(screenCountdown);
            initRound();
        }
    }, 1000);
}

// ============================================================================
// GUIDED TUTORIAL
// Runs on the real game chassis with the network untouched: no room, no channel, no
// session writes. isTutorial gates every path that would otherwise reach for roomChannel.
// ============================================================================

let isTutorial = false;
let coachStep = 0;
let coachOnFinalStep = false;

// Hand-picked so the hint words are guaranteed to be spellable from the pool.
// RAIN, STAIN, TRAIN, BRAIN, GRAIN, CLIMB... all live in here.
const TUTORIAL_BOARD = ['R', 'A', 'I', 'N', 'S', 'T', 'B', 'E', 'L', 'O', 'C', 'D', 'M', 'P', 'U', 'G'];
const TUTORIAL_BOT = 'Messi_42';
const TUTORIAL_HINT = 'RAIN';

const coachLayer = document.getElementById('coach-layer');
const coachSpotlight = document.getElementById('coach-spotlight');
const coachTip = document.getElementById('coach-tip');
const coachCount = document.getElementById('coach-count');
const coachTitle = document.getElementById('coach-title');
const coachText = document.getElementById('coach-text');
const btnCoachNext = document.getElementById('btn-coach-next');
const btnCoachSkip = document.getElementById('btn-coach-skip');

const COACH_STEPS = [
    {
        target: '#board',
        title: 'The board',
        text: 'Every player gets these same 16 letters. Build words out of them — each letter can only be used as often as it appears here.'
    },
    {
        target: '.timer-block',
        title: 'The clock',
        text: 'A round lasts 60 seconds. It is paused right now so you can take your time reading.'
    },
    {
        target: '.input-cluster',
        title: 'Find your first word',
        text: `Words need at least 4 letters. Type ${TUTORIAL_HINT} — or tap the letters on the board — then press the arrow.`,
        hint: TUTORIAL_HINT,
        awaitWord: true // no Next button: the learner advances by actually doing it
    },
    {
        target: '.draft-container',
        title: 'Your words land here',
        text: 'Each word scores 1 point per letter, so longer finds pay more. No simple plurals though — RAINS would not count.'
    },
    {
        target: '.floating-sticky-bar',
        title: 'Your score',
        text: 'Your running total for the game. "Lock In Early" ends your round before the clock does.'
    }
];

function setCoachVisible(visible) {
    coachLayer.classList.toggle('active', visible);
}

// Anchors the spotlight to the live element and parks the tip clear of it
function positionCoach(target) {
    const el = document.querySelector(target);
    if (!el) return;

    const r = el.getBoundingClientRect();
    const pad = 8;
    coachSpotlight.style.top = `${r.top - pad}px`;
    coachSpotlight.style.left = `${r.left - pad}px`;
    coachSpotlight.style.width = `${r.width + pad * 2}px`;
    coachSpotlight.style.height = `${r.height + pad * 2}px`;

    // Prefer below the target; flip above when there isn't room
    const tipH = coachTip.offsetHeight || 160;
    const tipW = coachTip.offsetWidth || 290;
    let top = r.bottom + 16;
    if (top + tipH > window.innerHeight - 8) top = Math.max(8, r.top - tipH - 16);

    let left = r.left + r.width / 2 - tipW / 2;
    left = Math.max(16, Math.min(left, window.innerWidth - tipW - 16));

    coachTip.style.top = `${top}px`;
    coachTip.style.left = `${left}px`;
}

function showCoachStep(i) {
    coachStep = i;
    const step = COACH_STEPS[i];
    if (!step) return finishTutorialToDemo();

    coachCount.textContent = `${i + 1} / ${COACH_STEPS.length + 1}`;
    coachTitle.textContent = step.title;
    coachText.textContent = step.text;

    // On the do-it step there is no way forward except doing it
    btnCoachNext.classList.toggle('hidden', !!step.awaitWord);

    if (step.hint) {
        wordInput.placeholder = `Try: ${step.hint}`;
        wordInput.focus();
    } else {
        wordInput.placeholder = 'Spell something';
    }

    setCoachVisible(true);
    positionCoach(step.target);
    // Re-measure once the tip has its real height
    requestAnimationFrame(() => positionCoach(step.target));
}

function startTutorial() {
    isTutorial = true;
    coachStep = 0;
    // Reset the button the demo step repurposed, or a second run starts already "finished"
    coachOnFinalStep = false;
    btnCoachNext.textContent = 'Next';

    hideOverlay(screenBoot);
    hideJoinStatus();

    // Dress the chassis as a believable round without touching the network or session
    boardLetters = TUTORIAL_BOARD.slice();
    draftedWords = [];
    myTotalScore = 0;
    myTotalWords = 0;
    // Belt-and-suspenders: the increment guard in attemptSubmitWord already stops tutorial
    // fumbles from touching these, but reset for symmetry with score/totalWords above.
    wordAttempts = 0;
    wordErrors = 0;
    timeLeft = 60;
    isPlaying = true; // lets the input and tiles respond; every network path checks isTutorial

    fitGameLayout();
    navRoomDisplay.textContent = 'Room: DEMO';
    navRoundDisplay.textContent = 'Tutorial';
    roundIndicator.textContent = 'Tutorial';
    timerDisplay.textContent = '01:00'; // deliberately never started
    timerDisplay.style.color = 'var(--ink)';
    totalScoreDisplay.textContent = 'Total: 0 pts';
    roundScoreDisplay.textContent = 'Drafted: 0 words';
    draftList.innerHTML = '';

    initPhysics();
    paintBoard();

    wordInput.disabled = false;
    wordInput.value = '';
    sendBtn.disabled = true;
    btnShuffle.disabled = true; // shuffling would invalidate the hint word

    showCoachStep(0);
}

function endTutorial() {
    isTutorial = false;
    isPlaying = false;
    setCoachVisible(false);

    draftedWords = [];
    boardLetters = [];
    tiles.forEach(t => { t.textContent = ''; t.onclick = null; });
    draftList.innerHTML = '';
    wordInput.value = '';
    wordInput.placeholder = 'Spell something';
    wordInput.disabled = true;
    sendBtn.disabled = true;

    if (physicsAnimId) {
        cancelAnimationFrame(physicsAnimId);
        physicsAnimId = null;
    }
    if (typeof Matter !== 'undefined' && physicsEngine) {
        Matter.World.clear(physicsWorld);
        Matter.Engine.clear(physicsEngine);
    }
    physicsEngine = null;
    physicsWorld = null;
    physicsWordBodies = [];

    navRoomDisplay.textContent = 'Room: ----';
    navRoundDisplay.textContent = 'Round 1';
    roundIndicator.textContent = 'Round 1';
    totalScoreDisplay.textContent = 'Total: 0 pts';
    roundScoreDisplay.textContent = 'Drafted: 0 words';

    hideOverlay(screenResults);
    showOverlay(screenBoot);
}

// The payoff: the learner's own word, cancelled by a bot that found the same thing.
// Uses the real results screen so they also learn where results appear.
function finishTutorialToDemo() {
    setCoachVisible(false);

    const mine = draftedWords[0] || TUTORIAL_HINT;
    const demo = [
        { word: mine, authors: ['You', TUTORIAL_BOT], isDuplicate: true, points: 0 },
        { word: 'CLIMB', authors: [TUTORIAL_BOT], isDuplicate: false, points: 5 }
    ];

    resultsTitle.textContent = 'Tutorial Results';
    resultsList.innerHTML = '';
    demo.forEach(res => {
        const li = document.createElement('li');
        li.className = `result-row ${res.isDuplicate ? 'duplicate-word' : 'unique-word'}`;
        li.innerHTML = `
            <div style="display:flex; flex-direction:column;">
                <span class="result-word">${res.word}</span>
                <span class="caption result-authors">${res.authors.join(', ')}</span>
            </div>
            <span class="result-points">${res.isDuplicate ? 'CANCELLED' : `+${res.points} pts`}</span>
        `;
        resultsList.appendChild(li);
    });

    idlePrompt.classList.add('hidden');
    // The demo has no real roster to filter, and no meanings wired up — keep it simple
    resultsFilterBar.classList.add('hidden');
    resultsFilterBar.innerHTML = '';
    resultsEmptyMsg.classList.add('hidden');
    btnNextRound.textContent = 'Finish tutorial';
    btnNextRound.onclick = endTutorial;
    showOverlay(screenResults);

    // Coach the punchline over the real results screen
    coachCount.textContent = `${COACH_STEPS.length + 1} / ${COACH_STEPS.length + 1}`;
    coachTitle.textContent = 'The catch';
    coachText.textContent = `${TUTORIAL_BOT} found ${mine} too — so it cancels and you both score zero. The whole game is finding words nobody else will.`;
    coachOnFinalStep = true;
    btnCoachNext.classList.remove('hidden');
    btnCoachNext.textContent = 'Got it';

    setCoachVisible(true);
    requestAnimationFrame(() => positionCoach('#results-list'));
}

// Called when a word is accepted while the tutorial is waiting for one
function tutorialWordAccepted() {
    const step = COACH_STEPS[coachStep];
    if (!step || !step.awaitWord) return;
    wordInput.placeholder = 'Spell something';
    setTimeout(() => showCoachStep(coachStep + 1), 450); // let them see the word land
}

if (btnCoachNext) {
    btnCoachNext.addEventListener('click', () => {
        if (coachOnFinalStep) endTutorial();
        else showCoachStep(coachStep + 1);
    });
}
if (btnCoachSkip) btnCoachSkip.addEventListener('click', endTutorial);

// Coach marks are pinned to live rects, so they must follow the layout
window.addEventListener('resize', () => {
    if (!isTutorial || !coachLayer.classList.contains('active')) return;
    const step = COACH_STEPS[coachStep];
    positionCoach(step ? step.target : '#results-list');
});

// Paints the 16 faces and wires them to the input. Shared by a real round and the guided
// tutorial so the tutorial teaches the actual board, not a replica of it.
function paintBoard() {
    tiles.forEach((tile, index) => {
        const letter = boardLetters[index];
        tile.textContent = letter;

        tile.onclick = () => {
            if (isPlaying) { // (Removed penaltyActive check here since we deleted it)
                // Tiles mutate the value directly, so no 'input' event fires to clear this
                clearFieldError(wordInput);
                wordInput.value += letter;
                sendBtn.disabled = wordInput.value.trim().length < 4;
                wordInput.focus();
            }
        };
    });
}

// --- CORE LOOP ---
function initRound(syncedTime = null) {
    if (syncedTime !== null) {
        timeLeft = syncedTime;
    } else {
        timeLeft = secondsPerRound;
    }

    const cacheKey = `wordperfect_drafted_${myRoomCode}_round_${currentRound}`;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
        try {
            draftedWords = JSON.parse(cached);
        } catch (e) {
            draftedWords = [];
        }
    } else {
        draftedWords = [];
    }

    isPlaying = true;
    saveGameStateToSession();

    fitGameLayout();
    initPhysics();

    draftList.innerHTML = '';
    roundScoreDisplay.textContent = `Drafted: ${draftedWords.length} words`;
    btnShuffle.disabled = false;
    updateLobbyRoundText();

    // Populate with cached words staggered vertically
    if (draftedWords.length > 0) {
        if (typeof Matter !== 'undefined' && physicsWorld) {
            for (let i = draftedWords.length - 1; i >= 0; i--) {
                const staggerIndex = (draftedWords.length - 1) - i;
                addWordToPhysics(draftedWords[i], staggerIndex);
            }
        } else {
            const fallbackList = document.getElementById('drafted-words');
            if (fallbackList) {
                fallbackList.innerHTML = '';
                for (let i = draftedWords.length - 1; i >= 0; i--) {
                    const li = document.createElement('li');
                    li.className = 'draft-item body-strong';
                    li.textContent = draftedWords[i];
                    li.dataset.word = draftedWords[i];
                    fallbackList.prepend(li);
                }
            }
        }
    }

    wordInput.disabled = false;
    wordInput.value = '';
    sendBtn.disabled = true;
    wordInput.focus();
    timerDisplay.style.color = 'var(--ink)';

    paintBoard();
    startClock();
}

function startClock() {
    clearInterval(timerInterval);
    const paintClock = () => {
        const m = Math.floor(Math.max(timeLeft, 0) / 60).toString().padStart(2, '0');
        const s = (Math.max(timeLeft, 0) % 60).toString().padStart(2, '0');
        timerDisplay.textContent = `${m}:${s}`;
        if (timeLeft <= 10 && timeLeft > 0) {
            timerDisplay.style.color = 'var(--danger)';
        }
        sessionStorage.setItem('wordperfect_time_left', timeLeft.toString());
    };

    paintClock(); // show the full starting second immediately (no off-by-one first paint)
    timerInterval = setInterval(() => {
        timeLeft--;
        paintClock();
        if (timeLeft <= 0) {
            endRound();
        }
    }, 1000);
}

async function endRound() {
    if (!roomChannel || isTutorial) return;

    clearInterval(timerInterval);
    if (isPlaying && wordInput.value.trim().length >= 4) {
        attemptSubmitWord(wordInput.value);
    }

    isPlaying = false;
    saveGameStateToSession();

    // Clear the cached draft words for this round since it's completed
    const cacheKey = `wordperfect_drafted_${myRoomCode}_round_${currentRound}`;
    sessionStorage.removeItem(cacheKey);

    wordInput.disabled = true;
    sendBtn.disabled = true;
    btnShuffle.disabled = true;
    timerDisplay.textContent = "00:00";
    wordInput.value = '';

    actionBtn.textContent = 'Calculating...';

    if (isHost) {
        disconnectedSeats.forEach(seat => {
            hostSubmissions[seat.id] = sanitizeSubmittedWords(seat.draftedWords || []);
        });
    }

    // Broadcast drafted words for the host to process
    await roomChannel.send({
        type: 'broadcast',
        event: 'submit_words',
        payload: { playerId: myPlayerId, words: draftedWords }
    });

    // Safety net: a client that freezes (backgrounded mobile tab) keeps its presence but
    // never reports, so presence changes alone can't rescue the round. Close it anyway.
    if (isHost) {
        clearTimeout(finalizeWatchdog);
        finalizeWatchdog = setTimeout(() => {
            console.warn("Finalize watchdog fired - closing round without every submission.");
            finalizeRound();
        }, 10000);
    }
}

actionBtn.addEventListener('click', () => {
    if (isTutorial) return; // no round to lock in, and endRound() would hit a null channel
    if (isPlaying) endRound();
});

// --- VALIDATION ENGINE ---
function isWordInGrid(word) {
    if (!word) return false;
    let availablePool = [...boardLetters];
    for (let i = 0; i < word.length; i++) {
        const char = word[i];
        const indexInPool = availablePool.indexOf(char);
        if (indexInPool !== -1) {
            availablePool.splice(indexInPool, 1);
        } else {
            return false;
        }
    }
    return true;
}

function isPlural(word) {
    if (!word.endsWith('S')) return false;
    if (word.endsWith('SS') || word.endsWith('US') || word.endsWith('IS') || word.endsWith('OS') || word.endsWith('AS')) return false;
    const baseS = word.slice(0, -1);
    if (dictionarySet.has(baseS)) return true;
    if (word.endsWith('ES')) {
        const baseES = word.slice(0, -2);
        if (dictionarySet.has(baseES)) return true;
    }
    if (word.endsWith('IES')) {
        const baseIES = word.slice(0, -3) + 'Y';
        if (dictionarySet.has(baseIES)) return true;
    }
    return false;
}

// --- WORD DEFINITIONS (lazy, decoupled from validation) ---
// Deliberately separate from dictionarySet: validation must stay an instant, offline
// Set.has() lookup so submissions keep feeling realtime. Meanings are a rarely-used,
// per-word extra, so they are fetched only when a player actually taps a word, and cached
// so each word is looked up at most once per session (including a "not found" result).
const definitionCache = new Map();

// Wiktionary first: measured against the actual validation wordlist, a random sample of
// obscure-but-real words hit the Free Dictionary API at only ~48% (it's a small curated
// snapshot; many valid words here are auto-generated inflections with no lemma entry of
// their own). Wiktionary recovered ~96% of the same sample, so it goes first and the Free
// Dictionary API becomes a resilience fallback rather than the primary source.
async function fetchDefinition(word) {
    const key = word.toUpperCase();
    if (definitionCache.has(key)) return definitionCache.get(key);

    const meaning = (await fetchFromWiktionary(word)) || (await fetchFromDictionaryApi(word));
    definitionCache.set(key, meaning); // cache the miss too, so a bad word isn't refetched
    return meaning;
}

async function fetchFromWiktionary(word) {
    try {
        const res = await fetch(
            `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word.toLowerCase())}`,
            { headers: { 'Api-User-Agent': 'WordPerfectGame/1.0' } } // 'Api-User-Agent', not 'User-Agent' — browsers silently block scripts from setting the latter
        );
        if (!res.ok) return null;
        const data = await res.json();
        const entry = data?.en?.[0]; // Wiktionary nests definitions by language; English only
        const def = entry?.definitions?.[0]?.definition;
        if (!def) return null;
        const clean = stripHtml(def); // definitions carry embedded <a href="/wiki/...">links</a>
        return entry.partOfSpeech ? `(${entry.partOfSpeech.toLowerCase()}) ${clean}` : clean;
    } catch (e) {
        console.warn('Wiktionary lookup failed for', word, e);
        return null;
    }
}

async function fetchFromDictionaryApi(word) {
    try {
        const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`);
        if (!res.ok) return null;
        const data = await res.json();
        const entry = data?.[0]?.meanings?.[0];
        const def = entry?.definitions?.[0]?.definition;
        if (!def) return null;
        return entry.partOfSpeech ? `(${entry.partOfSpeech}) ${def}` : def;
    } catch (e) {
        console.warn('Dictionary API lookup failed for', word, e);
        return null;
    }
}

// Detached element: nothing is inserted into the document and nothing executes, this is
// just the standard safe trick for turning a definition's embedded HTML into plain text.
function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || '';
}

// Expand/collapse a results row and lazy-load its meaning on first open. Mirrors the
// max-height/opacity collapse pattern already used by the standings and winner cards.
async function toggleResultDefinition(li, word) {
    const collapse = li.querySelector('.def-collapse');
    const chevron = li.querySelector('.chevron');
    const defText = li.querySelector('.def-text');
    const isExpanded = collapse.style.maxHeight !== '0px' && collapse.style.maxHeight !== '';

    if (isExpanded) {
        collapse.style.maxHeight = '0px';
        collapse.style.opacity = '0';
        if (chevron) chevron.style.transform = 'rotate(0deg)';
        return;
    }

    collapse.style.maxHeight = '140px';
    collapse.style.opacity = '1';
    if (chevron) chevron.style.transform = 'rotate(180deg)';

    // dataset.loaded is set synchronously before the await, so a second tap while the
    // fetch is still in flight sees it immediately and does not fire a duplicate request.
    if (defText.dataset.loaded) return;
    defText.dataset.loaded = 'pending';
    defText.textContent = 'Looking up…';
    const meaning = await fetchDefinition(word);
    defText.textContent = meaning || 'Meaning unavailable.';
    defText.dataset.loaded = 'done';
}

// Surfaces a failure reason inside the offending field itself: shake it, clear it,
// and borrow the placeholder to say what went wrong.
// keepValue leaves what the user typed intact — used when the entry may well be correct
// and only the world is wrong (e.g. the room isn't there yet), so the reason has to be
// carried by something other than the placeholder.
function flashFieldError(inputEl, reason, duration = 1600, { keepValue = false } = {}) {
    if (inputEl.errorTimer) {
        clearTimeout(inputEl.errorTimer);
    } else {
        // Only capture on the first flash, otherwise we'd restore a stale error message
        inputEl.dataset.restorePlaceholder = inputEl.placeholder;
    }

    // Re-trigger the shake animation even if it is already running
    inputEl.classList.remove('input-error');
    void inputEl.offsetWidth;
    inputEl.classList.add('input-error');

    if (!keepValue) inputEl.value = '';
    inputEl.placeholder = reason;
    inputEl.focus();

    inputEl.errorTimer = setTimeout(() => {
        inputEl.classList.remove('input-error');
        inputEl.placeholder = inputEl.dataset.restorePlaceholder;
        inputEl.errorTimer = null;
    }, duration);
}

// Once the user starts fixing a field, its complaint is stale — drop it immediately
// so a corrected field never sits there still flagged as wrong.
function clearFieldError(inputEl) {
    if (!inputEl.errorTimer) return;
    clearTimeout(inputEl.errorTimer);
    inputEl.errorTimer = null;
    inputEl.classList.remove('input-error');
    inputEl.placeholder = inputEl.dataset.restorePlaceholder;
}

function rejectInput(reason) {
    flashFieldError(wordInput, reason, 1000);
    sendBtn.disabled = true;
}

function attemptSubmitWord(rawWord) {
    const newWord = rawWord.trim().toUpperCase();
    console.log("Attempting to submit:", newWord);

    // Route failures to specific error messages and logs
    if (newWord.length < 4) {
        console.log("❌ Failed: Too short");
        rejectInput("Too short!");
        return false;
    }
    if (draftedWords.includes(newWord)) {
        console.log("❌ Failed: Already drafted");
        rejectInput("Already drafted!");
        return false;
    }
    if (!isWordInGrid(newWord)) {
        console.log("❌ Failed: Not in grid. Current board is:", boardLetters);
        rejectInput("Letters not on board!");
        // A genuine wrong guess about the board — counts toward the error rate. The
        // tutorial reuses this exact function on a real board, so a learner's fumble must
        // not silently pollute their real game's stats once they leave it.
        if (!isTutorial) { wordAttempts++; wordErrors++; }
        return false;
    }
    if (!dictionarySet.has(newWord)) {
        console.log("❌ Failed: Not in dictionary. Dict size:", dictionarySet.size);
        rejectInput("Not a valid word!");
        if (!isTutorial) { wordAttempts++; wordErrors++; }
        return false;
    }
    if (isPlural(newWord)) {
        console.log("❌ Failed: Plural rule");
        rejectInput("No basic plurals!");
        if (!isTutorial) { wordAttempts++; wordErrors++; }
        return false;
    }

    console.log("✅ Success! Adding to draft.");
    clearFieldError(wordInput); // a win retires any complaint still on screen
    if (!isTutorial) wordAttempts++;
    draftedWords.unshift(newWord);

    // Save update to sessionStorage
    const cacheKey = `wordperfect_drafted_${myRoomCode}_round_${currentRound}`;
    sessionStorage.setItem(cacheKey, JSON.stringify(draftedWords));
    if (!isTutorial && roomChannel) {
        roomChannel.send({
            type: 'broadcast',
            event: 'draft_snapshot',
            payload: {
                playerId: myPlayerId,
                round: currentRound,
                words: draftedWords
            }
        });
    }

    if (typeof Matter !== 'undefined' && physicsWorld) {
        addWordToPhysics(newWord);
    } else {
        const li = document.createElement('li');
        li.className = 'draft-item body-strong';
        li.textContent = newWord;
        li.dataset.word = newWord; // lets the delayed score popup find this row again
        draftList.prepend(li);
    }
    scheduleScorePopup(newWord, scoreWord(newWord));

    roundScoreDisplay.textContent = `Drafted: ${draftedWords.length} words`;

    wordInput.value = '';
    sendBtn.disabled = true;
    return true;
}

// --- DRAFTING MECHANICS ---
wordInput.addEventListener('input', () => {
    sendBtn.disabled = wordInput.value.trim().length < 4;
});

// Prevent iOS scroll panning when keyboard opens
wordInput.addEventListener('focus', () => {
    setTimeout(() => window.scrollTo(0, 0), 50);
});

if (window.visualViewport) {
    document.body.style.height = window.visualViewport.height + 'px';
}

wordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    console.log("Submit triggered. isPlaying state:", isPlaying);

    if (!isPlaying) {
        console.log("🚫 Blocked: Game thinks we are not playing.");
        return;
    }

    const success = attemptSubmitWord(wordInput.value);
    if (success) {
        sendBtn.classList.add('sending');
        setTimeout(() => {
            sendBtn.classList.remove('sending');
        }, 400);
        wordInput.focus();
        if (isTutorial) tutorialWordAccepted();
    }
});
// --- DRAFTING MECHANICS ---

// --- HONEST FRICTION ---
document.addEventListener("visibilitychange", () => {
    if (isTutorial) return; // nobody to cheat against while learning
    if (!isPlaying) return;
    if (document.hidden) {
        clearInterval(penaltyInterval);
        if (!penaltyActive) {
            penaltyActive = true;
            penaltyTimeLeft = 5;
            document.body.classList.add('penalized');
            showOverlay(penaltyModal);
        }
        penStatus.textContent = 'Waiting for you to return...';
        penTimerEl.classList.add('hidden');
        wordInput.blur();
    } else {
        if (penaltyActive) {
            penStatus.textContent = 'Penalty active.';
            penTimerEl.classList.remove('hidden');
            penTimerEl.textContent = penaltyTimeLeft;

            penaltyInterval = setInterval(() => {
                penaltyTimeLeft--;
                penTimerEl.textContent = penaltyTimeLeft;

                if (penaltyTimeLeft <= 0) {
                    clearInterval(penaltyInterval);
                    penaltyActive = false;
                    document.body.classList.remove('penalized');
                    hideOverlay(penaltyModal);
                    if (isPlaying) wordInput.focus();
                }
            }, 1000);
        }
    }
});
// --- PHYSICS ENGINE INTEGRATION ---
function initPhysics() {
    const canvas = document.getElementById('physics-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const container = canvas.parentElement;

    // Reset loop & engine if already running
    if (physicsAnimId) {
        cancelAnimationFrame(physicsAnimId);
        physicsAnimId = null;
    }

    // Tumbling, bouncing words are a strong vestibular trigger, so reduced motion takes
    // the same static list mobile already uses rather than a special case of its own.
    if (typeof Matter === 'undefined' || window.innerWidth <= 768 || prefersReducedMotion()) {
        // Drop any world left from a previous round. Without this, physicsWorld stays
        // truthy and attemptSubmitWord() keeps feeding pills into a hidden canvas while
        // the fallback list sits empty — reachable now that a preference can flip mid-game.
        if (typeof Matter !== 'undefined' && physicsEngine) {
            Matter.World.clear(physicsWorld);
            Matter.Engine.clear(physicsEngine);
        }
        physicsEngine = null;
        physicsWorld = null;
        physicsWordBodies = [];
        physicsLayoutSize = '';

        // Hide canvas and show fallback DOM list
        canvas.classList.add('hidden');
        const fallbackList = document.getElementById('drafted-words');
        if (fallbackList) {
            fallbackList.classList.remove('hidden');
            fallbackList.innerHTML = '';
        }
        return;
    }

    // Hide fallback and show canvas
    canvas.classList.remove('hidden');
    const fallbackList = document.getElementById('drafted-words');
    if (fallbackList) fallbackList.classList.add('hidden');

    // Measure the canvas's laid-out box (not the padded container) so the floor
    // lines up with the visible bottom of the gravity box.
    const width = Math.max(1, canvas.clientWidth || container.clientWidth);
    const height = Math.max(1, canvas.clientHeight || container.clientHeight);
    physicsLayoutSize = `${Math.round(width)}x${Math.round(height)}`;
    
    // Scale for high-DPI screens — setTransform avoids compounding on re-init
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const Engine = Matter.Engine,
          World = Matter.World,
          Bodies = Matter.Bodies;

    physicsEngine = Engine.create();
    physicsWorld = physicsEngine.world;
    physicsWorld.gravity.y = 0.34; // slightly softer than before (was 0.5)

    // Floor top sits a few px inside the canvas so pills rest fully in-frame
    const floorThickness = 48;
    const floorTop = height - 8;
    const floor = Bodies.rectangle(width / 2, floorTop + floorThickness / 2, width + 80, floorThickness, { isStatic: true });
    const leftWall = Bodies.rectangle(-20, height / 2, 40, height + 100, { isStatic: true });
    const rightWall = Bodies.rectangle(width + 20, height / 2, 40, height + 100, { isStatic: true });

    World.add(physicsWorld, [floor, leftWall, rightWall]);
    physicsWordBodies = [];
    scorePopups = [];

    // Animation frame render loop
    function updatePhysicsFrame() {
        if (!physicsEngine) return;
        Engine.update(physicsEngine, 16.666); // 60fps simulation step

        ctx.clearRect(0, 0, width, height);

        // Render each pill body
        physicsWordBodies.forEach(body => {
            drawPill(ctx, body.position.x, body.position.y, body.pillWidth, body.pillHeight, body.angle, body.wordText);
        });

        // Score popups float on top of the pills, independent of the physics simulation
        const now = performance.now();
        scorePopups = scorePopups.filter(p => now - p.bornAt < SCORE_POPUP_LIFETIME_MS);
        scorePopups.forEach(p => drawScorePopup(ctx, p, now));

        physicsAnimId = requestAnimationFrame(updatePhysicsFrame);
    }
    updatePhysicsFrame();
}

// The desktop layout can change after fonts load, browser chrome moves, or the window
// resizes. Rebuild the boundaries only when the gravity box's rendered size changed;
// otherwise Matter keeps using a stale floor while the canvas paints at its new size.
function schedulePhysicsLayoutRefresh() {
    if (!physicsEngine || !isPlaying || window.innerWidth <= 768) return;

    const canvas = document.getElementById('physics-canvas');
    if (!canvas || canvas.classList.contains('hidden')) return;

    const nextSize = `${Math.round(canvas.clientWidth)}x${Math.round(canvas.clientHeight)}`;
    if (nextSize === physicsLayoutSize || nextSize === '0x0') return;

    clearTimeout(physicsResizeTimer);
    physicsResizeTimer = setTimeout(() => {
        physicsResizeTimer = null;
        const wordsToRestore = [...draftedWords];
        initPhysics();

        for (let i = wordsToRestore.length - 1; i >= 0; i--) {
            const staggerIndex = (wordsToRestore.length - 1) - i;
            addWordToPhysics(wordsToRestore[i], staggerIndex);
        }
    }, 120);
}

const gravityBox = document.querySelector('.draft-container');
if (gravityBox && typeof ResizeObserver !== 'undefined') {
    const gravityBoxObserver = new ResizeObserver(schedulePhysicsLayoutRefresh);
    gravityBoxObserver.observe(gravityBox);
}

function clampNum(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function viewportSize() {
    const vv = window.visualViewport;
    return {
        w: vv ? vv.width : window.innerWidth,
        h: vv ? vv.height : window.innerHeight
    };
}

function applyViewportHeight() {
    if (window.visualViewport) {
        document.body.style.height = window.visualViewport.height + 'px';
        window.scrollTo(0, 0);
    }
}

// Size the square board and gravity box from the live viewport so ultrawide,
// squat laptop, and tall-phone layouts all use the space they actually have.
function fitGameLayout() {
    const { w: vw, h: vh } = viewportSize();
    const root = document.documentElement;
    const isMobile = vw <= 768;
    const isLandscapePhone = isMobile && vh <= 650;

    if (!isMobile) {
        const navH = 48;
        const pad = clampNum(vw * 0.04, 16, 48);
        const padBottom = 88;
        const gap = pad;
        const availH = vh - navH - pad - padBottom;
        const availW = vw - pad * 2;
        const workspaceMin = 260;
        const workspaceMax = 360;
        const panelMax = 356;
        const panelMin = 200;

        let panel = Math.min(panelMax, availH, availW - gap - workspaceMin);
        panel = clampNum(panel, panelMin, panelMax);
        let workspace = clampNum(availW - gap - panel, workspaceMin, workspaceMax);

        if (panel + gap + workspace > availW + 0.5) {
            workspace = clampNum(availW - gap - panel, 220, workspaceMax);
        }
        if (panel > availH) {
            panel = Math.max(180, availH);
        }

        root.style.setProperty('--game-panel-size', `${Math.round(panel)}px`);
        root.style.setProperty('--game-workspace-width', `${Math.round(workspace)}px`);
        root.style.setProperty('--game-chassis-gap', `${Math.round(gap)}px`);
        root.style.setProperty('--game-chassis-pad', `${Math.round(pad)}px`);
        root.style.setProperty('--game-chassis-pad-bottom', '88px');
        document.body.classList.toggle('game-compact', panel < 280);
        document.body.classList.remove('game-mobile-landscape');
    } else if (isLandscapePhone) {
        const navH = 36;
        const barH = vh <= 480 ? 0 : 56;
        const pad = 8;
        const headerH = 36;
        const inputH = 48;
        const availH = Math.max(120, vh - navH - barH - pad * 2 - headerH - inputH);
        const availW = vw - pad * 2;
        const grid = clampNum(Math.min(availW * 0.48, availH, 240), 132, 240);

        root.style.setProperty('--game-panel-size', `${Math.round(grid)}px`);
        root.style.setProperty('--gravity-box-height', `${Math.round(availH)}px`);
        document.body.classList.add('game-mobile-landscape');
        document.body.classList.remove('game-compact');
    } else {
        const navH = 36;
        const barH = vh <= 480 ? 0 : 56;
        const chassisPadTop = 8;
        const chassisPadBottom = barH ? 64 : 8;
        const headerH = 40;
        const inputH = 50;
        const gaps = 16;
        const innerH = vh - navH - chassisPadTop - chassisPadBottom;
        const innerW = vw - 16;
        const usable = innerH - headerH - inputH - gaps;
        const minGravity = 72;
        const grid = clampNum(Math.min(innerW, 320, Math.max(0, usable - minGravity)), 140, 320);
        const gravity = Math.max(minGravity, usable - grid);

        root.style.setProperty('--game-panel-size', `${Math.round(grid)}px`);
        root.style.setProperty('--gravity-box-height', `${Math.round(gravity)}px`);
        document.body.classList.remove('game-compact', 'game-mobile-landscape');
    }

    if (gravityBox) void gravityBox.offsetHeight;
    schedulePhysicsLayoutRefresh();
}

function onViewportChange() {
    applyViewportHeight();
    fitGameLayout();
}

window.addEventListener('resize', onViewportChange);
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewportChange);
}
window.addEventListener('orientationchange', () => {
    setTimeout(onViewportChange, 80);
});
fitGameLayout();

function drawPill(ctx, x, y, width, height, angle, text) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    const radius = height / 2;

    // Outer pill path
    ctx.beginPath();
    ctx.arc(-width / 2 + radius, 0, radius, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.lineTo(width / 2 - radius, -radius);
    ctx.arc(width / 2 - radius, 0, radius, (3 * Math.PI) / 2, Math.PI / 2);
    ctx.closePath();

    const isDark = document.body.classList.contains('dark-theme');

    // 1. Draw solid fill
    ctx.fillStyle = isDark ? '#1e1e24' : '#ffffff';
    ctx.fill();

    // 2. Draw modern cobalt border (fits primary style token)
    ctx.strokeStyle = isDark ? 'rgba(0, 102, 204, 0.4)' : 'rgba(0, 102, 204, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 3. Draw clean Inter text (dark/light styling)
    ctx.fillStyle = isDark ? '#f5f5f7' : '#1d1d1f';
    ctx.font = '600 13px "SF Pro Text", "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);

    ctx.restore();
}

// Fades out while drifting upward, independent of the physics engine — canvas can't read
// CSS custom properties, so this mirrors drawPill's own light/dark literal-color branching.
function drawScorePopup(ctx, popup, now) {
    const t = (now - popup.bornAt) / SCORE_POPUP_LIFETIME_MS; // 0..1
    const opacity = 1 - t;
    const yOffset = -24 * t;
    const isDark = document.body.classList.contains('dark-theme');

    ctx.save();
    ctx.globalAlpha = Math.max(0, opacity);
    ctx.fillStyle = isDark ? '#4d94ff' : '#0066cc';
    ctx.font = '700 14px "SF Pro Text", "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(popup.text, popup.x, popup.y + yOffset);
    ctx.restore();
}

function addWordToPhysics(word, staggerIndex = 0) {
    if (!physicsWorld) return;

    const canvas = document.getElementById('physics-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    ctx.font = '600 13px "SF Pro Text", "Inter", sans-serif';
    
    // Measure string dimensions to fit pill size perfectly
    const textWidth = ctx.measureText(word).width;
    const pillWidth = Math.max(textWidth + 24, 60); // min width 60px
    const pillHeight = 28;

    // Spawn at top center with a small random horizontal scatter offset and stagger height
    const startX = canvas.clientWidth / 2 + (Math.random() - 0.5) * 50;
    const startY = -15 - (staggerIndex * 35);

    const Bodies = Matter.Bodies;
    const Body = Matter.Body;

    // Create capsule body with chamfer corners
    const body = Bodies.rectangle(startX, startY, pillWidth, pillHeight, {
        chamfer: { radius: pillHeight / 2 },
        restitution: 0.32, // softer bounce with lower gravity
        friction: 0.18,
        frictionAir: 0.022
    });

    body.wordText = word;
    body.pillWidth = pillWidth;
    body.pillHeight = pillHeight;

    // Apply soft initial tumble torque and downward force
    Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.12);
    Body.setVelocity(body, { x: (Math.random() - 0.5) * 1.2, y: 1.0 });

    physicsWordBodies.push(body);
    Matter.World.add(physicsWorld, body);
}

// A short fixed delay after drop, rather than watching the pill's velocity to detect an
// exact landing — simpler, and the DOM fallback list (mobile / reduced motion) has no
// physics to watch anyway, so it needs a fixed-timing path regardless. The number shown is
// provisional (what the word is worth if nobody else finds it) — the true score, after
// duplicate-cancellation, only exists once the round ends and is what results screen shows.
function scheduleScorePopup(word, points) {
    setTimeout(() => spawnScorePopup(word, points), SCORE_POPUP_DELAY_MS);
}

function spawnScorePopup(word, points) {
    if (!isPlaying) return; // round ended while we were waiting — nothing to attach to
    if (typeof Matter !== 'undefined' && physicsWorld) {
        spawnCanvasScorePopup(word, points);
    } else {
        spawnDomScorePopup(word, points);
    }
}

function spawnCanvasScorePopup(word, points) {
    // Most-recently-added body with this text, in the rare case of a repeated word
    const body = [...physicsWordBodies].reverse().find(b => b.wordText === word);
    if (!body) return; // pill was somehow already removed
    scorePopups.push({ x: body.position.x, y: body.position.y, text: `+${points}`, bornAt: performance.now() });
}

function spawnDomScorePopup(word, points) {
    const li = [...draftList.children].find(el => el.dataset.word === word);
    if (!li) return; // list was cleared (new round) before this fired
    const span = document.createElement('span');
    span.className = 'score-popup';
    span.textContent = `+${points}`;
    li.appendChild(span);
    setTimeout(() => span.remove(), SCORE_POPUP_LIFETIME_MS);
}

// Bind Home Buttons
const btnLobbyHome = document.getElementById('btn-lobby-home');
const btnResultsHome = document.getElementById('btn-results-home');
const btnStandingsHome = document.getElementById('btn-standings-home');
const btnWinnerHome = document.getElementById('btn-winner-home');
const navHomeBtn = document.getElementById('nav-home-btn');
const confirmLeaveModal = document.getElementById('confirm-leave-modal');
const btnConfirmLeave = document.getElementById('btn-confirm-leave');
const btnCancelLeave = document.getElementById('btn-cancel-leave');

// Walking out of a game in progress costs everyone the round, so make it deliberate.
// The lobby and the Game Over screen have nothing left to lose, so they leave freely.
function confirmLeaveGame() {
    // Nothing is at stake in the tutorial, so friction here would just be nagging
    if (isTutorial) {
        endTutorial();
        return;
    }
    showOverlay(confirmLeaveModal);
}

function dismissLeaveConfirm() {
    hideOverlay(confirmLeaveModal);
}

if (btnConfirmLeave) {
    btnConfirmLeave.addEventListener('click', async () => {
        dismissLeaveConfirm();
        await leaveRoomAndGoHome();
    });
}
if (btnCancelLeave) btnCancelLeave.addEventListener('click', dismissLeaveConfirm);

if (btnRejoinGame) {
    btnRejoinGame.addEventListener('click', async () => {
        if (reconnectInProgress) return;
        const savedRoom = sessionStorage.getItem('wordperfect_room') || myRoomCode;
        const savedName = sessionStorage.getItem('wordperfect_name') || myPlayerName;
        if (!savedRoom || !savedName) {
            await leaveRoomAndGoHome();
            return;
        }

        setReconnectBusy(true, 'Connecting to your room…');
        try {
            // In a multiplayer room, failover continues immediately. A returning former
            // host comes back as a normal player; a truly solo host still owns its room.
            const otherConnectedPlayers = previousLivePlayers.filter(player => player.id !== myPlayerId);
            const shouldRemainHost = isHost && otherConnectedPlayers.length === 0;
            await joinRealtimeRoom(savedRoom, savedName, shouldRemainHost, true);
        } catch (error) {
            console.error('Reconnect attempt failed:', error);
            setReconnectBusy(false, 'Rejoin failed. Check your connection and try again.');
        }
    });
}

if (btnConnectionLeave) {
    btnConnectionLeave.addEventListener('click', leaveRoomAndGoHome);
}

// The recap is deliberately read-only: it opens over the results screen and touches no
// game state, so a player mid-game can check the rules without forfeiting anything.
if (btnIdleRefresher) btnIdleRefresher.addEventListener('click', () => showOverlay(rulesRecapModal));
if (btnCloseRecap) btnCloseRecap.addEventListener('click', () => hideOverlay(rulesRecapModal));

// Leaves without friction
if (btnLobbyHome) btnLobbyHome.addEventListener('click', leaveRoomAndGoHome);
if (btnWinnerHome) btnWinnerHome.addEventListener('click', leaveRoomAndGoHome);

// Leaves mid-game, so confirm first
if (btnResultsHome) btnResultsHome.addEventListener('click', confirmLeaveGame);
if (btnStandingsHome) btnStandingsHome.addEventListener('click', confirmLeaveGame);
if (navHomeBtn) navHomeBtn.addEventListener('click', confirmLeaveGame);

refreshLobbySettingsSummary();

// Bind Bot Toggle
const btnToggleAi = document.getElementById('btn-toggle-ai');

function syncAiSwitch() {
    if (btnToggleAi) btnToggleAi.setAttribute('aria-checked', aiEnabled ? 'true' : 'false');
}

if (btnToggleAi) {
    btnToggleAi.addEventListener('click', async () => {
        if (!isHost) return;
        aiEnabled = !aiEnabled;
        syncAiSwitch();

        if (!aiEnabled) {
            myLocalAiPlayers = [];
            lastKnownAiPlayers = [];
            saveGameStateToSession();
            await syncMyState();
        } else {
            await reconcileBots(activePlayersList.filter(p => !p.isAi && !p.isDisconnected).length);
        }
    });
}

bootEngine();