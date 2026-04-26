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
const MODERATOR_GRACE_MS = 3 * 60 * 1000;

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

function buildPublicPlayers(room) {
  const publicPlayers = {};
  Object.entries(room.players).forEach(([id, p]) => {
    publicPlayers[id] = {
      userName: p.userName,
      score: Number(p.score) || 0,
      isDead: !!p.isDead
    };
  });
  return publicPlayers;
}

function buildRoomInfo(room) {
  return {
    admin: room.admin,
    moderator: room.moderator,
    state: room.state,
    phase: room.phase,
    settings: room.settings,
    history: room.history,
    roundsData: room.roundsData || [],
    gamesHistory: room.gamesHistory || [],
    playersBase: buildPublicPlayers(room),
    customRolesMap: room.customRolesMap || {},
    moderatorGrace: room.moderatorGrace ? {
      userName: room.moderatorGrace.userName,
      expiresAt: room.moderatorGrace.expiresAt
    } : null
  };
}

function emitRoomInfo(roomId, targetSocket = null) {
  const room = rooms[roomId];
  if (!room) return;
  const payload = buildRoomInfo(room);
  if (targetSocket) {
    targetSocket.emit('room-info', payload);
  } else {
    io.to(roomId).emit('room-info', payload);
  }
}

function isValidCustomRole(room, role) {
  if (role === '') return true;
  if (role === 'villager' || role === 'vampire') return true;
  return role === 'healer' && !!room.settings.healerEnabled;
}

function getManualRoleLimits(room) {
  return {
    vampire: Math.max(1, Number(room.settings.vampireCount) || 1),
    healer: room.settings.healerEnabled ? 1 : 0
  };
}

function getManualRoleCounts(roleMap = {}) {
  return Object.values(roleMap).reduce((counts, role) => {
    if (role === 'vampire') counts.vampire += 1;
    if (role === 'healer') counts.healer += 1;
    return counts;
  }, { vampire: 0, healer: 0 });
}

function normalizeCustomRoles(room, rawMap = {}) {
  const result = {};
  const limits = getManualRoleLimits(room);
  const counts = { vampire: 0, healer: 0 };

  Object.entries(rawMap || {}).forEach(([targetId, role]) => {
    const player = room.players[targetId];
    if (!player || player.role === 'spectator') return;
    if (room.settings.modEnabled && room.moderator && targetId === room.moderator) return;
    if (!isValidCustomRole(room, role) || role === '' || role === 'villager') return;
    if (role === 'vampire' && counts.vampire >= limits.vampire) return;
    if (role === 'healer' && counts.healer >= limits.healer) return;
    result[targetId] = role;
    if (role === 'vampire') counts.vampire += 1;
    if (role === 'healer') counts.healer += 1;
  });

  return result;
}

function validateManualRoleSelection(room, roleMap = {}) {
  const limits = getManualRoleLimits(room);
  const counts = getManualRoleCounts(roleMap);
  if (counts.vampire !== limits.vampire) {
    return `Oyunu başlatmadan önce ${limits.vampire} vampir seçmeniz gerekiyor.`;
  }
  if (limits.healer > 0 && counts.healer !== 1) {
    return 'Oyunu başlatmadan önce 1 şifacı seçmeniz gerekiyor.';
  }
  return null;
}

function isModeratorUnavailable(room) {
  return !!(room && room.moderatorGrace && room.moderatorGrace.expiresAt > Date.now());
}

function canControlRoom(room, peerId) {
  if (!room || isModeratorUnavailable(room)) return false;
  return (room.moderator && room.moderator === peerId) || (!room.moderator && room.admin === peerId);
}

function clearModeratorGrace(room) {
  if (!room || !room.moderatorGrace) return;
  if (room.moderatorGrace.timer) clearTimeout(room.moderatorGrace.timer);
  room.moderatorGrace = null;
}

function autoAssignModerator(roomId) {
  const room = rooms[roomId];
  if (!room || !room.moderatorGrace) return;

  const candidates = Object.entries(room.players)
    .filter(([, p]) => p.role !== 'spectator')
    .map(([id]) => id);

  const nextModerator = candidates[0] || null;
  clearModeratorGrace(room);

  if (!nextModerator) {
    emitRoomInfo(roomId);
    return;
  }

  room.admin = nextModerator;
  room.moderator = room.settings.modEnabled ? nextModerator : null;

  io.to(roomId).emit('admin-changed', room.admin);
  io.to(roomId).emit('moderator-assigned', room.moderator);
  io.to(roomId).emit('moderator-auto-assigned', {
    peerId: nextModerator,
    userName: room.players[nextModerator]?.userName || 'Yeni Moderator'
  });
  emitRoomInfo(roomId);
}

function getLivingCounts(room) {
  let aliveVampires = 0;
  let aliveVillagers = 0;

  Object.values(room.players).forEach(p => {
    if (!p.isDead && p.role !== 'moderator' && p.role !== 'spectator') {
      if (p.role === 'vampire') aliveVampires++;
      else aliveVillagers++;
    }
  });

  return { aliveVampires, aliveVillagers };
}

function finishGame(roomId, winner, options = {}) {
  const room = rooms[roomId];
  if (!room || room.state !== 'playing') return false;

  const { awardScores = true, forced = false } = options;
  const { aliveVampires } = getLivingCounts(room);

  clearTimer(room);
  room.state = 'finished';

  // Ensure the last round is pushed if it hasn't been yet (e.g. game ended at dawn)
  if (room.currentRoundData && (room.currentRoundData.nightVictim || room.currentRoundData.dayVictim)) {
    const alreadyPushed = room.roundsData.length > 0 && room.roundsData[room.roundsData.length - 1].round === room.currentRoundData.round;
    if (!alreadyPushed) {
      room.roundsData.push(Object.assign({}, room.currentRoundData));
    }
  }

  if (awardScores) {
    Object.values(room.players).forEach(p => {
      if (winner === 'villagers' && (p.role === 'villager' || p.role === 'healer')) {
        p.score = (p.score || 0) + 1;
        if (!p.isDead) p.score += 1; // +1 extra for surviving!
      } else if (winner === 'vampires' && p.role === 'vampire') {
        p.score = (p.score || 0) + 2;
        if (!p.isDead && aliveVampires === 1) p.score += 1; // +1 extra if sole survivor!
      }
    });
  }

  const rolesMap = {};
  Object.entries(room.players).forEach(([id, p]) => {
    rolesMap[id] = { userName: p.userName, role: p.role, isDead: p.isDead, score: p.score || 0 };
    if (p.role === 'spectator') p.role = null;
  });

  if (!room.gamesHistory) room.gamesHistory = [];
  room.gamesHistory.push({
    gameNumber: room.gameNumber || room.gamesHistory.length + 1,
    rounds: room.roundsData.slice()
  });
  io.to(roomId).emit('games-history-updated', room.gamesHistory);

  console.log(`[Room ${roomId}] GAME OVER - Winner: ${winner}${forced ? ' (forced)' : ''}`);
  io.to(roomId).emit('game-over', { winner, playersDetails: rolesMap, forced });
  emitRoomInfo(roomId);
  return true;
}

function checkGameOver(roomId) {
  const room = rooms[roomId];
  if (!room || room.state !== 'playing') return false;
  const { aliveVampires, aliveVillagers } = getLivingCounts(room);

  let winner = null;
  if (aliveVampires === 0) winner = 'villagers';
  else if (aliveVampires >= aliveVillagers) winner = 'vampires';

  if (winner) {
    return finishGame(roomId, winner);
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
    room.history.push({ round: room.round, phase: 'day', event: `${room.players[targetToKill].userName} kasaba halkı tarafından idam edildi.`, flavor: '' });
    io.to(roomId).emit('player-killed', targetToKill, 'day', 'halk idamı', room.players[targetToKill].role);
    emitRoomInfo(roomId);
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
      io.to(roomId).emit('player-saved', room.nightVictim, room.players[room.nightVictim].role);
      room.history.push({ round: room.round, phase: 'night', event: `Vampirler saldırdı ama Şifacı kurbanı son anda kurtardı!`, flavor: room.nightFlavor || '' });
    } else {
      room.currentRoundData.nightVictim = room.players[room.nightVictim].userName;
      room.currentRoundData.healed = false;
      room.players[room.nightVictim].isDead = true;
      room.history.push({ round: room.round, phase: 'night', event: `${room.players[room.nightVictim].userName} vampirler tarafından parçalandı.`, flavor: room.nightFlavor || '' });
      io.to(roomId).emit('player-killed', room.nightVictim, 'night', room.nightFlavor || 'Kanı emildi', room.players[room.nightVictim].role);
      emitRoomInfo(roomId);
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
    const existingRoom = rooms[roomId];
    const grace = existingRoom?.moderatorGrace;
    const isReturningModerator = !!(grace && grace.userName === userName && grace.expiresAt > Date.now());
    let joinedAsReturningModerator = false;

    if (existingRoom && isReturningModerator) {
      socket.join(roomId);

      const restoredPlayer = {
        ...grace.playerSnapshot,
        userName,
        socketId: socket.id
      };
      existingRoom.players[peerId] = restoredPlayer;
      existingRoom.admin = peerId;
      existingRoom.moderator = grace.wasModerator ? peerId : null;

      clearModeratorGrace(existingRoom);

      io.to(roomId).emit('admin-changed', existingRoom.admin);
      io.to(roomId).emit('moderator-assigned', existingRoom.moderator);
      io.to(roomId).emit('moderator-restored', { peerId, userName });
      socket.to(roomId).emit('user-connected', peerId, userName, restoredPlayer.role, restoredPlayer.score || 0);
      emitRoomInfo(roomId, socket);
      emitRoomInfo(roomId);

      if (existingRoom.state === 'playing') {
        socket.emit('game-started', { phase: existingRoom.phase });
        socket.emit('role-assigned', restoredPlayer.role);
      }
      joinedAsReturningModerator = true;
    }

    if (!joinedAsReturningModerator) {
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
          moderatorGrace: null,
          history: [],
          roundsData: [],
          gamesHistory: [], // Array of completed games [{gameNumber, rounds:[...]}]
          settings: {
            dayDuration: 20,
            nightDuration: 15,
            dawnDuration: 15,
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

      const parsedScore = Number(localScore) || 0;
      rooms[roomId].players[peerId] = { userName, role: null, socketId: socket.id, isDead: false, score: parsedScore };

      emitRoomInfo(roomId, socket);

      socket.to(roomId).emit('user-connected', peerId, userName, null, localScore);
      emitRoomInfo(roomId);
    }

    socket.on('approve-spectator', (specData, isApproved) => {
      const room = rooms[roomId];
      if (!room || !canControlRoom(room, peerId)) return;

      if (!isApproved) {
        io.to(specData.socketId).emit('join-rejected', 'Yönetici girişinize izin vermedi.');
        return;
      }

      // Make them join the room!
      const targetSocket = io.sockets.sockets.get(specData.socketId);
      if (targetSocket) {
        targetSocket.join(roomId);
        const parsedScore = Number(specData.localScore) || 0;
        room.players[specData.peerId] = { userName: specData.userName, role: 'spectator', socketId: specData.socketId, isDead: true, score: parsedScore };

        emitRoomInfo(roomId, targetSocket);

        // Force their UI to recognize playing state and spectator role
        targetSocket.emit('game-started', { phase: room.phase });
        targetSocket.emit('role-assigned', 'spectator');

        targetSocket.to(roomId).emit('user-connected', specData.peerId, specData.userName, 'spectator', specData.localScore);
        emitRoomInfo(roomId);
      }
    });

    socket.on('update-settings', (newSettings) => {
      const room = rooms[roomId];
      if (room && canControlRoom(room, peerId) && room.state === 'lobby') {
        room.settings = { ...room.settings, ...newSettings };
        if (!room.settings.modEnabled) {
          room.moderator = null;
          room.customRolesMap = {};
          io.to(roomId).emit('custom-roles-updated', room.customRolesMap);
        }
        if (!room.settings.healerEnabled && room.customRolesMap) {
          Object.entries(room.customRolesMap).forEach(([targetId, role]) => {
            if (role === 'healer') delete room.customRolesMap[targetId];
          });
          io.to(roomId).emit('custom-roles-updated', room.customRolesMap);
        }
        if (room.customRolesMap) {
          room.customRolesMap = normalizeCustomRoles(room, room.customRolesMap);
          io.to(roomId).emit('custom-roles-updated', room.customRolesMap);
        }
        io.to(roomId).emit('moderator-assigned', room.moderator);
        io.to(roomId).emit('settings-updated', room.settings);
        emitRoomInfo(roomId);
      }
    });

    socket.on('assign-moderator', (targetId) => {
      const room = rooms[roomId];
      if (room && canControlRoom(room, peerId) && room.state === 'lobby') {
        room.settings.modEnabled = !!targetId;
        const nextModerator = targetId && room.players[targetId]?.role !== 'spectator' ? targetId : null;
        room.moderator = nextModerator;
        if (nextModerator) {
          room.admin = nextModerator;
          io.to(roomId).emit('admin-changed', nextModerator);
        }
        if (!room.customRolesMap) room.customRolesMap = {};
        if (room.moderator) {
          delete room.customRolesMap[room.moderator];
        } else {
          room.customRolesMap = {};
        }
        io.to(roomId).emit('moderator-assigned', room.moderator);
        io.to(roomId).emit('custom-roles-updated', room.customRolesMap);
        emitRoomInfo(roomId);
      }
    });

    socket.on('update-custom-roles', (roleData) => {
      const room = rooms[roomId];
      if (room && room.state === 'lobby' && room.settings.modEnabled && room.moderator && canControlRoom(room, peerId)) {
        if (!roleData || !room.players[roleData.targetId]) return;
        if (room.players[roleData.targetId].role === 'spectator') return;
        if (room.settings.modEnabled && room.moderator && roleData.targetId === room.moderator) return;
        if (!isValidCustomRole(room, roleData.role)) return;
        if (!room.customRolesMap) room.customRolesMap = {};
        if (roleData.role === 'vampire' || roleData.role === 'healer') {
          const nextRoles = { ...room.customRolesMap, [roleData.targetId]: roleData.role };
          const normalized = normalizeCustomRoles(room, nextRoles);
          if (normalized[roleData.targetId] !== roleData.role) {
            socket.emit('role-selection-error', roleData.role === 'vampire'
              ? `En fazla ${getManualRoleLimits(room).vampire} vampir seçilebilir.`
              : 'En fazla 1 şifacı seçilebilir.');
            return;
          }
        }
        if (roleData.role === '') {
          delete room.customRolesMap[roleData.targetId];
        } else {
          room.customRolesMap[roleData.targetId] = roleData.role;
        }
        io.to(roomId).emit('custom-roles-updated', room.customRolesMap);
        emitRoomInfo(roomId);
      }
    });

    socket.on('start-game', (clientCustomRolesMap) => { // Moderatör role map gönderebilir
      const room = rooms[roomId];
      if (room && canControlRoom(room, peerId) && room.state === 'lobby') {
        const canUseCustomRoles = room.settings.modEnabled && !!room.moderator;
        const rawCustomRolesMap = canUseCustomRoles
          ? (Object.keys(clientCustomRolesMap || {}).length > 0 ? clientCustomRolesMap : (room.customRolesMap || {}))
          : {};
        const normalizedRawRoles = normalizeCustomRoles(room, rawCustomRolesMap);
        if (canUseCustomRoles) {
          const manualRoleError = validateManualRoleSelection(room, normalizedRawRoles);
          if (manualRoleError) {
            socket.emit('start-game-rejected', manualRoleError);
            room.customRolesMap = normalizedRawRoles;
            io.to(roomId).emit('custom-roles-updated', room.customRolesMap);
            emitRoomInfo(roomId);
            return;
          }
        }
        room.state = 'playing';
        room.phase = 'night'; // Start with Night
        room.round = 1;
        room.history = [];
        room.roundsData = [];
        room.currentRoundData = { round: 1, dayVotes: {}, dayVictim: null, nightVictim: null, healed: false, nightKillFlavor: '' };
        // Note: gamesHistory is NOT reset here — it persists across games in the same room

        const playerIds = Object.keys(room.players);

        // Define Players
        let playableIds = playerIds.filter(id => room.players[id].role !== 'spectator');
        if (room.settings.modEnabled && room.moderator) {
          room.players[room.moderator].role = 'moderator';
          playableIds = playableIds.filter(id => id !== room.moderator);
        }

        const customRolesMap = {};
        playableIds.forEach(id => {
          const role = normalizedRawRoles[id];
          if (isValidCustomRole(room, role)) customRolesMap[id] = role;
        });

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
        emitRoomInfo(roomId);

        setTimeout(() => {
          startPhaseTimer(roomId);
        }, 3000); // 3s buffer for slap animations
      }
    });

    socket.on('end-phase-early', () => {
      const room = rooms[roomId];
      if (room && room.state === 'playing') {
        if (canControlRoom(room, peerId)) {
          room.timeLeft = 1;
        }
      }
    });

    socket.on('force-end-game', () => {
      const room = rooms[roomId];
      if (room && room.state === 'playing') {
        if (!canControlRoom(room, peerId)) return;
        const { aliveVampires, aliveVillagers } = getLivingCounts(room);
        const winner = aliveVampires >= aliveVillagers ? 'vampires' : 'villagers';
        finishGame(roomId, winner, { awardScores: false, forced: true });
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
        if (!room.players[targetPeerId]) return;
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
      if (room && canControlRoom(room, peerId) && room.state === 'finished') {
        room.state = 'lobby';
        room.phase = 'day';
        room.votes = {};
        room.gameNumber = (room.gameNumber || 1) + 1;
        room.customRolesMap = {}; // Reset custom roles
        Object.values(room.players).forEach(p => {
          if (p.role !== 'spectator') {
            p.role = null;
            p.isDead = false;
          }
        });
        io.to(roomId).emit('returned-to-lobby');
        emitRoomInfo(roomId);
      }
    });

    socket.on('disconnect', () => {
      socket.to(roomId).emit('user-disconnected', peerId);
      if (rooms[roomId]) {
        const room = rooms[roomId];
        const disconnectedPlayer = room.players[peerId];
        const wasAdmin = room.admin === peerId;
        const wasMod = room.moderator === peerId;
        const wasController = wasAdmin || wasMod;

        delete room.players[peerId];
        const remainingPlayers = Object.keys(room.players);

        if (remainingPlayers.length === 0) {
          clearTimer(room);
          clearModeratorGrace(room);
          delete rooms[roomId];
        } else {
          if (wasController && disconnectedPlayer) {
            clearModeratorGrace(room);
            const expiresAt = Date.now() + MODERATOR_GRACE_MS;
            room.moderatorGrace = {
              oldPeerId: peerId,
              userName: disconnectedPlayer.userName,
              playerSnapshot: disconnectedPlayer,
              wasModerator: wasMod,
              expiresAt,
              timer: setTimeout(() => autoAssignModerator(roomId), MODERATOR_GRACE_MS)
            };
            room.admin = null;
            if (wasMod) room.moderator = null;
            io.to(roomId).emit('admin-changed', null);
            io.to(roomId).emit('moderator-assigned', null);
            io.to(roomId).emit('moderator-unavailable', {
              userName: disconnectedPlayer.userName,
              expiresAt
            });
            emitRoomInfo(roomId);
          } else {
            emitRoomInfo(roomId);
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
