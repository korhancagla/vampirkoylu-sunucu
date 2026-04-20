const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// rooms = { [roomId]: { admin: peerId, moderator: peerId|null, state: 'lobby', phase: 'day', players: {}, votes: {}, settings: { dayDuration: 20, nightDuration: 10, dawnDuration: 10, vampireCount: 1, modEnabled: false, healerEnabled: false, winScore: 5 }, pendingJoins: {}, history: [] } }
const rooms = {};

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
    if (!p.isDead && p.role !== 'moderator' && p.role !== 'spectator') {
      if (p.role === 'vampire') aliveVampires++;
      else aliveVillagers++; // Villager or Healer
    }
  });

  let winner = null;
  if (aliveVampires === 0) winner = 'villagers';
  else if (aliveVampires >= aliveVillagers) winner = 'vampires';

  if (winner) {
    clearTimer(room);
    room.state = 'finished';
    
    // Ensure the last round is pushed if it hasn't been yet (e.g. game ended at dawn)
    if (room.currentRoundData && (room.currentRoundData.nightVictim || room.currentRoundData.dayVictim)) {
       const alreadyPushed = room.roundsData.length > 0 && room.roundsData[room.roundsData.length-1].round === room.currentRoundData.round;
       if (!alreadyPushed) {
          room.roundsData.push(Object.assign({}, room.currentRoundData));
       }
    }

    
    // Update Scores based on new Phase 4 rules
    Object.values(room.players).forEach(p => {
      if (winner === 'villagers' && (p.role === 'villager' || p.role === 'healer')) {
         p.score = (p.score || 0) + 1;
         if (!p.isDead) p.score += 1; // +1 extra for surviving!
      } else if (winner === 'vampires' && p.role === 'vampire') {
         p.score = (p.score || 0) + 2;
         if (!p.isDead && aliveVampires === 1) p.score += 1; // +1 extra if sole survivor!
      }
    });

    const rolesMap = {};
    Object.entries(room.players).forEach(([id, p]) => {
      rolesMap[id] = { userName: p.userName, role: p.role, isDead: p.isDead, score: p.score || 0 };
      if (p.role === 'spectator') p.role = null;
    });

    // Save this game's rounds to gamesHistory before clearing roundsData
    if (!room.gamesHistory) room.gamesHistory = [];
    room.gamesHistory.push({
      gameNumber: room.gameNumber || room.gamesHistory.length + 1,
      rounds: room.roundsData.slice() // snapshot
    });
    // Emit updated gamesHistory along with game-over
    io.to(roomId).emit('games-history-updated', room.gamesHistory);

    console.log(`[Room ${roomId}] GAME OVER - Winner: ${winner}`);
    io.to(roomId).emit('game-over', { winner, playersDetails: rolesMap });
    return true;
  }
  return false;
}

function processNightKills(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  
  const voteCounts = {};
  Object.values(room.votes).forEach(targetId => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });

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

  // If no votes at all, system auto-kills a random living villager/healer
  if (Object.keys(room.votes).length === 0) {
    const livingTownsfolk = Object.entries(room.players)
      .filter(([id, p]) => !p.isDead && (p.role === 'villager' || p.role === 'healer'))
      .map(([id]) => id);

    if (livingTownsfolk.length > 0) {
      targetToKill = livingTownsfolk[Math.floor(Math.random() * livingTownsfolk.length)];
      isTie = false;
    }
  }

  // Store the victim temporarily for the Dawn phase
  if (!isTie && targetToKill && room.players[targetToKill]) {
    room.nightVictim = targetToKill;
    room.currentRoundData.nightVictim = room.players[targetToKill].userName;
    room.currentRoundData.healed = false;
    room.currentRoundData.nightKillFlavor = room.nightFlavor || 'Vampir katliamı';
  } else {
    room.nightVictim = null;
  }

  io.to(roomId).emit('current-round-updated', Object.assign({}, room.currentRoundData));

  room.votes = {};
  io.to(roomId).emit('votes-cleared');
}

function processDayExecution(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const voteCounts = {};
  Object.values(room.votes).forEach(targetId => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });

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

  // Compile dayVotes using user names!
  const translatedDayVotes = {};
  Object.entries(room.votes).forEach(([voterId, targetId]) => {
     if (room.players[voterId] && room.players[targetId]) {
         translatedDayVotes[room.players[voterId].userName] = room.players[targetId].userName;
     }
  });
  room.currentRoundData.dayVotes = translatedDayVotes;

  if (!isTie && targetToKill && room.players[targetToKill]) {
    room.currentRoundData.dayVictim = room.players[targetToKill].userName;
    room.currentRoundData.isTie = false;
    room.players[targetToKill].isDead = true;
    room.history.push({ round: room.round, phase: 'day', event: `${room.players[targetToKill].userName} kasaba halkı tarafından idam edildi.`, flavor: ''});
    io.to(roomId).emit('player-killed', targetToKill, 'day', 'halk idamı');
  } else {
    room.currentRoundData.dayVictim = null;
    room.currentRoundData.isTie = isTie;
  }
  
  // Push the compiled round to roundsData array!
  room.roundsData.push(Object.assign({}, room.currentRoundData));
  io.to(roomId).emit('history-updated', room.history, room.roundsData);
  
  // Increment round THEN reset currentRoundData for next round
  room.round += 1;
  room.currentRoundData = { round: room.round, dayVotes: {}, dayVictim: null, nightVictim: null, healed: false, nightKillFlavor: '', isTie: false };
  io.to(roomId).emit('current-round-updated', Object.assign({}, room.currentRoundData));


  room.votes = {};
  io.to(roomId).emit('votes-cleared');
  return checkGameOver(roomId);
}

function processDawnResolution(roomId) {
   const room = rooms[roomId];
   if (!room) return;

   // Check healer's vote
   const healerVotes = Object.values(room.votes);
   const healedTarget = healerVotes.length > 0 ? healerVotes[0] : null;

   if (room.nightVictim) {
      if (healedTarget === room.nightVictim) {
         room.currentRoundData.nightVictim = room.players[room.nightVictim].userName;
         room.currentRoundData.healed = true;
         io.to(roomId).emit('player-saved', room.nightVictim);
         room.history.push({ round: room.round, phase: 'night', event: `Vampirler saldırdı ama Şifacı kurbanı son anda kurtardı!`, flavor: room.nightFlavor || ''});
      } else {
         room.currentRoundData.nightVictim = room.players[room.nightVictim].userName;
         room.currentRoundData.healed = false;
         room.players[room.nightVictim].isDead = true;
         room.history.push({ round: room.round, phase: 'night', event: `${room.players[room.nightVictim].userName} vampirler tarafından parçalandı.`, flavor: room.nightFlavor || ''});
         io.to(roomId).emit('player-killed', room.nightVictim, 'night', room.nightFlavor || 'Kanı emildi');
      }
      io.to(roomId).emit('history-updated', room.history, room.roundsData);
   }
   
   if (healedTarget && healedTarget !== room.nightVictim && room.players[healedTarget]) {
      io.to(room.players[healedTarget].socketId).emit('healed-empty'); // Fake heal notification for them
   }

   // Emit updated currentRoundData after dawn so healed status is reflected immediately
   io.to(roomId).emit('current-round-updated', Object.assign({}, room.currentRoundData));

   room.nightVictim = null;
   room.nightFlavor = null;
   room.votes = {};
   io.to(roomId).emit('votes-cleared');
   return checkGameOver(roomId);
}

function startPhaseTimer(roomId) {
  const room = rooms[roomId];
  if (!room || room.state !== 'playing') return;

  clearTimer(room);
  
  if (room.phase === 'day') room.timeLeft = room.settings.dayDuration || 20;
  else if (room.phase === 'dawn') room.timeLeft = room.settings.dawnDuration || 10;
  else room.timeLeft = room.settings.nightDuration || 10;

  room.votes = {};
  io.to(roomId).emit('votes-cleared');

  room.timerInterval = setInterval(() => {
    room.timeLeft -= 1;
    io.to(roomId).emit('timer-tick', room.timeLeft);

    if (room.timeLeft <= 0) {
      clearTimer(room);
      let isGameOver = false;

      // Execute end of phase actions
      if (room.phase === 'night') {
         processNightKills(roomId);
         if (room.settings.healerEnabled) {
             room.phase = 'dawn';
         } else {
             isGameOver = processDawnResolution(roomId);
             room.phase = 'day';
         }
      } else if (room.phase === 'dawn') {
         isGameOver = processDawnResolution(roomId);
         room.phase = 'day';
      } else if (room.phase === 'day') {
         room.round += 1;
         isGameOver = processDayExecution(roomId);
         room.phase = 'night';
      }
      
      if (isGameOver) return;
      
      io.to(roomId).emit('phase-changed', room.phase);
      
      setTimeout(() => {
        startPhaseTimer(roomId);
      }, 2000);
    }
  }, 1000);
}

io.on('connection', (socket) => {
  socket.on('join-room', (roomId, peerId, userName, localScore = 0) => {
    // Odada oyun başladıysa girişi pending state'e al
    if (rooms[roomId] && (rooms[roomId].state === 'playing' || rooms[roomId].state === 'finished')) {
      const adminSocket = rooms[roomId].players[rooms[roomId].admin]?.socketId;
      if (adminSocket) {
         io.to(adminSocket).emit('spectator-request', { peerId, userName, socketId: socket.id, localScore });
         socket.emit('spectator-pending', 'Oyun şu an devam ediyor. Odadaki yöneticiden giriş onayı bekleniyor...');
      } else {
         socket.emit('join-rejected', 'Oyun şu an devam ediyor ve yönetici onayı alınamıyor.');
      }
      return;
    }

    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        admin: peerId,
        moderator: null,
        state: 'lobby',
        phase: 'day',
        round: 1,
        gameNumber: 1,
        players: {},
        votes: {},
        nightVictim: null,
        nightFlavor: null,
        timeLeft: 0,
        timerInterval: null,
        history: [],
        roundsData: [],
        gamesHistory: [], // Array of completed games [{gameNumber, rounds:[...]}]
        settings: {
           dayDuration: 20,
           nightDuration: 10,
           dawnDuration: 10,
           vampireCount: 1,
           modEnabled: false,
           healerEnabled: false,
           silentNight: false,
           winScore: 5
        }
      };
    }

    // Check duplicate names
    const existingName = Object.values(rooms[roomId].players).find(p => p.userName === userName);
    if (existingName) {
       socket.emit('join-rejected', 'Bu isimde bir oyuncu içeride zaten var. Lütfen farklı bir isim seçin.');
       return;
    }

    rooms[roomId].players[peerId] = { userName, role: null, socketId: socket.id, isDead: false, score: localScore };

    socket.emit('room-info', { 
      admin: rooms[roomId].admin,
      moderator: rooms[roomId].moderator,
      state: rooms[roomId].state,
      phase: rooms[roomId].phase,
      settings: rooms[roomId].settings,
      history: rooms[roomId].history,
      roundsData: rooms[roomId].roundsData || [],
      gamesHistory: rooms[roomId].gamesHistory || []
    });

    socket.to(roomId).emit('user-connected', peerId, userName);

    socket.on('approve-spectator', (specData, isApproved) => {
       const room = rooms[roomId];
       if (!room || room.admin !== peerId) return;

       if (!isApproved) {
          io.to(specData.socketId).emit('join-rejected', 'Yönetici girişinize izin vermedi.');
          return;
       }

       // Make them join the room!
       const targetSocket = io.sockets.sockets.get(specData.socketId);
       if (targetSocket) {
          targetSocket.join(roomId);
          room.players[specData.peerId] = { userName: specData.userName, role: 'spectator', socketId: specData.socketId, isDead: true, score: specData.localScore };
          
          targetSocket.emit('room-info', {
             admin: room.admin,
             moderator: room.moderator,
             state: room.state,
             phase: room.phase,
             settings: room.settings,
             history: room.history
          });
          
          // Force their UI to recognize playing state and spectator role
          targetSocket.emit('game-started', { phase: room.phase });
          targetSocket.emit('role-assigned', 'spectator');

          io.to(roomId).emit('user-connected', specData.peerId, specData.userName, 'spectator');
       }
    });

    socket.on('update-settings', (newSettings) => {
       const room = rooms[roomId];
       if (room && room.admin === peerId && room.state === 'lobby') {
          room.settings = { ...room.settings, ...newSettings };
          io.to(roomId).emit('settings-updated', room.settings);
       }
    });

    socket.on('assign-moderator', (targetId) => {
       const room = rooms[roomId];
       if (room && room.admin === peerId && room.state === 'lobby' && room.settings.modEnabled) {
          room.moderator = targetId;
          io.to(roomId).emit('moderator-assigned', targetId);
       }
    });

    socket.on('start-game', (customRolesMap) => { // Moderatör role map gönderebilir
      const room = rooms[roomId];
      if (room && (room.admin === peerId || room.moderator === peerId) && room.state === 'lobby') {
        room.state = 'playing';
        room.phase = 'night'; // Start with Night
        room.round = 1;
        room.history = [];
        room.roundsData = [];
        room.currentRoundData = { round: 1, dayVotes: {}, dayVictim: null, nightVictim: null, healed: false, nightKillFlavor: '' };
        // Note: gamesHistory is NOT reset here — it persists across games in the same room

        const playerIds = Object.keys(room.players);
        
        // Setup moderator if active but not selected, auto select
        if (room.settings.modEnabled && !room.moderator) {
           room.moderator = peerId; // System auto assigns admin
        }
        
        // Define Players
        let playableIds = playerIds;
        if (room.settings.modEnabled && room.moderator) {
           room.players[room.moderator].role = 'moderator';
           playableIds = playerIds.filter(id => id !== room.moderator);
        }

        if (customRolesMap && Object.keys(customRolesMap).length > 0) {
           // Mod defined roles
           playableIds.forEach(id => {
              room.players[id].role = customRolesMap[id] || 'villager';
              room.players[id].isDead = false;
           });
        } else {
           // Auto Random
           for (let i = playableIds.length - 1; i > 0; i--) {
               const j = Math.floor(Math.random() * (i + 1));
               [playableIds[i], playableIds[j]] = [playableIds[j], playableIds[i]];
           }
           const vCount = Math.min(room.settings.vampireCount, playableIds.length - 1);
           playableIds.forEach((id, index) => {
             let role = 'villager';
             if (index < vCount) role = 'vampire';
             else if (index === vCount && room.settings.healerEnabled) role = 'healer';
             room.players[id].role = role;
             room.players[id].isDead = false;
           });
        }

        // Emit assignments
        playerIds.forEach(id => {
          io.to(room.players[id].socketId).emit('role-assigned', room.players[id].role);
        });

        io.to(roomId).emit('game-started', { phase: 'night' });
        
        setTimeout(() => {
           startPhaseTimer(roomId);
        }, 3000); // 3s buffer for slap animations
      }
    });

    socket.on('end-phase-early', () => {
      const room = rooms[roomId];
      if (room && room.state === 'playing') {
         // Moderatör süreyi sonlandırdı (Either explicit moderator or auto-mod admin)
         const isActiveModerator = (room.moderator === peerId) || (!room.moderator && room.admin === peerId);
         if (isActiveModerator) {
             room.timeLeft = 1; 
         }
      }
    });

    socket.on('transfer-admin', (newAdminId) => {
       const room = rooms[roomId];
       if (room && room.admin === peerId && room.state === 'lobby') {
           if (room.players[newAdminId]) {
               room.admin = newAdminId;
               io.to(roomId).emit('admin-changed', newAdminId);
               
               // Update roles appropriately
               if (room.moderator === newAdminId) {
                   room.moderator = null; // New admin cannot be the explicit mod assigned, they become auto-mod
                   io.to(roomId).emit('moderator-changed', null);
               }
           }
       }
    });

    socket.on('kill-flavor-text', (text) => {
       const room = rooms[roomId];
       if (room && room.phase === 'night' && room.players[peerId].role === 'vampire') {
          room.nightFlavor = text;
       }
    });

    socket.on('submit-vote', (targetPeerId) => {
      const room = rooms[roomId];
      if (room && room.state === 'playing' && !room.players[peerId].isDead) {
        if (room.phase === 'dawn' && room.players[peerId].role !== 'healer') return;
        if (room.phase === 'night' && room.players[peerId].role !== 'vampire') return;
        if (room.players[targetPeerId] && room.players[targetPeerId].isDead) return;
        
        room.votes[peerId] = targetPeerId;
        socket.emit('vote-acked', targetPeerId);
        broadcastVoteCounts(roomId);
      }
    });

    socket.on('return-to-lobby', () => {
      const room = rooms[roomId];
      if (room && (room.admin === peerId || room.moderator === peerId) && room.state === 'finished') {
        room.state = 'lobby';
        room.phase = 'day';
        room.votes = {};
        room.gameNumber = (room.gameNumber || 1) + 1;
        Object.values(room.players).forEach(p => {
          if (p.role !== 'spectator') {
             p.role = null;
             p.isDead = false;
          }
        });
        io.to(roomId).emit('returned-to-lobby');
      }
    });

    socket.on('disconnect', () => {
      socket.to(roomId).emit('user-disconnected', peerId);
      if (rooms[roomId]) {
        const wasAdmin = rooms[roomId].admin === peerId;
        const wasMod = rooms[roomId].moderator === peerId;
        
        delete rooms[roomId].players[peerId];
        const remainingPlayers = Object.keys(rooms[roomId].players);
        
        if (remainingPlayers.length === 0) {
          clearTimer(rooms[roomId]);
          delete rooms[roomId];
        } else {
           if (wasAdmin) {
              rooms[roomId].admin = wasMod && remainingPlayers.includes(rooms[roomId].moderator) ? rooms[roomId].moderator : remainingPlayers[0];
              io.to(roomId).emit('admin-changed', rooms[roomId].admin);
           }
           if (wasMod) {
              rooms[roomId].moderator = null;
              io.to(roomId).emit('moderator-changed', null);
           }
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
