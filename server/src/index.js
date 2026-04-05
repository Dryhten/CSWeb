const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const authRoutes = require('./routes/auth');
const playerRoutes = require('./routes/player');
const lobbyRoutes = require('./routes/lobby');
const configRoutes = require('./routes/config');
const { setupSocket } = require('./socket');
const roomBots = require('./services/roomBots');

const app = express();
const server = http.createServer(app);

const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');

/**
 * 静态资源缓存：地图/模型/音频等大文件允许长期缓存，减少重复下载；HTML 不缓存以便发版即时生效。
 * 带内容哈希的 JS/CSS 使用 immutable。
 */
function staticSetHeaders(res, resourcePath) {
  const normalized = resourcePath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(normalized);
  if (base.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
    return;
  }
  const hashedBundled = /\/assets\/[^/]+-[a-f0-9]{8,}\.(js|mjs|css)$/i.test(normalized);
  if (hashedBundled) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  const heavyStatic =
    /\.(glb|gltf|bin|ktx2|mp3|ogg|wav|opus|webp|png|jpe?g|gif|svg|ico|woff2?)$/i.test(base) ||
    normalized.includes('/assets/models/') ||
    normalized.includes('/assets/sounds/');
  if (heavyStatic) {
    res.setHeader('Cache-Control', 'public, max-age=31536000');
  }
}

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files - serve React build（大资源长期 HTTP 缓存，由浏览器磁盘缓存）
app.use(express.static(CLIENT_DIST, { setHeaders: staticSetHeaders }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/player', playerRoutes);
app.use('/api/lobby', lobbyRoutes);
app.use('/api/config', configRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Socket.io setup
setupSocket(io);
roomBots.setIo(io);

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});

// Database connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fire-assault';

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('✓ MongoDB 连接成功');
    
    // 初始化默认配置
    require('./services/configService').initDefaultConfig();
  })
  .catch(err => {
    console.error('✗ MongoDB 连接失败:', err.message);
  });

// Start server：PORT 必须在项目根目录 .env 中配置；HOST 默认 0.0.0.0 可公网/局域网访问
const PORT = parseInt(process.env.PORT, 10);
if (!Number.isFinite(PORT) || PORT < 1 || PORT > 65535) {
  console.error('✗ 请在项目根目录 .env 中设置 PORT 为 1–65535 的整数（可参考 .env.example）');
  process.exit(1);
}
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`========================================`);
  console.log(`  烈火突击服务器 - 监听 ${HOST}:${PORT}（公网请放行该端口）`);
  console.log(`  API: http://localhost:${PORT}/api`);
  console.log(`  Socket.io: ws://localhost:${PORT}`);
  console.log(`========================================`);

  // 定期清理：仅剩余 AI 的房间、长期无人的 waiting 房
  setInterval(async () => {
    try {
      const Room = require('./models/Room');
      const { isBot } = require('./services/roomBots');

      const allRooms = await Room.find({});
      for (const room of allRooms) {
        const humans = room.players.filter((p) => !isBot(p));
        if (humans.length === 0 && room.players.length > 0) {
          await Room.deleteOne({ _id: room._id });
          io.to(room.roomId).emit('room:closed', { reason: '房间已解散' });
          console.log(`清理仅剩余 AI 的房间: ${room.roomId}`);
        }
      }

      const staleRooms = await Room.find({
        'gameState.status': 'waiting',
        updatedAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) }
      });
      for (const room of staleRooms) {
        const realPlayers = room.players.filter((p) => !isBot(p));
        if (realPlayers.length === 0) {
          await Room.deleteOne({ _id: room._id });
          io.to(room.roomId).emit('room:closed', { reason: '房间已解散' });
          console.log(`清理长期无人的 waiting 房间: ${room.roomId}`);
        }
      }
    } catch (error) {
      console.error('清理房间错误:', error);
    }
  }, 30000);
});

// Export io for use in routes
module.exports = { app, io };