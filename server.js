const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// rooms = { [roomId]: { host: peerId, state: 'lobby', phase: 'day', players: { [peerId]: { userName, role, socketId, isDead: false } }, timerInterval: null, timeLeft: 0, votes: {} } }
const rooms = {};

const PHASE_DURATION_DAY = 45;
const PHASE_DURATION_NIGHT = 20;

function broadcastVoteCounts(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const voteCounts = {};
  Object.values(room.votes).forEach(targetId => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });
  io.to(roomId).emit('vote-counts', voteCounts);
}

function clearTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function checkGameOver(roomId) {
  const room = rooms[roomId];
  if (!room || room.state !== 'playing') return false;

  let aliveVampires = 0;
  let aliveVillagers = 0;
  
  Object.values(room.players).forEach(p => {
    if (!p.isDead) {
      if (p.role === 'vampire') aliveVampires++;
      if (p.role === 'villager') aliveVillagers++;
    }
  });

  let winner = null;
  if (aliveVampires === 0) winner = 'villagers';
  else if (aliveVampires >= aliveVillagers) winner = 'vampires';

  if (winner) {
    clearTimer(room);
    room.state = 'finished';
    
    // Prepare roles mapping
    const rolesMap = {};
    Object.entries(room.players).forEach(([id, p]) => {
      rolesMap[id] = { userName: p.userName, role: p.role, isDead: p.isDead };
    });

    console.log(`[Room ${roomId}] GAME OVER - Winner: ${winner}`);
    io.to(roomId).emit('game-over', { winner, playersDetails: rolesMap });
    return true;
  }
  return false;
}

function processVotes(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const voteCounts = {};
  Object.values(room.votes).forEach(targetId => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });

  // Find max vote
  let maxVotes = 0;
  let targetToKill = null;
  let isTie = false;

  Object.entries(voteCounts).forEach(([targetId, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      targetToKill = targetId;
      isTie = false;
    } else if (count === maxVotes) {
      isTie = true;
    }
  });

  // If tied or no votes, no one dies for now
  if (!isTie && targetToKill && room.players[targetToKill]) {
    room.players[targetToKill].isDead = true;
    console.log(`[Room ${roomId}] Player Killed: ${targetToKill}`);
    io.to(roomId).emit('player-killed', targetToKill, room.phase);
  }

  // Clear votes
  room.votes = {};
  io.to(roomId).emit('votes-cleared');
  
  return checkGameOver(roomId);
}

function startPhaseTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  clearTimer(room);
  room.timeLeft = room.phase === 'day' ? PHASE_DURATION_DAY : PHASE_DURATION_NIGHT;
  room.votes = {}; // Reset votes
  io.to(roomId).emit('votes-cleared'); // tell clients to reset UI votes

  room.timerInterval = setInterval(() => {
    room.timeLeft -= 1;
    io.to(roomId).emit('timer-tick', room.timeLeft);

    if (room.timeLeft <= 0) {
      clearTimer(room);
      const isGameOver = processVotes(roomId);
      if (isGameOver) return; // Halt Phase logic if game ended
      
      // Auto phase change
      room.phase = room.phase === 'day' ? 'night' : 'day';
      io.to(roomId).emit('phase-changed', room.phase);
      
      // Restart timer for new phase
      setTimeout(() => {
        startPhaseTimer(roomId);
      }, 2000); // 2s buffer for UI animations/reading deaths
    }
  }, 1000);
}

io.on('connection', (socket) => {
  socket.on('join-room', (roomId, peerId, userName) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        host: peerId,
        state: 'lobby',
        phase: 'day', // Default lobby
        players: {},
        votes: {},
        timeLeft: 0,
        timerInterval: null
      };
    }

    rooms[roomId].players[peerId] = { userName, role: null, socketId: socket.id, isDead: false };

    socket.emit('room-info', { 
      host: rooms[roomId].host, 
      state: rooms[roomId].state,
      phase: rooms[roomId].phase
    });

    socket.to(roomId).emit('user-connected', peerId, userName);

    socket.on('start-game', () => {
      const room = rooms[roomId];
      if (room && room.host === peerId && room.state === 'lobby') {
        room.state = 'playing';
        room.phase = 'night'; // Start with Night

        const playerIds = Object.keys(room.players);
        
        for (let i = playerIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
        }

        playerIds.forEach((id, index) => {
          const role = index === 0 ? 'vampire' : 'villager';
          room.players[id].role = role;
          room.players[id].isDead = false;
          io.to(room.players[id].socketId).emit('role-assigned', role);
        });

        io.to(roomId).emit('game-started', { phase: 'night' });
        
        // Start Timer!
        setTimeout(() => {
           startPhaseTimer(roomId);
        }, 1000);
      }
    });

    socket.on('change-phase', (newPhase) => {
      const room = rooms[roomId];
      if (room && room.host === peerId && room.state === 'playing') {
        clearTimer(room);
        processVotes(roomId);
        room.phase = newPhase;
        io.to(roomId).emit('phase-changed', newPhase);
        startPhaseTimer(roomId);
      }
    });

    socket.on('submit-vote', (targetPeerId) => {
      const room = rooms[roomId];
      if (room && room.state === 'playing' && !room.players[peerId].isDead) {
        if (room.phase === 'night' && room.players[peerId].role !== 'vampire') return;
        if (room.players[targetPeerId] && room.players[targetPeerId].isDead) return;
        
        room.votes[peerId] = targetPeerId;
        // Optionally notify others that a vote was casted (without revealing who if we want secret ballot, 
        // or revealing completely if it is day public vote).
        // Let's keep it secret locally. Just ack back.
        socket.emit('vote-acked', targetPeerId);
        broadcastVoteCounts(roomId);
      }
    });

    socket.on('return-to-lobby', () => {
      const room = rooms[roomId];
      if (room && room.host === peerId && room.state === 'finished') {
        room.state = 'lobby';
        room.phase = 'day';
        room.votes = {};
        Object.values(room.players).forEach(p => {
          p.role = null;
          p.isDead = false;
        });
        io.to(roomId).emit('returned-to-lobby');
      }
    });

    socket.on('disconnect', () => {
      socket.to(roomId).emit('user-disconnected', peerId);
      if (rooms[roomId]) {
        delete rooms[roomId].players[peerId];
        if (Object.keys(rooms[roomId].players).length === 0) {
          clearTimer(rooms[roomId]);
          delete rooms[roomId];
        } else if (rooms[roomId].host === peerId) {
            rooms[roomId].host = Object.keys(rooms[roomId].players)[0];
            io.to(roomId).emit('host-changed', rooms[roomId].host);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
