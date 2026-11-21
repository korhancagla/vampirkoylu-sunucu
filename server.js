const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Vampir Köylü sunucusu çalışıyor'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ---------------------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------------------
const rooms = {};
// Testlerde süreleri kısaltmak için ortam değişkenleri (normalde kullanılmaz)
const TICK_MS = Number(process.env.TICK_MS) || 1000;                     // 1 "saniye"
const LOBBY_GRACE_MS = Number(process.env.LOBBY_GRACE_MS) || 60 * 1000;  // Lobide sayfa yenileme / telefon kilidi için bekleme
const GAME_GRACE_MS = Number(process.env.GAME_GRACE_MS) || 5 * 60 * 1000; // Oyunda yeniden bağlanma süresi (telefon kilitlenince kopar); sonra "terk etti"
const AVATAR_COUNT = 25;
const IN_PERSON_MAX_DELAY = 20;     // Yan yana modunda eylemden sonra en fazla bu kadar saniye rastgele beklenir
const MIN_PLAYERS = 4;
const AUTO_ADVANCE_SECONDS = 1;     // Herkes eylemini yapınca kalan süre
const PHASE_GAP_MS = 2 * TICK_MS;
const FAST_GAP_MS = 0.3 * TICK_MS;   // Herkes eylemini yapıp aşama erken bitince kısa ara
const GAME_START_DELAY_MS = 3.5 * TICK_MS;
const CHAT_LIMIT = 100;
const CHAT_MAX_LEN = 200;
const WILL_MAX_LEN = 300;
const NAME_MAX_LEN = 20;
const ROOM_MAX_LEN = 40;

const TOWN_ROLES = ['villager', 'healer', 'seer', 'hunter', 'elder'];
const SPECIAL_ROLES = [
  ['healer', 'healerEnabled'],
  ['seer', 'seerEnabled'],
  ['hunter', 'hunterEnabled'],
  ['jester', 'jesterEnabled'],
  ['elder', 'elderEnabled'],
];

const DEFAULT_SETTINGS = {
  dayDuration: 60,
  nightDuration: 30,
  dawnDuration: 15,
  defenseDuration: 20,
  verdictDuration: 15,
  hunterDuration: 20,
  vampireCount: 1,
  modEnabled: false,
  healerEnabled: true,
  seerEnabled: false,
  hunterEnabled: false,
  jesterEnabled: false,
  elderEnabled: false,
  peacefulFirstNight: false,
  trialEnabled: true,
  revealRoles: true,
  silentNight: true,
  inPersonMode: false,
  winScore: 5,
};

const DURATION_LIMITS = {
  dayDuration: [15, 600],
  nightDuration: [10, 300],
  dawnDuration: [5, 120],
  defenseDuration: [5, 120],
  verdictDuration: [5, 120],
  hunterDuration: [5, 60],
};
const BOOL_SETTINGS = ['healerEnabled', 'seerEnabled', 'hunterEnabled', 'jesterEnabled', 'trialEnabled', 'revealRoles', 'silentNight', 'inPersonMode', 'elderEnabled', 'peacefulFirstNight'];

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------
const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const sameName = (a, b) => a.toLocaleLowerCase('tr') === b.toLocaleLowerCase('tr');
const maxVampires = (n) => Math.max(1, Math.floor((n - 1) / 2));
const recommendedVampires = (n) => Math.max(1, Math.floor(n / 4));
const pickRandom = (list) => list[Math.floor(Math.random() * list.length)];

function sanitizeSettings(current, incoming) {
  const next = { ...current };
  if (!incoming || typeof incoming !== 'object') return next;
  Object.entries(DURATION_LIMITS).forEach(([key, [min, max]]) => {
    if (key in incoming) next[key] = clampInt(incoming[key], min, max, current[key]);
  });
  if ('vampireCount' in incoming) next.vampireCount = clampInt(incoming.vampireCount, 1, 10, current.vampireCount);
  if ('winScore' in incoming) next.winScore = clampInt(incoming.winScore, 1, 100, current.winScore);
  BOOL_SETTINGS.forEach((key) => {
    if (key in incoming) next[key] = !!incoming[key];
  });
  return next;
}

const isParticipant = (p) => !!p && !p.left && p.role !== 'moderator' && p.role !== 'spectator';
const isAlive = (p) => isParticipant(p) && !p.isDead;
const entries = (room) => Object.entries(room.players);
const aliveIds = (room) => entries(room).filter(([, p]) => isAlive(p)).map(([id]) => id);
const vampireIds = (room) => entries(room).filter(([, p]) => p.role === 'vampire').map(([id]) => id);
const aliveVampireIds = (room) => entries(room).filter(([, p]) => p.role === 'vampire' && isAlive(p)).map(([id]) => id);
const lobbyParticipantIds = (room) => entries(room)
  .filter(([id, p]) => id !== room.moderator && p.role !== 'spectator')
  .map(([id]) => id);
const findAliveRole = (room, role) => entries(room).find(([, p]) => p.role === role && isAlive(p));
const nameOf = (room, pid) => room.players[pid]?.userName || 'Bilinmeyen';
const scoreOf = (room, name) => Number(room.scoreBook[name]) || 0;

function emitTo(room, pid, event, ...args) {
  const p = room.players[pid];
  if (p && p.connected && p.socketId) io.to(p.socketId).emit(event, ...args);
}
function emitToIds(room, ids, event, ...args) {
  [...new Set(ids)].forEach((pid) => emitTo(room, pid, event, ...args));
}
const controllerId = (room) => room.moderator || room.admin;
const canControl = (room, pid) => !!pid && controllerId(room) === pid;

function freshActions() {
  return { votes: {}, seer: null, heal: null, verdict: {}, hunterShot: null };
}
function freshRound(round) {
  return {
    round, dayVotes: {}, dayVictim: null, nightVictim: null, healed: false, savedName: null,
    nightKillFlavor: '', isTie: false, trial: null, hunterShot: null, left: [],
  };
}

function createRoom(roomId, adminId) {
  return {
    id: roomId,
    admin: adminId,
    moderator: null,
    state: 'lobby',
    phase: 'lobby',
    phaseOpen: false,
    round: 1,
    gameNumber: 1,
    players: {},
    pending: {},
    actions: freshActions(),
    pendingKill: null,
    pendingHunter: null,
    nightFlavor: null,
    trial: null,
    hunter: null,
    timeLeft: 0,
    timerInterval: null,
    gapTimer: null,
    history: [],
    roundsData: [],
    currentRoundData: null,
    gamesHistory: [],
    customRolesMap: {},
    scoreBook: {},
    statsBook: {},
    chat: { all: [], vampire: [], dead: [] },
    settings: { ...DEFAULT_SETTINGS },
  };
}

// ---------------------------------------------------------------------------
// Durum yayını
// ---------------------------------------------------------------------------
function publicPlayers(room) {
  const finished = room.state === 'finished';
  const result = {};
  entries(room).forEach(([id, p]) => {
    const revealed = finished || (p.isDead && room.settings.revealRoles && isParticipantRole(p.role));
    result[id] = {
      userName: p.userName,
      score: scoreOf(room, p.userName),
      isDead: !!p.isDead,
      connected: !!p.connected,
      left: !!p.left,
      isSpectator: p.role === 'spectator',
      isModerator: id === room.moderator,
      role: revealed ? p.role : null,
      will: p.isDead && room.state !== 'lobby' ? (p.will || '') : '',
      avatar: p.avatar || 1,
      camOn: !!p.camOn,
      micOn: !!p.micOn,
      deathCause: p.isDead && room.state !== 'lobby' && p.role !== 'spectator' ? (p.deathCause || null) : null,
      deathRound: p.isDead && room.state !== 'lobby' ? (p.deathRound || null) : null,
      stats: room.statsBook[p.userName] || { games: 0, wins: 0, lastGain: 0 },
    };
  });
  return result;
}
const isParticipantRole = (role) => role && role !== 'spectator' && role !== 'moderator';

// Oyun sürerken kurtarılan kişinin adı gizli; roller sadece "ölünce rolü göster" açıksa görünür
function publicRounds(rounds, finished, reveal = false) {
  return rounds.map((r) => {
    if (finished) return { ...r };
    const copy = { ...r, savedName: null };
    if (!reveal) {
      copy.nightVictimRole = null;
      copy.dayVictimRole = null;
      copy.hunterShotRole = null;
    }
    return copy;
  });
}
const roomRounds = (room) => publicRounds(room.roundsData, room.state === 'finished', room.settings.revealRoles);
const roomCurrentRound = (room) => (room.currentRoundData ? publicRounds([room.currentRoundData], false, room.settings.revealRoles)[0] : null);

function publicTrial(room) {
  if (!room.trial) return null;
  return { accused: room.trial.accused || null, candidates: room.trial.candidates || [] };
}

function buildRoomInfo(room, forPid) {
  const n = lobbyParticipantIds(room).length;
  return {
    admin: room.admin,
    moderator: room.moderator,
    state: room.state,
    phase: room.phase,
    phaseOpen: !!room.phaseOpen,
    paused: !!room.paused,
    round: room.round,
    timeLeft: room.timerInterval || room.phaseOpen || room.paused ? room.timeLeft : null,
    settings: room.settings,
    history: room.history,
    roundsData: roomRounds(room),
    currentRoundData: roomCurrentRound(room),
    gamesHistory: room.gamesHistory,
    playersBase: publicPlayers(room),
    customRolesMap: forPid && forPid === room.moderator ? room.customRolesMap : {},
    trial: publicTrial(room),
    hunter: room.hunter ? room.hunter.pid : null,
    limits: { minPlayers: MIN_PLAYERS, recommendedVampires: recommendedVampires(n), maxVampires: maxVampires(n) },
  };
}

function emitRoomInfo(room) {
  entries(room).forEach(([pid, p]) => {
    if (p.connected) io.to(p.socketId).emit('room-info', buildRoomInfo(room, pid));
  });
}

function privateState(room, pid) {
  const p = room.players[pid];
  if (!p) return null;
  const state = {
    playerId: pid,
    role: p.role,
    isDead: !!p.isDead,
    will: p.will || '',
    teammates: [],
    seerResults: p.seerResults || [],
    lastHealTarget: p.lastHealTarget || null,
    selfHealUsed: !!p.selfHealUsed,
    killedBy: p.killedBy || null,
    elderShieldUsed: !!p.elderShieldUsed,
    allRoles: null,
  };
  if (room.state === 'playing' && (p.role === 'vampire' || pid === room.moderator)) state.teammates = vampireIds(room);
  if (room.state === 'playing' && pid === room.moderator) {
    state.allRoles = Object.fromEntries(entries(room).map(([id, q]) => [id, q.role]));
  }
  return state;
}

function emitPrivateState(room, pid) {
  const state = privateState(room, pid);
  if (state) emitTo(room, pid, 'private-state', state);
}
function emitPrivateStates(room) {
  Object.keys(room.players).forEach((pid) => emitPrivateState(room, pid));
}

// Oy sayıları sadece görmesi gerekenlere gider
function voteCounts(votes) {
  const counts = {};
  Object.values(votes).forEach((target) => {
    if (target) counts[target] = (counts[target] || 0) + 1;
  });
  return counts;
}

function broadcastVotes(room) {
  const counts = voteCounts(room.actions.votes);
  if (room.phase === 'day' || room.phase === 'revote') {
    io.to(room.id).emit('vote-counts', counts);
  } else if (room.phase === 'night') {
    emitToIds(room, [...vampireIds(room), room.moderator].filter(Boolean), 'vote-counts', counts);
  } else if (room.phase === 'dawn' && room.moderator) {
    emitTo(room, room.moderator, 'vote-counts', room.actions.heal ? { [room.actions.heal]: 1 } : {});
  }
}

function broadcastVerdict(room) {
  const values = Object.values(room.actions.verdict);
  io.to(room.id).emit('verdict-counts', {
    guilty: values.filter(Boolean).length,
    innocent: values.filter((v) => !v).length,
    voters: Object.keys(room.actions.verdict),
  });
}

// ---------------------------------------------------------------------------
// Sohbet
// ---------------------------------------------------------------------------
function chatAccess(room, pid) {
  const p = room.players[pid];
  if (!p) return { read: [], write: [] };
  if (room.state !== 'playing') return { read: ['all'], write: ['all'] };
  const isMod = pid === room.moderator;
  const ghost = p.isDead || p.role === 'spectator' || p.left;
  const read = ['all'];
  const write = [];
  const quietPhase = room.settings.silentNight && ['night', 'dawn'].includes(room.phase);
  if (isMod || (!ghost && !quietPhase)) write.push('all');
  if (p.role === 'vampire' || isMod) {
    read.push('vampire');
    if (p.role === 'vampire' && !p.isDead) write.push('vampire');
  }
  if (ghost || isMod) {
    read.push('dead');
    if (ghost) write.push('dead');
  }
  return { read, write };
}

function chatDeniedReason(room, pid, channel) {
  const p = room.players[pid];
  const ghost = p.isDead || p.role === 'spectator' || p.left;
  if (channel === 'all') {
    if (ghost) return 'Ölüler ve izleyiciler genel sohbete yazamaz; Ölüler kanalını kullan.';
    return 'Gece köy uyuyor; genel sohbet sabah açılacak.';
  }
  if (channel === 'vampire') return p.role === 'vampire' ? 'Öldüğün için vampir kanalına artık yazamazsın.' : 'Bu kanal sadece vampirlere açık.';
  return 'Ölüler kanalı sadece ölüler ve izleyicilere açık.';
}

function pushChat(room, channel, message) {
  const list = room.chat[channel];
  list.push(message);
  if (list.length > CHAT_LIMIT) list.splice(0, list.length - CHAT_LIMIT);
  Object.keys(room.players).forEach((pid) => {
    if (chatAccess(room, pid).read.includes(channel)) emitTo(room, pid, 'chat-message', message);
  });
}

function systemChat(room, channel, text) {
  pushChat(room, channel, { id: crypto.randomUUID(), channel, from: null, fromName: 'Sistem', text, ts: Date.now() });
}

function sendChatHistory(room, pid) {
  const { read, write } = chatAccess(room, pid);
  const history = {};
  read.forEach((ch) => { history[ch] = room.chat[ch]; });
  emitTo(room, pid, 'chat-history', { history, write });
}
function emitChatAccess(room) {
  Object.keys(room.players).forEach((pid) => sendChatHistory(room, pid));
}

// ---------------------------------------------------------------------------
// Faz motoru
// ---------------------------------------------------------------------------
function clearTimers(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  if (room.gapTimer) clearTimeout(room.gapTimer);
  if (room.autoTimer) clearTimeout(room.autoTimer);
  room.timerInterval = null;
  room.gapTimer = null;
  room.autoTimer = null;
}

function runTicker(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    room.timeLeft -= 1;
    io.to(room.id).emit('timer-tick', Math.max(0, room.timeLeft));
    if (room.timeLeft <= 0) {
      clearTimers(room);
      endPhase(room);
    }
  }, TICK_MS);
}

function durationFor(room, phase) {
  const s = room.settings;
  switch (phase) {
    case 'night': return s.nightDuration;
    case 'dawn': return s.dawnDuration;
    case 'day': return s.dayDuration;
    case 'revote': return Math.max(15, s.verdictDuration);
    case 'defense': return s.defenseDuration;
    case 'verdict': return s.verdictDuration;
    case 'hunter': return s.hunterDuration;
    default: return 10;
  }
}

function startPhase(room, phase) {
  if (room.state !== 'playing') return;
  clearTimers(room);
  room.phase = phase;
  room.phaseOpen = true;
  room.paused = false;
  room.actions = freshActions();
  room.timeLeft = durationFor(room, phase);
  io.to(room.id).emit('votes-cleared');
  io.to(room.id).emit('phase-changed', phase, {
    timeLeft: room.timeLeft,
    trial: publicTrial(room),
    hunter: room.hunter ? room.hunter.pid : null,
    round: room.round,
  });
  emitRoomInfo(room);
  emitChatAccess(room);
  runTicker(room);
}

function goTo(room, phase) {
  clearTimers(room);
  const gap = room.fastNext ? FAST_GAP_MS : PHASE_GAP_MS;
  room.fastNext = false;
  room.gapTimer = setTimeout(() => startPhase(room, phase), gap);
}

// Herkes eylemini yaptıysa aşamayı tam "seconds" saniye sonra bitirir ve sonraki aşamaya kısa arayla geçer
function shortenTimer(room, seconds = AUTO_ADVANCE_SECONDS) {
  if (room.paused || !room.timerInterval || room.timeLeft <= seconds) return;
  clearInterval(room.timerInterval);
  room.timerInterval = null;
  room.timeLeft = seconds;
  room.fastNext = true;
  io.to(room.id).emit('timer-tick', room.timeLeft);
  room.gapTimer = setTimeout(() => {
    room.gapTimer = null;
    room.timeLeft = 0;
    io.to(room.id).emit('timer-tick', 0);
    endPhase(room);
  }, seconds * TICK_MS);
}

// Herkes eylemini yapınca çağrılır. Yan yana modunda süre ekranda değişmez; aşama 0-20 sn arası
// rastgele bir anda biter ki masadakiler kimin telefonla eylem yaptığını çıkaramasın.
function autoAdvance(room) {
  if (room.paused || !room.timerInterval) return;
  if (!room.settings.inPersonMode) {
    shortenTimer(room);
    return;
  }
  if (room.autoTimer) return;
  const delay = Math.floor(Math.random() * (IN_PERSON_MAX_DELAY + 1));
  if (delay >= room.timeLeft) return; // süre zaten daha önce dolacak
  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;
    if (room.paused || !room.phaseOpen) return;
    clearTimers(room);
    endPhase(room);
  }, delay * TICK_MS);
}

// İlk gece barışı: oyunu uzatmak için 1. gece kimse öldürülemez
const isPeacefulNight = (room) => !!room.settings.peacefulFirstNight && room.round === 1;

// Bu aşamada herkes yapması gerekeni yaptı mı?
function readyToAdvance(room) {
  const a = room.actions;
  switch (room.phase) {
    case 'night': {
      const vampires = isPeacefulNight(room) ? [] : aliveVampireIds(room);
      const allVoted = vampires.every((id) => a.votes[id]);
      const agreed = vampires.length === 0 || new Set(vampires.map((id) => a.votes[id])).size === 1;
      const seerReady = !findAliveRole(room, 'seer') || !!a.seer;
      return allVoted && agreed && seerReady;
    }
    case 'dawn': return !!a.heal;
    case 'verdict': return aliveIds(room).filter((id) => id !== room.trial?.accused).every((id) => id in a.verdict);
    case 'hunter': return !!a.hunterShot;
    default: return false;
  }
}

function setPaused(room, paused) {
  if (room.state !== 'playing' || !room.phaseOpen || room.paused === paused) return;
  room.paused = paused;
  if (paused) {
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.timerInterval = null;
    if (room.autoTimer) clearTimeout(room.autoTimer);
    room.autoTimer = null;
  } else {
    runTicker(room);
  }
  io.to(room.id).emit('pause-changed', paused, room.timeLeft);
  if (!paused && readyToAdvance(room)) autoAdvance(room);
  emitRoomInfo(room);
}

function endPhase(room) {
  if (room.state !== 'playing') return;
  // Sonuç hesaplanırken ve faz geçişinde gelen eylemler kaybolmasın diye reddedilir
  room.phaseOpen = false;
  io.to(room.id).emit('phase-ended', room.phase);
  switch (room.phase) {
    case 'night':
      resolveNight(room);
      // Şifacı ölmüşse ve roller açıksa şafağı boşuna bekletmeyiz (gizli rollerde bilgi sızmasın diye bekletilir)
      if (room.settings.healerEnabled && (findAliveRole(room, 'healer') || !room.settings.revealRoles)) return goTo(room, 'dawn');
      return resolveDawn(room);
    case 'dawn':
      return resolveDawn(room);
    case 'day':
    case 'revote':
      return resolveDay(room);
    case 'defense':
      return goTo(room, 'verdict');
    case 'verdict':
      return resolveVerdict(room);
    case 'hunter':
      return resolveHunter(room);
    default:
      return undefined;
  }
}

function killPlayer(room, pid, cause, flavor = '') {
  const p = room.players[pid];
  if (!p || p.isDead) return;
  p.isDead = true;
  p.deathCause = cause;
  p.deathRound = room.round;
  const reveal = room.settings.revealRoles;
  const events = {
    night: `${p.userName} vampirler tarafından parçalandı.`,
    day: `${p.userName} kasaba halkı tarafından idam edildi.`,
    hunter: `${p.userName} avcının son kurşunuyla vuruldu.`,
    left: `${p.userName} oyunu terk etti.`,
  };
  room.history.push({ round: room.round, phase: cause, event: events[cause] || `${p.userName} öldü.`, flavor });
  io.to(room.id).emit('player-killed', pid, cause, flavor, reveal ? p.role : null, p.will || '');
  if (p.role === 'hunter' && cause !== 'left') room.pendingHunter = pid;
  emitPrivateState(room, pid);
  sendChatHistory(room, pid);
}

function checkWinner(room) {
  const alive = aliveIds(room);
  const vampires = alive.filter((id) => room.players[id].role === 'vampire').length;
  const others = alive.length - vampires;
  if (vampires === 0) return 'villagers';
  // Vampirler sayıca üstün olunca ya da 1'e 1 kalınca kazanır; eşitlikte (2-2 gibi) oyun sürer
  if (vampires > others || (vampires === 1 && others === 1)) return 'vampires';
  return null;
}

// Ölümlerden sonra: avcı, kazanan kontrolü, sonraki faz
function afterDeaths(room, nextPhase) {
  if (room.state !== 'playing') return;
  emitRoomInfo(room);
  emitPrivateStates(room);
  const winner = checkWinner(room);
  if (winner === 'villagers') return finishGame(room, winner);
  if (room.pendingHunter) {
    const hunterId = room.pendingHunter;
    room.pendingHunter = null;
    room.hunter = { pid: hunterId, next: nextPhase };
    return goTo(room, 'hunter');
  }
  if (winner) return finishGame(room, winner);
  return goTo(room, nextPhase);
}

function pluralityTarget(votes) {
  const counts = voteCounts(votes);
  let max = 0;
  let top = [];
  Object.entries(counts).forEach(([target, count]) => {
    if (count > max) { max = count; top = [target]; } else if (count === max) top.push(target);
  });
  return { top, max, counts };
}

function resolveNight(room) {
  if (isPeacefulNight(room)) room.actions.votes = {};
  const { top } = pluralityTarget(room.actions.votes);
  const valid = top.filter((id) => isAlive(room.players[id]) && room.players[id].role !== 'vampire');
  // Vampirler farklı kişilerde berabere kalırsa kimse ölmez: takım anlaşmak zorunda
  room.pendingKill = valid.length === 1 ? valid[0] : null;
  room.pendingKillers = room.pendingKill
    ? Object.entries(room.actions.votes).filter(([, t]) => t === room.pendingKill).map(([v]) => nameOf(room, v))
    : [];
  if (valid.length > 1) {
    systemChat(room, 'vampire', `Oylar eşit kaldı (${valid.map((id) => nameOf(room, id)).join(', ')}); bu gece kimse ölmedi. Bir dahaki gece aynı kişiyi seçin.`);
  } else if (!room.pendingKill && isPeacefulNight(room)) {
    systemChat(room, 'vampire', 'İlk gece barışı: bu gece kimse öldürülemez. Takımınızı tanıyın, yarın gece avlanırsınız.');
  } else if (!room.pendingKill) {
    systemChat(room, 'vampire', 'Bu gece kimse hedef seçilmedi; gece kansız geçti.');
  } else {
    systemChat(room, 'vampire', `Bu gecenin hedefi: ${nameOf(room, room.pendingKill)}.`);
  }

  const seerEntry = findAliveRole(room, 'seer');
  if (seerEntry && room.actions.seer && room.players[room.actions.seer]) {
    const [seerId, seer] = seerEntry;
    const target = room.players[room.actions.seer];
    const result = { round: room.round, targetId: room.actions.seer, name: target.userName, isVampire: target.role === 'vampire' };
    seer.seerResults = [...(seer.seerResults || []), result];
    emitTo(room, seerId, 'seer-result', result);
  }
  room.actions.votes = {};
}

function resolveDawn(room) {
  const healerEntry = findAliveRole(room, 'healer');
  const heal = healerEntry ? room.actions.heal : null;
  if (healerEntry) {
    const [healerId, healer] = healerEntry;
    healer.lastHealTarget = heal || null;
    if (heal && heal === healerId) healer.selfHealUsed = true;
  }
  const target = room.pendingKill;
  room.pendingKill = null;
  const rd = room.currentRoundData;
  if (target && room.players[target]) {
    rd.nightVictim = room.players[target].userName;
    rd.nightKillFlavor = room.nightFlavor || '';
    const victim = room.players[target];
    if (heal !== target && victim.role === 'elder' && !victim.elderShieldUsed) {
      victim.elderShieldUsed = true;
      rd.elderSurvived = true;
      rd.nightVictim = null;
      room.history.push({ round: room.round, phase: 'night', event: 'Vampirler saldırdı ama kurban saldırıdan sağ çıktı!', flavor: '' });
      io.to(room.id).emit('player-saved');
      emitTo(room, target, 'elder-survived');
    } else if (heal === target) {
      rd.healed = true;
      rd.savedName = room.players[target].userName;
      room.history.push({ round: room.round, phase: 'night', event: 'Vampirler saldırdı ama Şifacı kurbanı son anda kurtardı!', flavor: '' });
      io.to(room.id).emit('player-saved');
      rd.nightVictim = null;
    } else {
      rd.nightVictimRole = room.players[target].role;
      room.players[target].killedBy = room.pendingKillers || [];
      emitTo(room, target, 'killed-by', room.players[target].killedBy);
      killPlayer(room, target, 'night', room.nightFlavor || 'Kanı emildi');
    }
  }
  room.nightFlavor = null;
  io.to(room.id).emit('history-updated', room.history, roomRounds(room));
  io.to(room.id).emit('current-round-updated', roomCurrentRound(room));
  afterDeaths(room, 'day');
}

function recordDayVotes(room) {
  const translated = {};
  Object.entries(room.actions.votes).forEach(([voter, target]) => {
    if (room.players[voter] && room.players[target]) translated[room.players[voter].userName] = room.players[target].userName;
  });
  room.currentRoundData.dayVotes = translated;
}

function endRound(room) {
  room.roundsData.push({ ...room.currentRoundData });
  room.round += 1;
  room.currentRoundData = freshRound(room.round);
  io.to(room.id).emit('history-updated', room.history, roomRounds(room));
  io.to(room.id).emit('current-round-updated', roomCurrentRound(room));
}

function resolveDay(room) {
  recordDayVotes(room);
  const { top } = pluralityTarget(room.actions.votes);
  const candidates = top.filter((id) => isAlive(room.players[id]));
  const wasRevote = room.phase === 'revote';

  if (candidates.length === 0) {
    room.currentRoundData.isTie = false;
    room.trial = null;
    endRound(room);
    return afterDeaths(room, 'night');
  }
  if (candidates.length > 1) {
    if (!wasRevote) {
      room.currentRoundData.firstVotes = { ...room.currentRoundData.dayVotes };
      room.trial = { candidates, revote: true };
      systemChat(room, 'all', `Oylar eşit: ${candidates.map((id) => nameOf(room, id)).join(', ')}. Sadece bu adaylar arasında yeniden oylama yapılacak.`);
      return goTo(room, 'revote');
    }
    room.currentRoundData.isTie = true;
    room.trial = null;
    endRound(room);
    return afterDeaths(room, 'night');
  }

  const accused = candidates[0];
  if (room.settings.trialEnabled) {
    room.trial = { accused, candidates: [accused] };
    return goTo(room, 'defense');
  }
  room.trial = null;
  return executePlayer(room, accused);
}

function resolveVerdict(room) {
  const accused = room.trial?.accused;
  const values = Object.values(room.actions.verdict);
  const guilty = values.filter(Boolean).length;
  const innocent = values.length - guilty;
  room.currentRoundData.trial = { accused: nameOf(room, accused), guilty, innocent, executed: guilty > innocent };
  room.trial = null;
  if (accused && guilty > innocent && isAlive(room.players[accused])) return executePlayer(room, accused);
  room.history.push({ round: room.round, phase: 'day', event: `${nameOf(room, accused)} savunmasını yaptı ve halk onu bıraktı (${guilty} asılsın / ${innocent} bırakılsın).`, flavor: '' });
  endRound(room);
  return afterDeaths(room, 'night');
}

function executePlayer(room, pid) {
  const p = room.players[pid];
  room.currentRoundData.dayVictim = p.userName;
  room.currentRoundData.dayVictimRole = p.role;
  killPlayer(room, pid, 'day');
  if (p.role === 'jester') {
    endRound(room);
    return finishGame(room, 'jester', { jesterId: pid });
  }
  endRound(room);
  return afterDeaths(room, 'night');
}

function resolveHunter(room) {
  const info = room.hunter;
  room.hunter = null;
  if (!info) return goTo(room, 'night');
  const shot = room.actions.hunterShot;
  if (shot && isAlive(room.players[shot])) {
    // Gündüz idamından sonra tur zaten kapanmıştır; atış o tura yazılır
    const rd = info.next === 'night' && room.roundsData.length
      ? room.roundsData[room.roundsData.length - 1]
      : room.currentRoundData;
    rd.hunterShot = room.players[shot].userName;
    rd.hunterShotRole = room.players[shot].role;
    // Deli avcı tarafından vurulursa kazanamaz; sadece idamla kazanır
    killPlayer(room, shot, 'hunter', 'Avcının son kurşunu');
    io.to(room.id).emit('history-updated', room.history, roomRounds(room));
  }
  return afterDeaths(room, info.next);
}

function finishGame(room, winner, options = {}) {
  if (room.state !== 'playing') return false;
  const { awardScores = true, forced = false, jesterId = null } = options;
  clearTimers(room);
  room.state = 'finished';
  room.phase = 'finished';
  room.phaseOpen = false;
  room.trial = null;
  room.hunter = null;

  const rd = room.currentRoundData;
  if (rd && (rd.nightVictim || rd.dayVictim || rd.healed || rd.hunterShot || rd.left.length || Object.keys(rd.dayVotes).length)) {
    const last = room.roundsData[room.roundsData.length - 1];
    if (!last || last.round !== rd.round) room.roundsData.push({ ...rd });
  }

  const aliveVampires = aliveVampireIds(room).length;
  const gains = {};
  if (awardScores) {
    entries(room).forEach(([id, p]) => {
      let gain = 0;
      if (winner === 'villagers' && TOWN_ROLES.includes(p.role) && !p.left) gain = 1 + (p.isDead ? 0 : 1);
      if (winner === 'vampires' && p.role === 'vampire' && !p.left) gain = 2 + (!p.isDead && aliveVampires === 1 ? 1 : 0);
      if (winner === 'jester' && id === jesterId) gain = 3;
      if (gain) {
        room.scoreBook[p.userName] = scoreOf(room, p.userName) + gain;
        gains[id] = gain;
      }
    });
  }

  if (!forced) {
    entries(room).forEach(([id, p]) => {
      if (!isParticipantRole(p.role)) return;
      const before = room.statsBook[p.userName] || { games: 0, wins: 0, lastGain: 0 };
      const won = (winner === 'villagers' && TOWN_ROLES.includes(p.role))
        || (winner === 'vampires' && p.role === 'vampire')
        || (winner === 'jester' && id === jesterId);
      room.statsBook[p.userName] = {
        games: before.games + 1,
        wins: before.wins + (won && !p.left ? 1 : 0),
        lastGain: gains[id] || 0,
      };
    });
  }

  const rolesMap = {};
  entries(room).forEach(([id, p]) => {
    rolesMap[id] = { userName: p.userName, role: p.role, isDead: p.isDead, left: !!p.left, score: scoreOf(room, p.userName), gain: gains[id] || 0 };
  });

  room.gamesHistory.push({
    gameNumber: room.gameNumber,
    winner,
    forced,
    rounds: room.roundsData.map((r) => ({ ...r })),
    players: Object.values(rolesMap).filter((p) => isParticipantRole(p.role)).map((p) => ({ userName: p.userName, role: p.role, isDead: p.isDead, gain: p.gain })),
  });
  io.to(room.id).emit('games-history-updated', room.gamesHistory);
  console.log(`[Room ${room.id}] GAME OVER - Winner: ${winner}${forced ? ' (forced)' : ''}`);
  io.to(room.id).emit('game-over', { winner, playersDetails: rolesMap, forced, jesterId });
  emitRoomInfo(room);
  emitPrivateStates(room);
  emitChatAccess(room);
  return true;
}

// ---------------------------------------------------------------------------
// Rol dağıtımı
// ---------------------------------------------------------------------------
function enabledSpecials(room) {
  return SPECIAL_ROLES.filter(([, key]) => room.settings[key]).map(([role]) => role);
}

function allowedManualRoles(room) {
  return ['vampire', ...enabledSpecials(room)];
}

function validateStart(room) {
  const ids = lobbyParticipantIds(room);
  const offline = ids.filter((id) => !room.players[id].connected);
  if (offline.length) return { error: `${offline.map((id) => nameOf(room, id)).join(', ')} yeniden bağlanıyor. Birkaç saniye bekleyip tekrar başlat.` };
  if (room.moderator && !room.players[room.moderator]?.connected) return { error: 'Moderatör yeniden bağlanıyor. Birkaç saniye bekleyip tekrar başlat.' };
  const n = ids.length;
  if (n < MIN_PLAYERS) return { error: `Oyunu başlatmak için en az ${MIN_PLAYERS} oyuncu gerekli. Şu an ${n} oyuncu var; arkadaşlarına oda kodunu gönder.` };
  const vCount = Math.min(room.settings.vampireCount, maxVampires(n));
  const specials = enabledSpecials(room);
  if (vCount + specials.length > n) {
    return { error: `${vCount} vampir ve ${specials.length} özel rol için en az ${vCount + specials.length} oyuncu gerekli. Bazı özel rolleri kapat ya da oyuncu bekle.` };
  }
  if (room.moderator) {
    const counts = {};
    Object.entries(room.customRolesMap).forEach(([id, role]) => {
      if (ids.includes(id)) counts[role] = (counts[role] || 0) + 1;
    });
    if ((counts.vampire || 0) !== vCount) return { error: `Rolleri tamamla: ${vCount} vampir seçmelisin (şu an ${counts.vampire || 0}).` };
    const missing = specials.filter((role) => (counts[role] || 0) !== 1);
    if (missing.length) return { error: `Rolleri tamamla: açık olan her özel rol için 1 kişi seç. Eksik: ${missing.map(roleLabel).join(', ')}.` };
  }
  return { ids, vCount, specials };
}

function roleLabel(role) {
  return { vampire: 'Vampir', healer: 'Şifacı', seer: 'Kahin', hunter: 'Avcı', jester: 'Deli', elder: 'Yaşlı Köylü', villager: 'Köylü' }[role] || role;
}

function assignRoles(room, ids, vCount, specials) {
  if (room.moderator) {
    ids.forEach((id) => { room.players[id].role = room.customRolesMap[id] || 'villager'; });
    return;
  }
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const roles = [...Array(vCount).fill('vampire'), ...specials];
  shuffled.forEach((id, index) => { room.players[id].role = roles[index] || 'villager'; });
}

// ---------------------------------------------------------------------------
// Bağlantı yönetimi
// ---------------------------------------------------------------------------
function deleteRoom(room) {
  clearTimers(room);
  Object.values(room.players).forEach((p) => p.disconnectTimer && clearTimeout(p.disconnectTimer));
  delete rooms[room.id];
}

function transferControl(room) {
  const next = entries(room).find(([id, p]) => p.connected && !p.left && p.role !== 'spectator' && id !== room.moderator)
    || entries(room).find(([, p]) => p.connected && !p.left);
  room.admin = next ? next[0] : null;
  io.to(room.id).emit('admin-changed', room.admin, room.admin ? nameOf(room, room.admin) : null);
}

function renamePlayer(room, oldId, newId) {
  if (oldId === newId) return;
  const swap = (v) => (v === oldId ? newId : v);
  room.players[newId] = room.players[oldId];
  delete room.players[oldId];
  room.admin = swap(room.admin);
  room.moderator = swap(room.moderator);
  room.pendingKill = swap(room.pendingKill);
  room.pendingHunter = swap(room.pendingHunter);
  if (room.customRolesMap[oldId]) {
    room.customRolesMap[newId] = room.customRolesMap[oldId];
    delete room.customRolesMap[oldId];
  }
  const a = room.actions;
  const votes = {};
  Object.entries(a.votes).forEach(([voter, target]) => { votes[swap(voter)] = swap(target); });
  a.votes = votes;
  const verdict = {};
  Object.entries(a.verdict).forEach(([voter, value]) => { verdict[swap(voter)] = value; });
  a.verdict = verdict;
  a.seer = swap(a.seer);
  a.heal = swap(a.heal);
  a.hunterShot = swap(a.hunterShot);
  if (room.trial) {
    room.trial.accused = swap(room.trial.accused);
    room.trial.candidates = (room.trial.candidates || []).map(swap);
  }
  if (room.hunter) room.hunter.pid = swap(room.hunter.pid);
  Object.values(room.players).forEach((p) => {
    p.lastHealTarget = swap(p.lastHealTarget);
    if (p.seerResults) p.seerResults = p.seerResults.map((r) => ({ ...r, targetId: swap(r.targetId) }));
  });
  io.to(room.id).emit('player-renamed', oldId, newId);
}

function handleAbandon(roomId, pid) {
  const room = rooms[roomId];
  if (!room) return;
  const p = room.players[pid];
  if (!p || p.connected) return;
  p.disconnectTimer = null;

  if (room.state === 'playing') {
    p.left = true;
    if (pid === room.moderator) room.moderator = null;
    if (!p.isDead && p.role !== 'spectator' && p.role !== 'moderator') {
      delete room.actions.votes[pid];
      delete room.actions.verdict[pid];
      if (room.currentRoundData) room.currentRoundData.left.push(p.userName);
      killPlayer(room, pid, 'left', 'Oyunu terk etti');
      if (room.hunter && room.hunter.pid === pid && !room.paused) shortenTimer(room, 1);
      const winner = checkWinner(room);
      if (winner) finishGame(room, winner);
    }
  } else {
    delete room.players[pid];
    delete room.customRolesMap[pid];
    if (pid === room.moderator) {
      room.moderator = null;
      room.settings.modEnabled = false;
      room.customRolesMap = {};
    }
  }

  if (room.admin === pid || !room.players[room.admin] || !room.players[room.admin]?.connected) transferControl(room);
  if (!Object.values(room.players).some((q) => q.connected)) return deleteRoom(room);
  emitRoomInfo(room);
  return undefined;
}

function joinAsPlayer(socket, room, pid, player) {
  socket.join(room.id);
  socket.data.roomId = room.id;
  socket.data.pid = pid;
  room.players[pid] = player;
  socket.emit('join-accepted', { playerId: pid, token: player.token, roomId: room.id, userName: player.userName });
}

function sendFullState(socket, room, pid) {
  socket.emit('room-info', buildRoomInfo(room, pid));
  if (room.state === 'playing') {
    socket.emit('game-started', { phase: room.phase, resume: true });
    socket.emit('phase-changed', room.phase, { timeLeft: room.timeLeft, trial: publicTrial(room), hunter: room.hunter ? room.hunter.pid : null, round: room.round, resume: true });
  }
  if (room.state === 'finished') {
    const last = room.gamesHistory[room.gamesHistory.length - 1];
    const rolesMap = {};
    entries(room).forEach(([id, p]) => {
      rolesMap[id] = { userName: p.userName, role: p.role, isDead: p.isDead, left: !!p.left, score: scoreOf(room, p.userName) };
    });
    socket.emit('game-over', { winner: last?.winner, playersDetails: rolesMap, forced: false, resume: true });
  }
  emitPrivateState(room, pid);
  sendChatHistory(room, pid);
  if (pid === room.moderator) socket.emit('custom-roles-updated', room.customRolesMap);
  if (canControl(room, pid)) {
    Object.entries(room.pending).forEach(([socketId, req]) => socket.emit('spectator-request', { socketId, userName: req.userName }));
  }
}

// ---------------------------------------------------------------------------
// Eylemler
// ---------------------------------------------------------------------------
function handleVote(room, pid, me, targetId) {
  if (!room.phaseOpen) return 'Bu aşamanın süresi doldu; sıradaki aşama birazdan başlıyor.';
  const phase = room.phase;
  const target = targetId ? room.players[targetId] : null;
  if (targetId && !target) return 'Bu oyuncu artık odada değil.';

  if (phase === 'day' || phase === 'revote') {
    if (!isAlive(me)) return 'Öldüğün için artık oy veremezsin.';
    if (targetId) {
      if (!isAlive(target)) return 'Sadece hayattaki oyunculara oy verebilirsin.';
      if (targetId === pid) return 'Kendine oy veremezsin.';
      if (phase === 'revote' && !room.trial?.candidates?.includes(targetId)) return 'Yeniden oylamada sadece berabere kalan adaylara oy verebilirsin.';
      room.actions.votes[pid] = targetId;
    } else {
      delete room.actions.votes[pid];
    }
    broadcastVotes(room);
    return null;
  }

  if (phase === 'night') {
    if (!isAlive(me)) return 'Öldüğün için gece eylemi yapamazsın.';
    if (me.role === 'vampire') {
      if (isPeacefulNight(room)) return 'İlk gece barışı: bu gece kimse öldürülemez. Takımını tanı, yarın gece avlanırsın.';
      if (!isAlive(target)) return 'Bu oyuncu zaten ölü.';
      if (target.role === 'vampire') return 'O da bir vampir; takım arkadaşına saldıramazsın.';
      room.actions.votes[pid] = targetId;
      broadcastVotes(room);
    } else if (me.role === 'seer') {
      if (targetId === pid) return 'Kendini sorgulayamazsın; rolünü zaten biliyorsun.';
      if (!isAlive(target)) return 'Sadece hayattaki birini sorgulayabilirsin.';
      room.actions.seer = targetId;
    } else {
      return 'Gece senin rolünün bir eylemi yok; sabahı bekle.';
    }
    if (readyToAdvance(room)) autoAdvance(room);
    return null;
  }

  if (phase === 'dawn') {
    if (me.role !== 'healer' || !isAlive(me)) return 'Şafakta sadece Şifacı birini koruyabilir.';
    if (!isAlive(target)) return 'Sadece hayattaki birini koruyabilirsin.';
    if (targetId === me.lastHealTarget) return 'Bu kişiyi dün gece korudun; aynı kişiyi üst üste iki gece koruyamazsın.';
    if (targetId === pid && me.selfHealUsed) return 'Kendini koruma hakkını kullandın; bu oyunda bir kez korunabiliyordun.';
    room.actions.heal = targetId;
    broadcastVotes(room);
    autoAdvance(room);
    return null;
  }

  if (phase === 'hunter') {
    if (!room.hunter || room.hunter.pid !== pid) return 'Şu an sadece Avcı ateş edebilir.';
    if (!isAlive(target) || targetId === pid) return 'Sadece hayattaki başka bir oyuncuyu vurabilirsin.';
    room.actions.hunterShot = targetId;
    autoAdvance(room);
    return null;
  }

  return phase === 'defense' ? 'Savunma sürerken oy verilmez; birazdan son karar oylaması başlayacak.' : 'Bu aşamada oy verilmiyor.';
}

// ---------------------------------------------------------------------------
// Soket olayları
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms[socket.data.roomId];
    if (!room) return null;
    const pid = socket.data.pid;
    const me = room.players[pid];
    if (!me || me.socketId !== socket.id) return null;
    return { room, pid, me };
  };
  const reject = (msg) => socket.emit('join-rejected', msg);

  socket.on('join-room', (rawRoomId, rawPeerId, rawName, _ignoredScore, rawToken, rawAvatar) => {
    const avatar = clampInt(rawAvatar, 1, AVATAR_COUNT, 1 + Math.floor(Math.random() * AVATAR_COUNT));
    if (socket.data.roomId || socket.data.pendingRoom) return;
    const roomId = cleanText(rawRoomId, ROOM_MAX_LEN).toLocaleLowerCase('tr');
    const peerId = typeof rawPeerId === 'string' ? rawPeerId.slice(0, 64) : '';
    const userName = cleanText(rawName, NAME_MAX_LEN);
    const token = typeof rawToken === 'string' ? rawToken.slice(0, 64) : '';
    if (!roomId || !peerId || !userName) return reject('Oyuncu adı ve oda kodu boş olamaz.');

    let room = rooms[roomId];

    // 1) Oturum anahtarıyla geri dönüş (sayfa yenileme, bağlantı kopması)
    if (room && token) {
      const found = entries(room).find(([, p]) => p.token === token);
      if (found) {
        let [pid, p] = found;
        if (peerId !== pid) {
          if (room.players[peerId]) return reject('Bağlantı kurulurken bir çakışma oldu. Sayfayı yenileyip tekrar dene.');
          renamePlayer(room, pid, peerId);
          pid = peerId;
          p = room.players[pid];
        }
        if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
        p.disconnectTimer = null;
        const oldSocket = p.socketId && io.sockets.sockets.get(p.socketId);
        if (oldSocket && oldSocket.id !== socket.id) {
          oldSocket.data.roomId = null;
          oldSocket.disconnect(true);
        }
        p.socketId = socket.id;
        p.connected = true;
        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.data.pid = pid;
        socket.emit('join-accepted', { playerId: pid, token: p.token, roomId: room.id, userName: p.userName, resumed: true });
        if (!room.admin || !room.players[room.admin]?.connected) transferControl(room);
        socket.to(room.id).emit('user-connected', pid, p.userName, null, 0);
        sendFullState(socket, room, pid);
        emitRoomInfo(room);
        return undefined;
      }
    }

    // 2) Yeni giriş
    if (room) {
      if (room.players[peerId]) return reject('Bağlantı kurulurken bir çakışma oldu. Sayfayı yenileyip tekrar dene.');
      const sameNamed = Object.values(room.players).find((p) => sameName(p.userName, userName));
      if (sameNamed && !sameNamed.connected && !sameNamed.left) {
        return reject(`"${userName}" adıyla oynayan oyuncunun bağlantısı kopmuş ve yeri ona ayrılmış durumda. O oyuncu sensen, oyuna ilk girdiğin telefon/tarayıcıdan aynı oda kodu ve isimle tekrar gir; kaldığın yerden devam edersin.`);
      }
      const nameTaken = !!sameNamed || Object.values(room.pending).some((p) => sameName(p.userName, userName));
      if (nameTaken) return reject(`"${userName}" adı bu odada zaten kullanılıyor. Başka bir isim seç.`);

      if (room.state === 'playing') {
        const controller = controllerId(room);
        if (!controller || !room.players[controller]?.connected) return reject('Bu odada oyun sürüyor ve oda yöneticisi şu an bağlı değil, bu yüzden giriş onaylanamıyor. Oyun bitince tekrar dene.');
        room.pending[socket.id] = { peerId, userName, avatar };
        socket.data.pendingRoom = room.id;
        emitTo(room, controller, 'spectator-request', { socketId: socket.id, userName });
        socket.emit('spectator-pending', 'Bu odada şu an oyun sürüyor. Oda yöneticisi onaylarsa bu oyunu izleyici olarak takip edecek, sonraki oyunda oynayacaksın.');
        return undefined;
      }
    } else {
      room = createRoom(roomId, peerId);
      rooms[roomId] = room;
    }

    const player = {
      userName,
      role: null,
      socketId: socket.id,
      isDead: false,
      connected: true,
      left: false,
      token: crypto.randomUUID(),
      will: '',
      avatar,
      camOn: false,
      micOn: false,
      disconnectTimer: null,
      chatTimes: [],
    };
    joinAsPlayer(socket, room, peerId, player);
    socket.to(room.id).emit('user-connected', peerId, userName, null, 0);
    sendFullState(socket, room, peerId);
    emitRoomInfo(room);
    return undefined;
  });

  socket.on('approve-spectator', (requestSocketId, isApproved) => {
    const c = ctx();
    if (!c || !canControl(c.room, c.pid)) return;
    const { room } = c;
    const socketId = typeof requestSocketId === 'object' && requestSocketId ? requestSocketId.socketId : requestSocketId;
    const req = room.pending[socketId];
    if (!req) return;
    delete room.pending[socketId];
    const target = io.sockets.sockets.get(socketId);
    if (!target) return;
    target.data.pendingRoom = null;
    if (!isApproved) {
      target.emit('join-rejected', 'Oda yöneticisi giriş isteğini reddetti.');
      return;
    }
    if (room.players[req.peerId]) {
      target.emit('join-rejected', 'Bağlantı kurulurken bir çakışma oldu. Sayfayı yenileyip tekrar dene.');
      return;
    }
    const isPlaying = room.state === 'playing';
    joinAsPlayer(target, room, req.peerId, {
      userName: req.userName,
      role: isPlaying ? 'spectator' : null,
      socketId,
      isDead: isPlaying,
      connected: true,
      left: false,
      token: crypto.randomUUID(),
      will: '',
      avatar: req.avatar || 1,
      camOn: false,
      micOn: false,
      disconnectTimer: null,
      chatTimes: [],
    });
    target.to(room.id).emit('user-connected', req.peerId, req.userName, isPlaying ? 'spectator' : null, 0);
    sendFullState(target, room, req.peerId);
    if (isPlaying) target.emit('role-assigned', 'spectator');
    emitRoomInfo(room);
  });

  socket.on('update-settings', (newSettings) => {
    const c = ctx();
    if (!c || !canControl(c.room, c.pid) || c.room.state !== 'lobby') return;
    const { room } = c;
    room.settings = sanitizeSettings(room.settings, newSettings);
    const allowed = allowedManualRoles(room);
    Object.entries(room.customRolesMap).forEach(([id, role]) => {
      if (!allowed.includes(role)) delete room.customRolesMap[id];
    });
    if (room.moderator) emitTo(room, room.moderator, 'custom-roles-updated', room.customRolesMap);
    io.to(room.id).emit('settings-updated', room.settings);
    emitRoomInfo(room);
  });

  socket.on('assign-moderator', (targetId) => {
    const c = ctx();
    if (!c || !canControl(c.room, c.pid) || c.room.state !== 'lobby') return;
    const { room } = c;
    const target = targetId ? room.players[targetId] : null;
    if (targetId && (!target || !target.connected || target.role === 'spectator')) return;
    room.moderator = target ? targetId : null;
    room.settings.modEnabled = !!target;
    room.customRolesMap = {};
    if (target) {
      room.admin = targetId;
      io.to(room.id).emit('admin-changed', targetId, target.userName);
      emitTo(room, targetId, 'custom-roles-updated', {});
    }
    io.to(room.id).emit('moderator-assigned', room.moderator);
    io.to(room.id).emit('settings-updated', room.settings);
    emitRoomInfo(room);
  });

  socket.on('update-custom-roles', (roleData) => {
    const c = ctx();
    if (!c || c.room.state !== 'lobby' || c.room.moderator !== c.pid) return;
    const { room } = c;
    const targetId = roleData?.targetId;
    const role = roleData?.role || '';
    const target = room.players[targetId];
    if (!target || targetId === room.moderator || target.role === 'spectator') return;
    if (role === '' || role === 'villager') {
      delete room.customRolesMap[targetId];
    } else {
      if (!allowedManualRoles(room).includes(role)) return;
      const n = lobbyParticipantIds(room).length;
      const limit = role === 'vampire' ? Math.min(room.settings.vampireCount, maxVampires(n)) : 1;
      const others = Object.entries(room.customRolesMap).filter(([id, r]) => id !== targetId && r === role).length;
      if (others >= limit) {
        socket.emit('role-selection-error', role === 'vampire' ? `En fazla ${limit} vampir seçilebilir.` : `En fazla 1 ${roleLabel(role)} seçilebilir.`);
        return;
      }
      room.customRolesMap[targetId] = role;
    }
    socket.emit('custom-roles-updated', room.customRolesMap);
  });

  socket.on('start-game', () => {
    const c = ctx();
    if (!c || !canControl(c.room, c.pid) || c.room.state !== 'lobby') return;
    const { room } = c;
    const check = validateStart(room);
    if (check.error) {
      socket.emit('start-game-rejected', check.error);
      return;
    }
    clearTimers(room);
    room.state = 'playing';
    room.phase = 'night';
    room.phaseOpen = false;
    room.fastNext = false;
    room.round = 1;
    room.history = [];
    room.roundsData = [];
    room.currentRoundData = freshRound(1);
    room.actions = freshActions();
    room.pendingKill = null;
    room.pendingHunter = null;
    room.nightFlavor = null;
    room.trial = null;
    room.hunter = null;
    room.chat.vampire = [];
    room.chat.dead = [];

    entries(room).forEach(([id, p]) => {
      p.isDead = false;
      p.left = false;
      p.will = '';
      p.seerResults = [];
      p.lastHealTarget = null;
      p.selfHealUsed = false;
      p.deathCause = null;
      p.deathRound = null;
      p.killedBy = null;
      p.elderShieldUsed = false;
      if (id === room.moderator) p.role = 'moderator';
      else if (p.role === 'spectator') p.role = null;
    });
    assignRoles(room, check.ids, check.vCount, check.specials);

    entries(room).forEach(([id, p]) => emitTo(room, id, 'role-assigned', p.role));
    io.to(room.id).emit('game-started', { phase: 'night' });
    emitRoomInfo(room);
    emitPrivateStates(room);
    emitChatAccess(room);
    const vampires = vampireIds(room);
    if (vampires.length > 1) systemChat(room, 'vampire', `Vampir takımı: ${vampires.map((id) => nameOf(room, id)).join(', ')}. Gece hedefte anlaşın.`);
    room.gapTimer = setTimeout(() => startPhase(room, 'night'), GAME_START_DELAY_MS);
  });

  socket.on('set-avatar', (value) => {
    const c = ctx();
    if (!c) return;
    c.me.avatar = clampInt(value, 1, AVATAR_COUNT, c.me.avatar || 1);
    emitRoomInfo(c.room);
  });

  socket.on('media-state', (state) => {
    const c = ctx();
    if (!c || !state || typeof state !== 'object') return;
    const camOn = !!state.video;
    const micOn = !!state.audio;
    if (c.me.camOn === camOn && c.me.micOn === micOn) return;
    c.me.camOn = camOn;
    c.me.micOn = micOn;
    emitRoomInfo(c.room);
  });

  socket.on('toggle-pause', () => {
    const c = ctx();
    if (!c || c.room.state !== 'playing' || !canControl(c.room, c.pid)) return;
    setPaused(c.room, !c.room.paused);
  });

  socket.on('end-phase-early', () => {
    const c = ctx();
    if (!c || c.room.state !== 'playing' || !canControl(c.room, c.pid)) return;
    const { room } = c;
    // Oyuncu olan yönetici gece eylemlerini erken bitiremez (bilgi sızmasın diye)
    if (!room.moderator && ['night', 'dawn', 'hunter'].includes(room.phase)) {
      socket.emit('action-error', 'Sen de oyuncu olduğun için gece aşamalarını erken bitiremezsin. Herkes eylemini yapınca gece zaten kendiliğinden biter.');
      return;
    }
    if (room.paused) setPaused(room, false);
    shortenTimer(room, 1);
  });

  socket.on('force-end-game', () => {
    const c = ctx();
    if (!c || c.room.state !== 'playing' || !canControl(c.room, c.pid)) return;
    const winner = checkWinner(c.room) || 'villagers';
    finishGame(c.room, winner, { awardScores: false, forced: true });
  });

  socket.on('kill-flavor-text', (text) => {
    const c = ctx();
    if (!c || c.room.phase !== 'night' || c.me.role !== 'vampire' || c.me.isDead) return;
    c.room.nightFlavor = cleanText(text, 120);
  });

  socket.on('submit-vote', (targetId) => {
    const c = ctx();
    if (!c || c.room.state !== 'playing') return;
    const error = handleVote(c.room, c.pid, c.me, typeof targetId === 'string' ? targetId : null);
    if (error) socket.emit('action-error', error);
    else socket.emit('vote-acked', typeof targetId === 'string' ? targetId : null);
  });

  socket.on('submit-verdict', (guilty) => {
    const c = ctx();
    if (!c || c.room.state !== 'playing' || c.room.phase !== 'verdict') return;
    const { room, pid, me } = c;
    if (!room.phaseOpen) {
      socket.emit('action-error', 'Karar oylaması sona erdi.');
      return;
    }
    if (!isAlive(me) || pid === room.trial?.accused) {
      socket.emit('action-error', pid === room.trial?.accused ? 'Hakkında karar verilirken oy kullanamazsın.' : 'Öldüğün için bu oylamaya katılamazsın.');
      return;
    }
    room.actions.verdict[pid] = !!guilty;
    socket.emit('verdict-acked', !!guilty);
    broadcastVerdict(room);
    if (readyToAdvance(room)) autoAdvance(room);
  });

  socket.on('set-will', (text) => {
    const c = ctx();
    if (!c || c.room.state !== 'playing' || !isAlive(c.me)) return;
    c.me.will = cleanText(text, WILL_MAX_LEN);
    socket.emit('will-saved', c.me.will);
  });

  socket.on('chat-send', (payload) => {
    const c = ctx();
    if (!c) return;
    const { room, pid, me } = c;
    const channel = payload?.channel;
    const text = cleanText(payload?.text, CHAT_MAX_LEN);
    if (!text || !['all', 'vampire', 'dead'].includes(channel)) return;
    if (!chatAccess(room, pid).write.includes(channel)) {
      socket.emit('action-error', chatDeniedReason(room, pid, channel));
      return;
    }
    const now = Date.now();
    me.chatTimes = (me.chatTimes || []).filter((t) => now - t < 5000);
    if (me.chatTimes.length >= 5) {
      socket.emit('action-error', 'Çok hızlı yazıyorsun; birkaç saniye bekle.');
      return;
    }
    me.chatTimes.push(now);
    pushChat(room, channel, { id: crypto.randomUUID(), channel, from: pid, fromName: me.userName, text, ts: now });
  });

  socket.on('return-to-lobby', () => {
    const c = ctx();
    if (!c || !canControl(c.room, c.pid) || c.room.state !== 'finished') return;
    const { room } = c;
    clearTimers(room);
    entries(room).forEach(([id, p]) => {
      if (p.left || !p.connected) {
        if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
        delete room.players[id];
      }
    });
    room.state = 'lobby';
    room.phase = 'lobby';
    room.actions = freshActions();
    room.gameNumber += 1;
    room.customRolesMap = {};
    room.trial = null;
    room.hunter = null;
    room.currentRoundData = null;
    room.roundsData = [];
    room.history = [];
    room.chat.vampire = [];
    room.chat.dead = [];
    if (room.moderator && !room.players[room.moderator]) {
      room.moderator = null;
      room.settings.modEnabled = false;
    }
    Object.values(room.players).forEach((p) => {
      p.role = null;
      p.isDead = false;
      p.left = false;
      p.will = '';
      p.seerResults = [];
      p.lastHealTarget = null;
      p.selfHealUsed = false;
      p.deathCause = null;
      p.deathRound = null;
      p.killedBy = null;
    });
    if (!room.players[room.admin]) transferControl(room);
    io.to(room.id).emit('returned-to-lobby');
    if (room.moderator) emitTo(room, room.moderator, 'custom-roles-updated', {});
    emitRoomInfo(room);
    emitPrivateStates(room);
    emitChatAccess(room);
  });

  // Oyuncu "Çık" butonuna bastı: bekleme süresi olmadan koltuğu bırakır
  socket.on('leave-room', () => {
    const c = ctx();
    if (!c) return;
    const { room, pid, me } = c;
    if (me.disconnectTimer) clearTimeout(me.disconnectTimer);
    me.connected = false;
    me.socketId = null;
    socket.data.roomId = null;
    socket.leave(room.id);
    handleAbandon(room.id, pid);
  });

  socket.on('disconnect', () => {
    if (socket.data.pendingRoom) {
      const room = rooms[socket.data.pendingRoom];
      if (room && room.pending[socket.id]) {
        delete room.pending[socket.id];
        const controller = controllerId(room);
        if (controller) emitTo(room, controller, 'spectator-request-cancelled', socket.id);
      }
      return;
    }
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const pid = socket.data.pid;
    const p = room.players[pid];
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    const grace = room.state === 'playing' ? GAME_GRACE_MS : LOBBY_GRACE_MS;
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
    p.disconnectTimer = setTimeout(() => handleAbandon(room.id, pid), grace);
    io.to(room.id).emit('player-connection', pid, false);
    emitRoomInfo(room);
  });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    console.log(`Signaling server listening on port ${PORT}`);
  });
}

module.exports = { server, io, rooms, sanitizeSettings, maxVampires, recommendedVampires };
