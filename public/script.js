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
let activePlayersList = []; // Kept in sync via presence
// Add these to your DOM Elements section at the top
const screenTutorial = document.getElementById('screenTutorial');
const btnOpenTutorial = document.getElementById('btnOpenTutorial'); // Assuming you added this button
const btnCloseTutorial = document.getElementById('btnCloseTutorial');
const tutorialSteps = document.querySelectorAll('.hidden-step');

// --- TUTORIAL LOGIC ---
// --- TUTORIAL LOGIC ---
btnOpenTutorial.addEventListener('click', (e) => {
    e.preventDefault(); // <--- This violently stops any accidental form submissions!

    // Hide the boot/lobby screen and show the tutorial
    hideOverlay(screenBoot);
    showOverlay(screenTutorial);

    // Reset all steps to hidden just in case they opened it before
    tutorialSteps.forEach(step => step.classList.remove('animate-step'));

    // Cascade the animations with a 60ms delay between each step
    tutorialSteps.forEach((step, index) => {
        setTimeout(() => {
            step.classList.add('animate-step');
        }, index * 60);
    });
});

btnCloseTutorial.addEventListener('click', () => {
    hideOverlay(screenTutorial);
    showOverlay(screenBoot); // Send them back to the main screen
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
    sessionStorage.setItem('wordperfect_time_left', timeLeft.toString());
    sessionStorage.setItem('wordperfect_total_score', myTotalScore.toString());
}

function clearGameStateFromSession() {
    sessionStorage.removeItem('wordperfect_is_playing');
    sessionStorage.removeItem('wordperfect_board_letters');
    sessionStorage.removeItem('wordperfect_current_round');
    sessionStorage.removeItem('wordperfect_max_rounds');
    sessionStorage.removeItem('wordperfect_seconds_per_round');
    sessionStorage.removeItem('wordperfect_time_left');
    
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

let currentRound = 1;
let maxRounds = 3;
let secondsPerRound = 60;
let myTotalScore = 0;
let myTotalWords = 0;
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

// Controls
const bootStatus = document.getElementById('boot-status');
const multiplayerControls = document.getElementById('multiplayer-controls');
const inputPlayerName = document.getElementById('input-player-name');
const inputRoomCode = document.getElementById('input-room-code');
const lobbyInputRounds = document.getElementById('lobby-input-rounds');
const lobbyRoundsDisplay = document.getElementById('lobby-rounds-display');
const lobbyInputTime = document.getElementById('lobby-input-time');
const lobbyTimeDisplay = document.getElementById('lobby-time-display');
const btnCreateRoom = document.getElementById('btn-create-room');
const btnJoinRoom = document.getElementById('btn-join-room');
const joinErrorMsg = document.getElementById('join-error-msg');
const btnReadyUp = document.getElementById('btn-ready-up');
const btnStandingsReady = document.getElementById('btn-standings-ready');
const countdownTimer = document.getElementById('countdown-timer');
const displayRoomCode = document.getElementById('display-room-code');
const lobbyPlayerList = document.getElementById('lobby-player-list');
const btnNextRound = document.getElementById('btn-next-round');
const btnShuffle = document.getElementById('btn-shuffle');
const btnStandingsViewWords = document.getElementById('btn-standings-view-words');
const btnCopyLink = document.getElementById('btn-copy-link');
// (Removed the dead btnStandingsToLobby reference here)
const resultsList = document.getElementById('results-list');
const standingsList = document.getElementById('standings-list');
const resultsTitle = document.getElementById('results-title');
const winnerList = document.getElementById('winner-list');
const btnPlayAgain = document.getElementById('btn-play-again');
const guestWaitingMsg = document.getElementById('guest-waiting-msg');
const penStatus = document.getElementById('penalty-status');
const penTimerEl = document.getElementById('penalty-timer');

function showOverlay(element) { element.classList.add('active'); }
function hideOverlay(element) { element.classList.remove('active'); }

// --- BOOT SEQUENCE ---
async function bootEngine() {
    try {
        const response = await fetch('https://raw.githubusercontent.com/MagicOctopusUrn/wordListsByLength/master/unsorted.txt');
        const text = await response.text();
        const words = text.split(/\r?\n/).filter(word => word.trim().length > 0);
        dictionarySet = new Set(words.map(word => word.trim().toUpperCase()));

        bootStatus.classList.add('hidden');
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

            // Restore round state if we were playing mid-round
            const savedIsPlaying = sessionStorage.getItem('wordperfect_is_playing') === 'true';
            if (savedIsPlaying) {
                const savedBoard = sessionStorage.getItem('wordperfect_board_letters');
                const savedCurRound = sessionStorage.getItem('wordperfect_current_round');
                const savedMaxRounds = sessionStorage.getItem('wordperfect_max_rounds');
                const savedSecondsPerRound = sessionStorage.getItem('wordperfect_seconds_per_round');
                const savedTimeLeft = sessionStorage.getItem('wordperfect_time_left');
                
                if (savedBoard) {
                    boardLetters = JSON.parse(savedBoard);
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
                if (savedTimeLeft) {
                    timeLeft = parseInt(savedTimeLeft);
                }
                isPlaying = true;
            }
            
            await joinRealtimeRoom(savedRoom, savedName, savedIsHost);
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
        bootStatus.textContent = 'Network Error. Could not load dictionary.';
    }
}

lobbyInputRounds.addEventListener('input', (e) => {
    if (!isHost) return;
    maxRounds = parseInt(e.target.value);
    lobbyRoundsDisplay.textContent = `${maxRounds} Round${maxRounds > 1 ? 's' : ''}`;
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
    if (isReady) {
        isReady = false;
        resetReadyButtons();
    }
});

lobbyInputTime.addEventListener('change', async () => {
    if (!isHost) return;
    await syncMyState();
});


// --- SUPABASE REALTIME LOGIC ---


async function syncMyState() {
    if (!roomChannel) return;

    console.log("Broadcasting my state: Ready =", isReady);

    const trackPayload = {
        id: myPlayerId,
        name: myPlayerName,
        isReady: isReady,
        score: myTotalScore,
        totalWords: myTotalWords,
        isHost: isHost,
        updatedAt: Date.now() // FIX: Forces Supabase to broadcast the change
    };

    if (isHost) {
        trackPayload.maxRounds = maxRounds;
        trackPayload.roundTime = secondsPerRound;
        trackPayload.aiPlayers = myLocalAiPlayers;
    }

    await roomChannel.track(trackPayload);
}

async function joinRealtimeRoom(code, name, hostFlag) {
    myRoomCode = code;
    myPlayerName = name;
    isHost = hostFlag;

    // Persist session details across page refreshes
    sessionStorage.setItem('wordperfect_room', code);
    sessionStorage.setItem('wordperfect_name', name);
    sessionStorage.setItem('wordperfect_is_host', hostFlag ? 'true' : 'false');

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

    // 1. Presence Sync (Lobby Updates)
    const handlePresenceUpdate = () => {
        const state = roomChannel.presenceState();

        activePlayersList = [];
        let aiPlayersToAppend = [];
        for (const id in state) {
            if (state[id] && state[id].length > 0) {
                // FIX: Sort the history array by our timestamp so we always grab the newest state!
                const playerStates = state[id];
                playerStates.sort((a, b) => b.updatedAt - a.updatedAt);
                const activeState = playerStates[0];
                activePlayersList.push(activeState);
                
                // If this connected player is the host and has bots, save them
                if (activeState.isHost && activeState.aiPlayers) {
                    aiPlayersToAppend = activeState.aiPlayers;
                }
            }
        }
        
        // Append bots to the players list
        activePlayersList = [...activePlayersList, ...aiPlayersToAppend];

        // Guest synchronizes with the host's settings (maxRounds, secondsPerRound) in real-time
        const hostPlayer = activePlayersList.find(p => p.isHost);
        if (hostPlayer) {
            if (!isHost) {
                let settingsChanged = false;
                if (hostPlayer.maxRounds !== undefined && hostPlayer.maxRounds !== maxRounds) {
                    maxRounds = hostPlayer.maxRounds;
                    lobbyInputRounds.value = maxRounds;
                    lobbyRoundsDisplay.textContent = `${maxRounds} Round${maxRounds > 1 ? 's' : ''}`;
                    settingsChanged = true;
                }
                if (hostPlayer.roundTime !== undefined && hostPlayer.roundTime !== secondsPerRound) {
                    secondsPerRound = hostPlayer.roundTime;
                    lobbyInputTime.value = secondsPerRound;
                    lobbyTimeDisplay.textContent = `${secondsPerRound}s`;
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

        // Show/hide play with bot suggestion toast
        const isSingleRealPlayer = activePlayersList.filter(p => !p.isAi).length === 1;
        const hasAi = activePlayersList.some(p => p.isAi);
        const aiToastEl = document.getElementById('ai-toast');
        if (aiToastEl) {
            if (isHost && isSingleRealPlayer && !hasAi && !isAiRejected) {
                aiToastEl.classList.remove('hidden');
            } else {
                aiToastEl.classList.add('hidden');
            }
        }

        renderLobbyPlayers(activePlayersList);
        if (screenStandings.classList.contains('active')) {
            renderStandingsScreen(activePlayersList, currentRound > 1 ? currentRound - 1 : 1);
        }

        // Host checks if everyone is ready to start
        if (isHost && activePlayersList.length > 0) {
            const allReady = activePlayersList.every(p => p.isReady);

            if (allReady && !isPlaying) {
                console.log("Host detected all players are ready. Starting game...");
                startGameAsHost();
            }
        }
    };
    // FIX: Bind to all three events to guarantee we don't miss any updates
    roomChannel.on('presence', { event: 'sync' }, handlePresenceUpdate);
    roomChannel.on('presence', { event: 'join' }, handlePresenceUpdate);
    roomChannel.on('presence', { event: 'leave' }, handlePresenceUpdate);

    // 2. Broadcasts (The Game Engine)
    roomChannel.on('broadcast', { event: 'trigger_game' }, (response) => {
        console.log("Raw trigger_game response:", response); // For debugging

        // Bulletproof Extraction: Handles both raw unwrapped data and nested Supabase payloads
        const data = response.board ? response : response.payload;

        boardLetters = data.board;
        maxRounds = data.maxRounds || 3;
        secondsPerRound = data.roundTime || 60;

        isReady = false;
        resetReadyButtons();

        // Persist to session storage
        sessionStorage.setItem('wordperfect_board_letters', JSON.stringify(boardLetters));
        sessionStorage.setItem('wordperfect_max_rounds', maxRounds.toString());
        sessionStorage.setItem('wordperfect_seconds_per_round', secondsPerRound.toString());
        sessionStorage.setItem('wordperfect_current_round', currentRound.toString());
        sessionStorage.setItem('wordperfect_is_playing', 'true');

        hideOverlay(screenLobby);
        hideOverlay(screenStandings);
        startCountdown();
    });

    // Listen for request_sync (Host responds to rejoining clients)
    roomChannel.on('broadcast', { event: 'request_sync' }, async (response) => {
        const data = response.payload || response;
        if (isHost && isPlaying) {
            console.log("Host received request_sync from requester:", data.requesterId);
            await roomChannel.send({
                type: 'broadcast',
                event: 'sync_game_state',
                payload: {
                    board: boardLetters,
                    currentRound: currentRound,
                    maxRounds: maxRounds,
                    roundTime: secondsPerRound,
                    timeLeft: timeLeft
                }
            });
        }
    });

    // Listen for sync_game_state (Guests align with Host)
    roomChannel.on('broadcast', { event: 'sync_game_state' }, (response) => {
        const data = response.payload || response;
        if (!isHost) {
            console.log("Received sync_game_state from host:", data);
            
            // Sync game parameters
            boardLetters = data.board;
            currentRound = data.currentRound;
            maxRounds = data.maxRounds;
            secondsPerRound = data.roundTime || 60;
            
            // Persist to session storage
            sessionStorage.setItem('wordperfect_board_letters', JSON.stringify(boardLetters));
            sessionStorage.setItem('wordperfect_current_round', currentRound.toString());
            sessionStorage.setItem('wordperfect_max_rounds', maxRounds.toString());
            sessionStorage.setItem('wordperfect_seconds_per_round', secondsPerRound.toString());
            sessionStorage.setItem('wordperfect_is_playing', 'true');
            sessionStorage.setItem('wordperfect_time_left', data.timeLeft.toString());

            if (!isPlaying) {
                hideOverlay(screenLobby);
                hideOverlay(screenStandings);
                hideOverlay(screenResults);
                updateLobbyRoundText();
                initRound(data.timeLeft);
            } else {
                // Just sync the timeLeft
                timeLeft = data.timeLeft;
            }
        }
    });

    // Only the Host listens for word submissions
    if (isHost) {
        roomChannel.on('broadcast', { event: 'submit_words' }, (response) => {
            const data = response.playerId ? response : response.payload;
            hostSubmissions[data.playerId] = data.words;

            // If we have received words from everyone in the room (excluding bots)
            const realPlayersCount = activePlayersList.filter(p => !p.isAi).length;
            if (Object.keys(hostSubmissions).length === realPlayersCount) {
                calculateScoresAndBroadcast();
            }
        });
    }

    roomChannel.on('broadcast', { event: 'round_results' }, async (response) => {
        const data = response.results ? response : response.payload;

        hideOverlay(screenCountdown);
        showOverlay(screenResults);

        isReady = false;
        resetReadyButtons();

        // Sort results: active words first (longest first), duplicate/cancelled words last (longest first)
        const sortedResults = [...data.results].sort((a, b) => {
            if (a.isDuplicate !== b.isDuplicate) {
                return a.isDuplicate ? 1 : -1;
            }
            return b.word.length - a.word.length;
        });

        // Render the results list
        resultsList.innerHTML = '';
        sortedResults.forEach(res => {
            const li = document.createElement('li');
            li.className = `result-row ${res.isDuplicate ? 'duplicate-word' : 'unique-word'}`;
            const authorsText = res.authors.join(', ');
            const pointsText = res.isDuplicate ? 'CANCELLED' : `+${res.points} pts`;

            li.innerHTML = `
                <div style="display:flex; flex-direction:column;">
                    <span class="result-word">${res.word}</span>
                    <span class="caption result-authors">${authorsText}</span>
                </div>
                <span class="result-points">${pointsText}</span>
            `;
            resultsList.appendChild(li);
        });

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

    roomChannel.on('broadcast', { event: 'game_reset' }, async () => {
        currentRound = 1;
        myTotalScore = 0;
        myTotalWords = 0;
        isReady = false;
        resetReadyButtons();
        updateLobbyRoundText();

        // Clear cached game states
        clearGameStateFromSession();

        await syncMyState();

        hideOverlay(screenWinner);
        showOverlay(screenLobby);
    });

    // 3. Subscribe
    roomChannel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
            // Configure lobby settings sliders for Host vs Guest
            if (isHost) {
                lobbyInputRounds.disabled = false;
                lobbyInputTime.disabled = false;
            } else {
                lobbyInputRounds.disabled = true;
                lobbyInputTime.disabled = true;
            }

            await syncMyState();
            displayRoomCode.textContent = myRoomCode;
            navRoomDisplay.textContent = `Room: ${myRoomCode}`;
            updateLobbyRoundText();
            hideOverlay(screenBoot);
            
            if (isPlaying) {
                hideOverlay(screenLobby);
                initRound(timeLeft);
            } else {
                showOverlay(screenLobby);
            }

            // Always broadcast request_sync to ensure alignment with Host or catch up
            console.log("Sending request_sync...");
            await roomChannel.send({
                type: 'broadcast',
                event: 'request_sync',
                payload: { requesterId: myPlayerId }
            });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.error("Supabase Realtime Subscription Error:", status);
            sessionStorage.clear(); // Clear bad/stale session parameters
            alert("Failed to connect to the game server. Please try again.");
            // Reset URL parameters and return home
            window.location.href = window.location.origin + window.location.pathname;
        }
    });
}

// --- HOST AUTHORITATIVE FUNCTIONS ---
async function startGameAsHost() {
    isPlaying = true; // FIX: Lock the game state so this doesn't double-fire
    hostSubmissions = {};
    const newBoard = [];
    for (let i = 0; i < 16; i++) {
        newBoard.push(letterBag[Math.floor(Math.random() * letterBag.length)]);
    }

    boardLetters = newBoard;
    saveGameStateToSession();

    await roomChannel.send({
        type: 'broadcast',
        event: 'trigger_game',
        payload: { board: newBoard, maxRounds: maxRounds, roundTime: secondsPerRound }
    });
}

function getAllValidBoardWords() {
    const validWords = [];
    for (const word of dictionarySet) {
        if (word.length >= 4 && !isPlural(word) && isWordInGrid(word)) {
            validWords.push(word);
        }
    }
    return validWords;
}

async function calculateScoresAndBroadcast() {
    let wordMap = {};

    // Generate AI player submissions right here on the Host!
    const allValidWords = getAllValidBoardWords();
    const aiPlayers = activePlayersList.filter(p => p.isAi);
    
    aiPlayers.forEach(bot => {
        let count = 0;
        let minLen = 4;
        let maxLen = 8;
        
        if (bot.difficulty === 'Easy') {
            count = Math.floor(2 + Math.random() * 3); // 2 to 4 words
            maxLen = 5;
        } else if (bot.difficulty === 'Medium') {
            count = Math.floor(5 + Math.random() * 3); // 5 to 7 words
            maxLen = 7;
        } else { // Hard
            count = Math.floor(8 + Math.random() * 4); // 8 to 11 words
            maxLen = 12;
        }
        
        let pool = allValidWords.filter(w => w.length >= minLen && w.length <= maxLen);
        if (pool.length === 0) pool = allValidWords; // Fallback
        
        const botWords = [];
        const shuffled = [...pool].sort(() => 0.5 - Math.random());
        for (let i = 0; i < Math.min(count, shuffled.length); i++) {
            botWords.push(shuffled[i]);
        }
        
        hostSubmissions[bot.id] = botWords;
    });

    // Map words to authors
    for (let playerId in hostSubmissions) {
        let words = hostSubmissions[playerId];
        let player = activePlayersList.find(p => p.id === playerId);
        let playerName = player ? player.name : "Unknown";

        words.forEach(w => {
            if (!wordMap[w]) wordMap[w] = [];
            if (!wordMap[w].includes(playerName)) {
                wordMap[w].push(playerName);
            }
        });
    }

    let results = [];
    let tempPlayers = JSON.parse(JSON.stringify(activePlayersList));

    for (let word in wordMap) {
        let authors = wordMap[word];
        let isDuplicate = authors.length > 1;
        let points = isDuplicate ? 0 : word.length;

        results.push({ word, authors, isDuplicate, points });

        if (!isDuplicate) {
            let playerRef = tempPlayers.find(p => p.name === authors[0]);
            if (playerRef) {
                playerRef.score += points;
                playerRef.totalWords = (playerRef.totalWords || 0) + 1;
            }
        }
    }

    results.sort((a, b) => a.isDuplicate - b.isDuplicate);
    const isGameOver = currentRound >= maxRounds;

    await roomChannel.send({
        type: 'broadcast',
        event: 'round_results',
        payload: {
            results,
            players: tempPlayers,
            isGameOver: isGameOver,
            currentRound: currentRound
        }
    });
}


let myLocalAiPlayers = [];
let isAiRejected = false;

const soccerPlayers = [
    "Messi", "Ronaldo", "Neymar", "Mbappe", "Haaland", 
    "Salah", "DeBruyne", "Kane", "Lewandowski", "Modric", 
    "Benzema", "Kroos", "Ronaldinho", "Zidane", "Pele", "Maradona"
];

function getRandomAiName() {
    const currentNames = activePlayersList.map(p => p.name.toUpperCase());
    const availablePlayers = soccerPlayers.filter(name => !currentNames.includes(name.toUpperCase()));
    
    const baseName = availablePlayers.length > 0 
        ? availablePlayers[Math.floor(Math.random() * availablePlayers.length)]
        : "Striker";
        
    return `${baseName}_${Math.floor(10 + Math.random() * 90)}`;
}

async function leaveRoomAndGoHome() {
    console.log("Leaving room and cleaning up state...");
    
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    if (roomChannel) {
        try {
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
    myLocalAiPlayers = [];
    isAiRejected = false;
    isReady = false;
    isHost = false;

    clearGameStateFromSession();
    sessionStorage.removeItem('wordperfect_room');
    sessionStorage.removeItem('wordperfect_name');
    sessionStorage.removeItem('wordperfect_is_host');
    sessionStorage.removeItem('wordperfect_total_score');
    sessionStorage.removeItem('wordperfect_total_words');

    resetReadyButtons();
    totalScoreDisplay.textContent = `Total: 0 pts`;
    roundScoreDisplay.textContent = `Drafted: 0 words`;
    displayRoomCode.textContent = '----';
    navRoomDisplay.textContent = 'Room: ----';
    navRoundDisplay.textContent = 'Round 1';
    roundIndicator.textContent = 'Round 1';

    const overlays = [
        screenLobby, screenCountdown, screenResults, 
        screenStandings, screenWinner, screenTutorial, 
        penaltyModal
    ];
    overlays.forEach(o => {
        if (o) hideOverlay(o);
    });

    showOverlay(screenBoot);
}

// --- UI EVENT LISTENERS ---
btnCreateRoom.addEventListener('click', async () => {
    myPlayerName = inputPlayerName.value.trim();
    maxRounds = 3; // Default starting rounds
    secondsPerRound = 60; // Default starting round duration
    if (myPlayerName.length < 2) return alert("Enter a valid name.");

    myLocalAiPlayers = [];
    isAiRejected = false;

    // Pre-initialize lobby setting displays for the Host
    lobbyInputRounds.value = maxRounds;
    lobbyRoundsDisplay.textContent = `${maxRounds} Round${maxRounds > 1 ? 's' : ''}`;
    lobbyInputTime.value = secondsPerRound;
    lobbyTimeDisplay.textContent = `${secondsPerRound}s`;

    clearGameStateFromSession();

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));

    await joinRealtimeRoom(code, myPlayerName, true);
});

btnJoinRoom.addEventListener('click', async () => {
    myPlayerName = inputPlayerName.value.trim();
    const code = inputRoomCode.value.trim().toUpperCase();
    if (myPlayerName.length < 2) return alert("Enter a valid name.");
    if (code.length !== 4) return alert("Room code must be 4 letters.");

    myLocalAiPlayers = [];
    isAiRejected = false;
    clearGameStateFromSession();

    await joinRealtimeRoom(code, myPlayerName, false);
});

btnReadyUp.addEventListener('click', async () => {
    isReady = !isReady;
    btnReadyUp.style.backgroundColor = isReady ? 'var(--surface-black)' : 'var(--primary)';
    btnReadyUp.textContent = isReady ? 'Waiting for others...' : 'Ready Up';
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

btnCopyLink.addEventListener('click', () => {
    const inviteLink = `${window.location.origin}${window.location.pathname}?room=${myRoomCode}`;
    navigator.clipboard.writeText(inviteLink).then(() => {
        const wrapper = btnCopyLink.querySelector('.icon-wrapper');
        const copySvg = document.getElementById('copy-icon-svg');
        const checkSvg = document.getElementById('check-icon-svg');
        const btnText = btnCopyLink.querySelector('span');
        const originalText = btnText.textContent;

        // Phase 1: Start transition (fade out and blur)
        wrapper.classList.add('transitioning');

        setTimeout(() => {
            // Swap icons and label text
            copySvg.style.opacity = '0';
            checkSvg.style.opacity = '1';
            btnText.textContent = 'Copied!';
            
            // Phase 2: Fade back in with unblur
            wrapper.classList.remove('transitioning');
        }, 150);

        // Transition back to original state after delay
        setTimeout(() => {
            wrapper.classList.add('transitioning');
            setTimeout(() => {
                copySvg.style.opacity = '1';
                checkSvg.style.opacity = '0';
                btnText.textContent = originalText;
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
        await roomChannel.send({ type: 'broadcast', event: 'game_reset' });
    }
});

btnShuffle.addEventListener('click', () => {
    if (!isPlaying) return;

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
        // Fisher-Yates shuffle algorithm
        for (let i = boardLetters.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [boardLetters[i], boardLetters[j]] = [boardLetters[j], boardLetters[i]];
        }

        // Update tile UI text
        tiles.forEach((tile, index) => {
            tile.textContent = boardLetters[index];
        });

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
function resetReadyButtons() {
    btnReadyUp.style.backgroundColor = 'var(--primary)';
    btnReadyUp.textContent = 'Ready Up';
    btnStandingsReady.style.backgroundColor = 'var(--primary)';
    btnStandingsReady.textContent = 'Ready for Next Round';
}

function updateLobbyRoundText() {
    lobbyRoundText.textContent = `Round ${currentRound} of ${maxRounds}`;
    navRoundDisplay.textContent = `Round ${currentRound}/${maxRounds}`;
    roundIndicator.textContent = `Round ${currentRound}/${maxRounds}`;
}

function renderLobbyPlayers(players) {
    lobbyPlayerList.innerHTML = '';
    players.forEach(p => {
        const li = document.createElement('li');
        li.className = `lobby-player-item ${p.isAi ? 'ai-player' : ''}`;
        
        const readyIndicator = p.isReady
            ? `<span class="ready-indicator ready" title="Ready"></span>`
            : `<span class="ready-indicator" title="Not Ready"></span>`;
            
        const nameDisplay = p.id === myPlayerId ? `${p.name} (You)` : p.name;
        
        li.innerHTML = `
            <div class="player-info-group">
                <span class="player-name">${nameDisplay}</span>
                ${p.isAi ? (isHost ? `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <select class="ai-difficulty-select-pill" data-ai-id="${p.id}">
                        <option value="Easy" ${p.difficulty === 'Easy' ? 'selected' : ''}>Easy</option>
                        <option value="Medium" ${p.difficulty === 'Medium' ? 'selected' : ''}>Medium</option>
                        <option value="Hard" ${p.difficulty === 'Hard' ? 'selected' : ''}>Hard</option>
                    </select>
                    <button class="btn-remove-ai-inline" data-ai-id="${p.id}" title="Remove Bot">×</button>
                </div>
                ` : `<span class="ai-badge">${p.difficulty}</span>`) : ''}
            </div>

            <div style="display: flex; align-items: center; gap: 12px;">
                <span>${p.score} pts</span>
                <span style="display: flex; align-items: center; justify-content: flex-end; width: 30px;">${readyIndicator}</span>
            </div>
        `;
        lobbyPlayerList.appendChild(li);
    });

    if (isHost) {
        const selects = lobbyPlayerList.querySelectorAll('.ai-difficulty-select-pill');
        selects.forEach(select => {
            select.addEventListener('change', async (e) => {
                const aiId = e.target.getAttribute('data-ai-id');
                const newDifficulty = e.target.value;
                const ai = myLocalAiPlayers.find(bot => bot.id === aiId);
                if (ai) {
                    ai.difficulty = newDifficulty;
                    await syncMyState();
                }
            });
        });

        const removeBtns = lobbyPlayerList.querySelectorAll('.btn-remove-ai-inline');
        removeBtns.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const aiId = e.target.getAttribute('data-ai-id');
                myLocalAiPlayers = myLocalAiPlayers.filter(bot => bot.id !== aiId);
                await syncMyState();
            });
        });
    }
}

function renderStandingsScreen(players, roundsPlayed = currentRound > 1 ? currentRound - 1 : 1) {
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
        const nameDisplay = p.id === myPlayerId ? `${p.name} (You)` : p.name;
        const readyIndicator = p.isReady
            ? `<span class="ready-indicator ready" title="Ready"></span>`
            : `<span class="ready-indicator" title="Not Ready"></span>`;

        const tWords = p.totalWords || 0;
        const ptsPerRound = (p.score / roundsPlayed).toFixed(1);
        const wordsPerRound = (tWords / roundsPlayed).toFixed(1);
        const ptsPerWord = tWords > 0 ? (p.score / tWords).toFixed(1) : "0.0";

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
            <div class="stats-collapse" style="max-height: 0px; overflow: hidden; opacity: 0; transition: all 0.3s var(--ease-out);">
                <div style="padding-top: 16px; margin-top: 16px; border-top: 1px solid ${rank === 1 ? 'rgba(0,102,204,0.15)' : 'var(--hairline)'}; display: flex; justify-content: space-around; text-align: center;">
                    <div>
                        <div class="body-strong">${ptsPerRound}</div>
                        <div class="caption text-muted">Pts/Round</div>
                    </div>
                    <div>
                        <div class="body-strong">${wordsPerRound}</div>
                        <div class="caption text-muted">Words/Round</div>
                    </div>
                    <div>
                        <div class="body-strong">${ptsPerWord}</div>
                        <div class="caption text-muted">Avg Ratio</div>
                    </div>
                </div>
            </div>
        `;

        div.addEventListener('click', () => {
            const collapse = div.querySelector('.stats-collapse');
            const chevron = div.querySelector('.chevron');
            const isExpanded = collapse.style.maxHeight !== '0px';
            
            if (isExpanded) {
                collapse.style.maxHeight = '0px';
                collapse.style.opacity = '0';
                chevron.style.transform = 'rotate(0deg)';
            } else {
                collapse.style.maxHeight = '120px';
                collapse.style.opacity = '1';
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
        const nameDisplay = p.id === myPlayerId ? `${p.name} (You)` : p.name;

        const tWords = p.totalWords || 0;
        const ptsPerRound = (p.score / roundsPlayed).toFixed(1);
        const wordsPerRound = (tWords / roundsPlayed).toFixed(1);
        const ptsPerWord = tWords > 0 ? (p.score / tWords).toFixed(1) : "0.0";

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
            <div class="stats-collapse" style="max-height: 0px; overflow: hidden; opacity: 0; transition: all 0.3s var(--ease-out);">
                <div style="padding-top: 16px; margin-top: 16px; border-top: 1px solid ${rank === 1 ? 'rgba(0,102,204,0.15)' : 'var(--hairline)'}; display: flex; justify-content: space-around; text-align: center;">
                    <div>
                        <div class="body-strong">${ptsPerRound}</div>
                        <div class="caption text-muted">Pts/Round</div>
                    </div>
                    <div>
                        <div class="body-strong">${wordsPerRound}</div>
                        <div class="caption text-muted">Words/Round</div>
                    </div>
                    <div>
                        <div class="body-strong">${ptsPerWord}</div>
                        <div class="caption text-muted">Avg Ratio</div>
                    </div>
                </div>
            </div>
        `;
        
        div.addEventListener('click', () => {
            const collapse = div.querySelector('.stats-collapse');
            const chevron = div.querySelector('.chevron');
            const isExpanded = collapse.style.maxHeight !== '0px';
            
            if (isExpanded) {
                collapse.style.maxHeight = '0px';
                collapse.style.opacity = '0';
                chevron.style.transform = 'rotate(0deg)';
            } else {
                collapse.style.maxHeight = '120px';
                collapse.style.opacity = '1';
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

// --- COUNTDOWN SEQUENCE ---
function startCountdown() {
    document.body.classList.add('counting-down');
    showOverlay(screenCountdown);
    let count = 5;
    countdownTimer.textContent = count;

    countdownTimer.classList.remove('animate-pop');
    void countdownTimer.offsetWidth;
    countdownTimer.classList.add('animate-pop');

    const countInt = setInterval(() => {
        count--;
        if (count > 0) {
            countdownTimer.textContent = count;
            countdownTimer.classList.remove('animate-pop');
            void countdownTimer.offsetWidth;
            countdownTimer.classList.add('animate-pop');
        } else {
            clearInterval(countInt);
            document.body.classList.remove('counting-down');
            hideOverlay(screenCountdown);
            initRound();
        }
    }, 1000);
}

// --- CORE LOOP ---
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

    tiles.forEach((tile, index) => {
        const letter = boardLetters[index];
        tile.textContent = letter;

        tile.onclick = () => {
            if (isPlaying) { // (Removed penaltyActive check here since we deleted it)
                wordInput.value += letter;
                sendBtn.disabled = wordInput.value.trim().length < 4;
                wordInput.focus();
            }
        };
    });

    startClock();
}

function startClock() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeLeft--;

        const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
        const s = (timeLeft % 60).toString().padStart(2, '0');
        timerDisplay.textContent = `${m}:${s}`;

        if (timeLeft <= 10 && timeLeft > 0) {
            timerDisplay.style.color = 'var(--danger)';
        }

        sessionStorage.setItem('wordperfect_time_left', timeLeft.toString());

        if (timeLeft <= 0) {
            endRound();
        }
    }, 1000);
}

async function endRound() {
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

    // Broadcast drafted words for the host to process
    await roomChannel.send({
        type: 'broadcast',
        event: 'submit_words',
        payload: { playerId: myPlayerId, words: draftedWords }
    });
}

actionBtn.addEventListener('click', () => {
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

function rejectInput(reason) {
    wordInput.classList.add('input-error');
    const oldPlaceholder = wordInput.placeholder;

    // Show the user exactly why it failed in the input box
    wordInput.value = '';
    wordInput.placeholder = reason;
    sendBtn.disabled = true;

    setTimeout(() => {
        wordInput.classList.remove('input-error');
        wordInput.placeholder = oldPlaceholder;
        wordInput.focus();
    }, 1000);
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
        return false;
    }
    if (!dictionarySet.has(newWord)) {
        console.log("❌ Failed: Not in dictionary. Dict size:", dictionarySet.size);
        rejectInput("Not a valid word!");
        return false;
    }
    if (isPlural(newWord)) {
        console.log("❌ Failed: Plural rule");
        rejectInput("No basic plurals!");
        return false;
    }

    console.log("✅ Success! Adding to draft.");
    draftedWords.unshift(newWord);

    // Save update to sessionStorage
    const cacheKey = `wordperfect_drafted_${myRoomCode}_round_${currentRound}`;
    sessionStorage.setItem(cacheKey, JSON.stringify(draftedWords));

    if (typeof Matter !== 'undefined' && physicsWorld) {
        addWordToPhysics(newWord);
    } else {
        const li = document.createElement('li');
        li.className = 'draft-item body-strong';
        li.textContent = newWord;
        draftList.prepend(li);
    }

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
    window.visualViewport.addEventListener('resize', () => {
        document.body.style.height = window.visualViewport.height + 'px';
        window.scrollTo(0, 0);
    });
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
    }
});
// --- DRAFTING MECHANICS ---

// --- HONEST FRICTION ---
document.addEventListener("visibilitychange", () => {
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

    if (typeof Matter === 'undefined' || window.innerWidth <= 768) {
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

    const width = container.clientWidth;
    const height = container.clientHeight;
    
    // Scale for high-DPI screens
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.scale(dpr, dpr);

    const Engine = Matter.Engine,
          World = Matter.World,
          Bodies = Matter.Bodies;

    physicsEngine = Engine.create();
    physicsWorld = physicsEngine.world;
    physicsWorld.gravity.y = 0.5; // soft natural gravity

    // Create boundaries slightly outside the canvas area
    const floor = Bodies.rectangle(width / 2, height + 20, width + 100, 40, { isStatic: true });
    const leftWall = Bodies.rectangle(-20, height / 2, 40, height + 100, { isStatic: true });
    const rightWall = Bodies.rectangle(width + 20, height / 2, 40, height + 100, { isStatic: true });

    World.add(physicsWorld, [floor, leftWall, rightWall]);
    physicsWordBodies = [];

    // Animation frame render loop
    function updatePhysicsFrame() {
        if (!physicsEngine) return;
        Engine.update(physicsEngine, 16.666); // 60fps simulation step

        ctx.clearRect(0, 0, width, height);

        // Render each pill body
        physicsWordBodies.forEach(body => {
            drawPill(ctx, body.position.x, body.position.y, body.pillWidth, body.pillHeight, body.angle, body.wordText);
        });

        physicsAnimId = requestAnimationFrame(updatePhysicsFrame);
    }
    updatePhysicsFrame();
}

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
        restitution: 0.45, // elastic bouncing coefficient
        friction: 0.15,
        frictionAir: 0.015
    });

    body.wordText = word;
    body.pillWidth = pillWidth;
    body.pillHeight = pillHeight;

    // Apply soft initial tumble torque and downward force
    Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.15);
    Body.setVelocity(body, { x: (Math.random() - 0.5) * 1.5, y: 1.5 });

    physicsWordBodies.push(body);
    Matter.World.add(physicsWorld, body);
}

// Bind Home Buttons
const btnLobbyHome = document.getElementById('btn-lobby-home');
const btnResultsHome = document.getElementById('btn-results-home');
const btnStandingsHome = document.getElementById('btn-standings-home');
const btnWinnerHome = document.getElementById('btn-winner-home');
const navHomeBtn = document.getElementById('nav-home-btn');

if (btnLobbyHome) btnLobbyHome.addEventListener('click', leaveRoomAndGoHome);
if (btnResultsHome) btnResultsHome.addEventListener('click', leaveRoomAndGoHome);
if (btnStandingsHome) btnStandingsHome.addEventListener('click', leaveRoomAndGoHome);
if (btnWinnerHome) btnWinnerHome.addEventListener('click', leaveRoomAndGoHome);
if (navHomeBtn) navHomeBtn.addEventListener('click', leaveRoomAndGoHome);

// Bind Bot Toast Actions
const btnAddAi = document.getElementById('btn-add-ai');
if (btnAddAi) {
    btnAddAi.addEventListener('click', async () => {
        if (!isHost) return;
        const newBot = {
            id: 'ai-' + Math.random().toString(36).substring(2),
            name: getRandomAiName(),
            isReady: true,
            score: 0,
            totalWords: 0,
            difficulty: 'Medium',
            isAi: true,
            updatedAt: Date.now()
        };
        myLocalAiPlayers.push(newBot);
        await syncMyState();
    });
}

const btnRejectAi = document.getElementById('btn-reject-ai');
if (btnRejectAi) {
    btnRejectAi.addEventListener('click', () => {
        isAiRejected = true;
        const aiToastEl = document.getElementById('ai-toast');
        if (aiToastEl) aiToastEl.classList.add('hidden');
    });
}

bootEngine();