const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

const letterBag = [
    'A','A','A','A','A','A','A','A','A', 'E','E','E','E','E','E','E','E','E','E','E','E',
    'I','I','I','I','I','I','I','I','I', 'O','O','O','O','O','O','O','O', 'U','U','U','U',
    'N','N','N','N','N','N', 'R','R','R','R','R','R', 'T','T','T','T','T','T',
    'L','L','L','L', 'S','S','S','S', 'D','D','D','D', 'G','G','G',
    'B','B', 'C','C', 'M','M', 'P','P', 'F','F', 'H','H', 'V','V', 'W','W', 'Y','Y',
    'K', 'J', 'X', 'Q', 'Z'
];

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

function generateBoard() {
    let board = [];
    for(let i=0; i<16; i++) {
        board.push(letterBag[Math.floor(Math.random() * letterBag.length)]);
    }
    return board;
}

function calculateRoundScores(roomCode) {
    const room = rooms[roomCode];
    let wordMap = {}; 

    for (let socketId in room.submissions) {
        let words = room.submissions[socketId];
        let playerName = room.players.find(p => p.id === socketId).name;
        
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
        let points = isDuplicate ? 0 : word.length;

        results.push({ word, authors, isDuplicate, points });

        if (!isDuplicate) {
            let player = room.players.find(p => p.name === authors[0]);
            if (player) player.score += points;
        }
    }

    results.sort((a, b) => a.isDuplicate - b.isDuplicate);
    
    const isGameOver = room.currentRound >= room.maxRounds;

    io.to(roomCode).emit('round_results', { 
        results, 
        players: room.players,
        isGameOver: isGameOver,
        currentRound: room.currentRound,
        maxRounds: room.maxRounds
    });
    
    room.submissions = {};
    if (!isGameOver) {
        room.currentRound++;
        room.status = 'lobby';
        room.players.forEach(p => p.isReady = false);
        // FIX: Tell the clients to update their lobby UI to show "Not Ready"
        io.to(roomCode).emit('room_updated', room.players);
    } else {
        room.status = 'game_over';
    }
}

io.on('connection', (socket) => {
    
    socket.on('create_room', (data) => {
        let roomCode = generateRoomCode();
        while (rooms[roomCode]) roomCode = generateRoomCode();

        rooms[roomCode] = {
            host: socket.id,
            players: [{ id: socket.id, name: data.playerName, isReady: false, score: 0 }],
            status: 'lobby',
            submissions: {},
            currentRound: 1,
            maxRounds: parseInt(data.maxRounds) || 3
        };

        socket.join(roomCode);
        socket.emit('room_joined', { 
            roomCode, 
            players: rooms[roomCode].players,
            currentRound: 1,
            maxRounds: rooms[roomCode].maxRounds,
            isHost: true 
        });
    });

    socket.on('join_room', ({ roomCode, playerName }) => {
        roomCode = roomCode.toUpperCase();
        const room = rooms[roomCode];

        if (room && room.status === 'lobby') {
            room.players.push({ id: socket.id, name: playerName, isReady: false, score: 0 });
            socket.join(roomCode);
            io.to(roomCode).emit('room_updated', room.players);
            socket.emit('room_joined', { 
                roomCode, 
                players: room.players,
                currentRound: room.currentRound,
                maxRounds: room.maxRounds,
                isHost: false 
            });
        } else {
            socket.emit('join_error', 'Room not found or game in progress.');
        }
    });

    socket.on('toggle_ready', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.isReady = !player.isReady;
            io.to(roomCode).emit('room_updated', room.players);

            const allReady = room.players.length > 0 && room.players.every(p => p.isReady);
            if (allReady && room.status === 'lobby') {
                room.status = 'playing';
                const boardLetters = generateBoard();
                io.to(roomCode).emit('trigger_countdown', boardLetters);
            }
        }
    });

    socket.on('submit_words', ({ roomCode, words }) => {
        const room = rooms[roomCode];
        if (!room) return;

        room.submissions[socket.id] = words;

        if (Object.keys(room.submissions).length === room.players.length) {
            calculateRoundScores(roomCode);
        }
    });

    socket.on('play_again', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.id) {
            room.currentRound = 1;
            room.status = 'lobby';
            room.players.forEach(p => { p.score = 0; p.isReady = false; });
            io.to(roomCode).emit('game_reset', { players: room.players, maxRounds: room.maxRounds });
        }
    });

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const index = room.players.findIndex(p => p.id === socket.id);
            
            if (index !== -1) {
                room.players.splice(index, 1);
                
                if (room.players.length === 0) {
                    delete rooms[roomCode];
                } else {
                    if (room.host === socket.id) room.host = room.players[0].id; 
                    io.to(roomCode).emit('room_updated', room.players);
                    
                    if (room.status === 'playing' && Object.keys(room.submissions).length === room.players.length) {
                        calculateRoundScores(roomCode);
                    }
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server live on http://localhost:${PORT}`));