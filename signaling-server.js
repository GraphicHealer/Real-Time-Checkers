// signaling-server.js
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const http = require('http');

// ==================== STATE ====================
const state = {
  rooms: new Map(), // roomId -> { players: [ws1, ws2], metadata }
  waitingPlayers: [], // Queue for public matchmaking
  totalGamesPlayed: 0,
  totalPlayersJoined: 0,
  cleanupInterval: null
};

// Create an HTTP server
const server = http.createServer((req, res) => {
  // Redirect to HTTPS if not already
  if (req.headers['x-forwarded-proto'] !== 'https') {
    const host = req.headers.host;
    res.writeHead(301, { Location: `https://${host}${req.url}` });
    res.end();
    return; // Stop processing the request
  }
  
  if (req.url === '/' || req.url === '/stats') {
    // Serve a simple stats page
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <head>
          <title>Game Stats</title>
        </head>
        <body>
          <h1>Game Statistics</h1>
          <ul>
            <li>Active rooms: <span id="activeRooms">${state.rooms.size}</span></li>
            <li>Waiting players: <span id="waitingPlayers">${state.waitingPlayers.length}</span></li>
            <li>Total games played: <span id="totalGames">${state.totalGamesPlayed}</span></li>
            <li>Total players joined: <span id="totalPlayers">${state.totalPlayersJoined}</span></li>
          </ul>
          <script>
            async function updateStats() {
              const res = await fetch('/stats.json');
              const data = await res.json();
              document.getElementById('activeRooms').textContent = data.activeRooms;
              document.getElementById('waitingPlayers').textContent = data.waitingPlayers;
              document.getElementById('totalGames').textContent = data.totalGamesPlayed;
              document.getElementById('totalPlayers').textContent = data.totalPlayersJoined;
            }
            setInterval(updateStats, 5000);
          </script>
        </body>
      </html>
    `);
  } else if (req.url === '/stats.json') {
    // JSON endpoint for stats
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      activeRooms: state.rooms.size,
      waitingPlayers: state.waitingPlayers.length,
      totalGamesPlayed: state.totalGamesPlayed,
      totalPlayersJoined: state.totalPlayersJoined
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Pass the HTTP server to WebSocketServer
const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

// ==================== UTILITIES ====================
const utils = {
  /**
   * Safely send JSON data to a WebSocket client
   */
  send(ws, data) {
    if (ws && ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(data));
      } catch (err) {
        console.error('Error sending message:', err);
      }
    }
  },

  /**
   * Generate a random room ID
   */
  generateRoomId() {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
  },

  /**
   * Validate room ID format
   */
  isValidRoomId(roomId) {
    return typeof roomId === 'string' && roomId.length >= 4 && roomId.length <= 12;
  },

  /**
   * Get the opponent in a room
   */
  getOpponent(ws, roomId) {
    const room = state.rooms.get(roomId);
    if (!room) return null;
    return room.players.find(player => player !== ws);
  },

  /**
   * Broadcast to all players in a room
   */
  broadcastToRoom(roomId, data, excludeWs = null) {
    const room = state.rooms.get(roomId);
    if (!room) return;
    
    room.players.forEach(player => {
      if (player !== excludeWs) {
        this.send(player, data);
      }
    });
  }
};

// ==================== ROOM MANAGEMENT ====================
const rooms = {
  /**
   * Create a new room
   */
  create(roomId, firstPlayer, isPrivate = false) {
    state.rooms.set(roomId, {
      players: [firstPlayer],
      isPrivate,
      createdAt: Date.now(),
      ready: { p1: false, p2: false }
    });
    firstPlayer.roomId = roomId;
    console.log(`${isPrivate ? '🔒' : '🎮'} Room created: ${roomId}`);
  },

  /**
   * Add a player to an existing room
   */
  join(roomId, player) {
    const room = state.rooms.get(roomId);
    if (!room) return false;
    
    if (room.players.length >= 2) {
      utils.send(player, { type: 'error', message: 'Room is full' });
      return false;
    }
    
    room.players.push(player);
    player.roomId = roomId;
    console.log(`🔑 Player joined room: ${roomId}`);
    
    console.log(`👥 ${room.players.map(p => p.displayName).join(' vs ')} in ${roomId}`);
    
    // Start the game for both players
    room.players.forEach((player, index) => {
      const opponent = room.players.find(p => p !== player);
      utils.send(player, {
        type: 'matchFound',
        roomId: roomId,
        isCaller: index === 0,
        opponentName: opponent?.displayName || "Opponent"
      });
    });

    return true;
  },

  /**
   * Remove a room
   */
  remove(roomId) {
    const room = state.rooms.get(roomId);
    if (room) {
      state.rooms.delete(roomId);
      console.log(`🧹 Room removed: ${roomId}`);
    }
  },

  /**
   * Handle player disconnect from room
   */
  handleDisconnect(ws) {
    if (!ws.roomId) return;
    
    const room = state.rooms.get(ws.roomId);
    if (!room) return;
    
    // Notify opponent
    const opponent = room.players.find(p => p !== ws);
    if (opponent && opponent.readyState === opponent.OPEN) {
      utils.send(opponent, { type: 'opponentDisconnected' });
    }
    
    // Clean up room
    this.remove(ws.roomId);
  }
};

// ==================== MATCHMAKING ====================
const matchmaking = {
  /**
   * Add player to public matchmaking queue
   */
  joinPublicQueue(ws) {
    // Remove any stale connections from queue
    state.waitingPlayers = state.waitingPlayers.filter(
      p => p.readyState === p.OPEN
    );
    
    // Try to match with waiting player
    if (state.waitingPlayers.length > 0) {
      const opponent = state.waitingPlayers.shift();
      const roomId = utils.generateRoomId();
      
      // Create the room
      rooms.create(roomId, opponent, false);

      // Tag names if not already set
      opponent.displayName = opponent.displayName || "Player";
      ws.displayName = ws.displayName || "Player";

      // Join the room
      rooms.join(roomId, ws);

      // Send names manually (since rooms.join() sends matchFound, we’ll update them below)
      const room = state.rooms.get(roomId);
      if (room && room.players.length === 2) {
        room.players.forEach((player, index) => {
          const other = room.players.find(p => p !== player);
          utils.send(player, {
            type: 'matchFound',
            roomId,
            isCaller: index === 0,
            opponentName: other?.displayName || "Opponent"
          });
        });
      }

      console.log(`✅ Public match created: ${roomId}`);
    } else {
      // Add to queue
      state.waitingPlayers.push(ws);
      utils.send(ws, { type: 'waiting' });
      console.log('⏳ Player added to matchmaking queue');
    }
  },

  /**
   * Remove player from queue
   */
  removeFromQueue(ws) {
    const index = state.waitingPlayers.indexOf(ws);
    if (index > -1) {
      state.waitingPlayers.splice(index, 1);
      console.log('🚫 Player removed from matchmaking queue');
    }
  }
};

// ==================== GAME ACTIONS ====================
const gameActions = {
  /**
   * Handle new game request
   */
  handleNewGameRequest(ws, data) {
    const { roomId, reqId } = data;
    const room = state.rooms.get(roomId);
    
    if (!room || room.players.length !== 2) return;
    
    const playerIndex = room.players.indexOf(ws);
    if (playerIndex === -1) return;
    
    const requestId = reqId || utils.generateRoomId();
    const playerKey = playerIndex === 0 ? 'p1' : 'p2';
    
    // Mark this player as ready
    room.ready[playerKey] = true;
    ws.lastNewGameReqId = requestId;
    
    const opponent = utils.getOpponent(ws, roomId);
    
    // Check if both players are ready
    if (room.ready.p1 && room.ready.p2) {
      console.log(`♻️ Both players ready for new game in room ${roomId}`);
      
      // Reset ready flags
      room.ready.p1 = false;
      room.ready.p2 = false;
      
      state.totalGamesPlayed++;
      
      // Notify both players to start new game
      utils.broadcastToRoom(roomId, { type: 'startNewGame', reqId: requestId });
      
      // Clear request IDs
      room.players.forEach(p => {
        p.lastNewGameReqId = null;
      });
    } else {
      // Notify opponent that this player wants a new game
      if (opponent && opponent.readyState === opponent.OPEN) {
        utils.send(opponent, { 
          type: 'opponentRequestedNewGame', 
          reqId: requestId 
        });
        console.log(`🟡 New game request sent in room ${roomId}`);
      }
    }
  },

  /**
   * Relay WebRTC signaling data
   */
  relaySignal(ws, data) {
    const { roomId, type } = data;
    const opponent = utils.getOpponent(ws, roomId);
    
    if (opponent && opponent.readyState === opponent.OPEN) {
      utils.send(opponent, data);
    }
  }
};

// ==================== MESSAGE HANDLERS ====================
const handlers = {
  joinPublic(ws, data) {
    ws.displayName = data.displayName || "Player";
    matchmaking.joinPublicQueue(ws);
  },

  createPrivate(ws, data) {
    ws.displayName = data.displayName || "Player";
    const { roomId } = data;
    
    if (!utils.isValidRoomId(roomId)) {
      utils.send(ws, { type: 'error', message: 'Invalid room ID format' });
      return;
    }
    
    if (state.rooms.has(roomId)) {
      utils.send(ws, { type: 'error', message: 'Room ID already exists' });
      return;
    }
    
    rooms.create(roomId, ws, true);
    utils.send(ws, { type: 'waiting' });
  },

  joinPrivate(ws, data) {
    ws.displayName = data.displayName || "Player";
    const { roomId } = data;
    
    if (!utils.isValidRoomId(roomId)) {
      utils.send(ws, { type: 'error', message: 'Invalid room ID format' });
      return;
    }
    
    const room = state.rooms.get(roomId);
    
    if (!room) {
      utils.send(ws, { type: 'roomInvalid', roomId });
      return;
    }
    
    if (room.players.length >= 2) {
      utils.send(ws, { type: 'roomFull', roomId });
      return;
    }
    
    rooms.join(roomId, ws);
  },

  offer(ws, data) {
    gameActions.relaySignal(ws, data);
  },

  answer(ws, data) {
    gameActions.relaySignal(ws, data);
  },

  ice(ws, data) {
    gameActions.relaySignal(ws, data);
  },

  readyForNewGame(ws, data) {
    gameActions.handleNewGameRequest(ws, data);
  }
};

// ==================== CONNECTION HANDLING ====================
wss.on('connection', (ws) => {
  console.log('🔌 New client connected');
  state.totalPlayersJoined++;
  
  ws.on('message', (msg) => {
    let data;
    
    try {
      data = JSON.parse(msg);
    } catch (err) {
      console.error('❌ Invalid JSON received:', msg.toString());
      return;
    }
    
    const { type } = data;
    
    // Route message to appropriate handler
    if (handlers[type]) {
      try {
        handlers[type](ws, data);
      } catch (err) {
        console.error(`❌ Error handling ${type}:`, err);
        utils.send(ws, { type: 'error', message: 'Server error occurred' });
      }
    } else {
      console.warn(`⚠️ Unknown message type: ${type}`);
    }
  });
  
  ws.on('close', () => {
    console.log('🔌 Client disconnected');
    matchmaking.removeFromQueue(ws);
    rooms.handleDisconnect(ws);
  });
  
  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
  });
});

// ==================== CLEANUP ====================
// Periodically clean up stale rooms
state.cleanupInterval = setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const [roomId, room] of state.rooms.entries()) {
    // Remove rooms older than 24 hours with no active connections
    const hasActivePlayer = room.players.some(p => p.readyState === p.OPEN);
    
    if (!hasActivePlayer || (now - room.createdAt > maxAge)) {
      console.log(`🧹 Cleaning up stale room: ${roomId}`);
      state.rooms.delete(roomId);
    }
  }
}, 60000); // Run every minute

// ==================== GRACEFUL SHUTDOWN ====================
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  clearInterval(state.cleanupInterval);
  
  // Notify all connected clients
  wss.clients.forEach(ws => {
    utils.send(ws, { type: 'serverShutdown' });
    ws.close();
  });
  
  wss.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  clearInterval(state.cleanupInterval);
  
  wss.clients.forEach(ws => {
    utils.send(ws, { type: 'serverShutdown' });
    ws.close();
  });
  
  wss.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// ==================== STATS (Optional) ====================
setInterval(() => {
  console.log(`📊 Stats: ${state.rooms.size} active rooms, ${state.waitingPlayers.length} waiting players`);
}, 300000); // Every 5 minutes
