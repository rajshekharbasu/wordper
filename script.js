// --- NETWORK STATE (SUPABASE) ---
const SUPABASE_URL = 'https://lnjcbqdcaikndbllyhkc.supabase.co'; // Keep your actual URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxuamNicWRjYWlrbmRibGx5aGtjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3ODIyNjgsImV4cCI6MjA5MzM1ODI2OH0.zIt87ajVwBUEstCiQdHbrqUWRmEcQvrcRmY109bT_QE'; // Keep your actual Key
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// Safe ID generation (prevents local dev failures)
let myPlayerId = typeof crypto.randomUUID === 'function' 
    ? crypto.randomUUID() 
    : Math.random().toString(36).substring(2); 

let isReady = false;
let isHost = false
let roomChannel = null;
let myRoomCode = '';
let myPlayerName = '';
// Host-specific memory for collision checking
let hostSubmissions = {};
let activePlayersList = []; // Kept in sync via presence

// --- LOCAL GAME STATE ---
const letterBag = [
    'A','A','A','A','A','A','A','A','A', 'E','E','E','E','E','E','E','E','E','E','E','E',
    'I','I','I','I','I','I','I','I','I', 'O','O','O','O','O','O','O','O', 'U','U','U','U',
    'N','N','N','N','N','N', 'R','R','R','R','R','R', 'T','T','T','T','T','T',
    'L','L','L','L', 'S','S','S','S', 'D','D','D','D', 'G','G','G',
    'B','B', 'C','C', 'M','M', 'P','P', 'F','F', 'H','H', 'V','V', 'W','W', 'Y','Y',
    'K', 'J', 'X', 'Q', 'Z'
];

let timeLeft = 60;
let timerInterval = null;
let draftedWords = [];
let boardLetters = []; 
let isPlaying = false;
let currentRound = 1;
let maxRounds = 3;
let myTotalScore = 0;
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
const inputRounds = document.getElementById('input-rounds');
const roundsDisplay = document.getElementById('rounds-display');
const btnCreateRoom = document.getElementById('btn-create-room');
const btnJoinRoom = document.getElementById('btn-join-room');
const joinErrorMsg = document.getElementById('join-error-msg');
const btnReadyUp = document.getElementById('btn-ready-up');
const btnStandingsReady = document.getElementById('btn-standings-ready');
const countdownTimer = document.getElementById('countdown-timer');
const displayRoomCode = document.getElementById('display-room-code');
const lobbyPlayerList = document.getElementById('lobby-player-list');
const btnNextRound = document.getElementById('btn-next-round');
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
        const response = await fetch('https://raw.githubusercontent.com/dwyl/english-words/master/words_dictionary.json');
        const data = await response.json();
        dictionarySet = new Set(Object.keys(data).map(word => word.toUpperCase()));
        
        bootStatus.classList.add('hidden');
        multiplayerControls.classList.remove('hidden');
    } catch (error) {
        bootStatus.textContent = 'Network Error. Could not load dictionary.';
    }
}

// Live update slider text
inputRounds.addEventListener('input', (e) => {
    roundsDisplay.textContent = `${e.target.value} Round${e.target.value > 1 ? 's' : ''}`;
});


// --- SUPABASE REALTIME LOGIC ---


// --- SUPABASE REALTIME LOGIC ---
async function syncMyState() {
    if (!roomChannel) return;
    
    console.log("Broadcasting my state: Ready =", isReady);
    
    await roomChannel.track({
        id: myPlayerId,
        name: myPlayerName,
        isReady: isReady,
        score: myTotalScore,
        updatedAt: Date.now() // FIX: Forces Supabase to broadcast the change
    });
}

async function joinRealtimeRoom(code, name, hostFlag) {
    myRoomCode = code;
    myPlayerName = name;
    isHost = hostFlag;

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
    // 1. Presence Sync (Lobby Updates)
    const handlePresenceUpdate = () => {
        const state = roomChannel.presenceState();
        
        activePlayersList = []; 
        for (const id in state) {
            if (state[id] && state[id].length > 0) {
                 // FIX: Sort the history array by our timestamp so we always grab the newest state!
                 const playerStates = state[id];
                 playerStates.sort((a, b) => b.updatedAt - a.updatedAt); 
                 activePlayersList.push(playerStates[0]);
            }
        }
        
        renderLobbyPlayers(activePlayersList);
        if (screenStandings.classList.contains('active')) {
            renderStandingsScreen(activePlayersList);
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
        
        isReady = false;
        resetReadyButtons();
        
        hideOverlay(screenLobby);
        hideOverlay(screenStandings);
        startCountdown();
    });

    // Only the Host listens for word submissions
    if (isHost) {
        roomChannel.on('broadcast', { event: 'submit_words' }, (response) => {
            const data = response.playerId ? response : response.payload;
            hostSubmissions[data.playerId] = data.words;
            
            // If we have received words from everyone in the room
            if (Object.keys(hostSubmissions).length === activePlayersList.length) {
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
        
        // Render the results list
        resultsList.innerHTML = '';
        data.results.forEach(res => {
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
        if(myResult) {
            myTotalScore = myResult.score;
            totalScoreDisplay.textContent = `Total: ${myTotalScore} pts`;
            await syncMyState(); // Update presence with new score
        }

        if (data.isGameOver) {
            resultsTitle.textContent = "Final Round Results";
            btnNextRound.textContent = "View Final Standings";
            btnNextRound.onclick = () => renderWinnerScreen(data.players);
        } else {
            currentRound = data.currentRound + 1;
            updateLobbyRoundText();
            resultsTitle.textContent = `Round ${data.currentRound} Results`;
            btnNextRound.textContent = "View Current Standings";
            btnNextRound.onclick = () => {
                hideOverlay(screenResults);
                showOverlay(screenStandings);
                renderStandingsScreen(data.players);
            };
        }
    });

    roomChannel.on('broadcast', { event: 'game_reset' }, async () => {
        currentRound = 1;
        myTotalScore = 0;
        isReady = false;
        resetReadyButtons();
        updateLobbyRoundText();
        
        await syncMyState();
        
        hideOverlay(screenWinner);
        showOverlay(screenLobby);
    });

    // 3. Subscribe
    roomChannel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
            await syncMyState();
            displayRoomCode.textContent = myRoomCode;
            navRoomDisplay.textContent = `Room: ${myRoomCode}`;
            updateLobbyRoundText();
            hideOverlay(screenBoot);
            showOverlay(screenLobby);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.error("Supabase Realtime Subscription Error:", status);
            alert("Failed to connect to the game server. Please try again.");
        }
    });
}

// --- HOST AUTHORITATIVE FUNCTIONS ---
async function startGameAsHost() {
    isPlaying = true; // FIX: Lock the game state so this doesn't double-fire
    hostSubmissions = {}; 
    const newBoard = [];
    for(let i=0; i<16; i++) {
        newBoard.push(letterBag[Math.floor(Math.random() * letterBag.length)]);
    }

    await roomChannel.send({
        type: 'broadcast',
        event: 'trigger_game',
        payload: { board: newBoard, maxRounds: maxRounds }
    });
}

async function calculateScoresAndBroadcast() {
    let wordMap = {}; 
    
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
            if (playerRef) playerRef.score += points;
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


// --- UI EVENT LISTENERS ---
btnCreateRoom.addEventListener('click', async () => {
    myPlayerName = inputPlayerName.value.trim();
    maxRounds = parseInt(inputRounds.value);
    if (myPlayerName.length < 2) return alert("Enter a valid name.");
    
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

// (Removed the dead btnStandingsToLobby listener)

btnPlayAgain.addEventListener('click', async () => {
    if (isHost) {
        await roomChannel.send({ type: 'broadcast', event: 'game_reset' });
    }
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
        li.style.display = 'flex';
        li.style.justifyContent = 'space-between';
        const readyIndicator = p.isReady ? '🟢 Ready' : '⚪ Not Ready';
        const nameDisplay = p.id === myPlayerId ? `${p.name} (You)` : p.name;
        li.innerHTML = `<span>${nameDisplay}</span> <span>${p.score} pts</span> <span class="caption text-muted" style="width: 80px; text-align:right;">${readyIndicator}</span>`;
        lobbyPlayerList.appendChild(li);
    });
}

function renderStandingsScreen(players) {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    standingsList.innerHTML = '';
    
    sorted.forEach((p, index) => {
        const rank = index + 1;
        const div = document.createElement('div');
        div.className = `winner-card ${rank === 1 ? 'rank-1' : ''}`;
        
        let rankLabel = rank === 1 ? '🥇 1st' : rank === 2 ? '🥈 2nd' : rank === 3 ? '🥉 3rd' : `${rank}th`;
        const nameDisplay = p.id === myPlayerId ? `${p.name} (You)` : p.name;
        const readyIndicator = p.isReady ? '🟢 Ready' : '⚪ Not Ready';
        
        div.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                <div style="display: flex; align-items: center;">
                    <span class="caption-strong rank-text" style="margin-right: 12px;">${rankLabel}</span>
                    <span class="body-strong">${nameDisplay}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 16px;">
                    <span class="caption text-muted">${readyIndicator}</span>
                    <span class="display-md" style="min-width: 60px; text-align: right;">${p.score}</span>
                </div>
            </div>
        `;
        standingsList.appendChild(div);
    });
}

function renderWinnerScreen(players) {
    hideOverlay(screenResults);
    showOverlay(screenWinner);
    
    const sorted = [...players].sort((a, b) => b.score - a.score);
    winnerList.innerHTML = '';
    
    sorted.forEach((p, index) => {
        const rank = index + 1;
        const div = document.createElement('div');
        div.className = `winner-card ${rank === 1 ? 'rank-1' : ''}`;
        
        let rankLabel = rank === 1 ? '🥇 1st' : rank === 2 ? '🥈 2nd' : rank === 3 ? '🥉 3rd' : `${rank}th`;
        const nameDisplay = p.id === myPlayerId ? `${p.name} (You)` : p.name;
        
        div.innerHTML = `
            <div>
                <span class="caption-strong rank-text" style="margin-right: 12px;">${rankLabel}</span>
                <span class="body-strong">${nameDisplay}</span>
            </div>
            <span class="display-md">${p.score} <span class="caption text-muted">pts</span></span>
        `;
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
            hideOverlay(screenCountdown);
            initRound(); 
        }
    }, 1000);
}

// --- CORE LOOP ---
// --- CORE LOOP ---
function initRound() {
    draftedWords = [];
    timeLeft = 60;
    isPlaying = true; // <--- THE MISSING LINK!
    
    draftList.innerHTML = '';
    roundScoreDisplay.textContent = `Drafted: 0 words`;
    
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
    wordInput.disabled = true;
    sendBtn.disabled = true;
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
    
    const li = document.createElement('li');
    li.className = 'draft-item body-strong'; 
    li.textContent = newWord;
    draftList.prepend(li);
    
    roundScoreDisplay.textContent = `Drafted: ${draftedWords.length} words`;
    
    wordInput.value = '';
    sendBtn.disabled = true; 
    return true;
}

// --- DRAFTING MECHANICS ---
wordInput.addEventListener('input', () => {
    sendBtn.disabled = wordInput.value.trim().length < 4;
});

wordForm.addEventListener('submit', (e) => {
    e.preventDefault(); 
    console.log("Submit triggered. isPlaying state:", isPlaying);
    
    if (!isPlaying) {
        console.log("🚫 Blocked: Game thinks we are not playing.");
        return; 
    }

    const success = attemptSubmitWord(wordInput.value);
    if (success) wordInput.focus();
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

bootEngine();