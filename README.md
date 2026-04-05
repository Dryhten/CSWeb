# 🔥 烈火突击 (Fire Assault)

一个基于 Web 的第一人称射击游戏 (FPS)，支持多人在线对战。

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)
![React](https://img.shields.io/badge/React-18.2-blue)

## 特性

- 🎮 **FPS 游戏体验**: 基于 Three.js 的 3D 第一人称射击
- ⚔️ **多人对战**: 支持 5v5、1v1 等多种模式
- 🏠 **大厅系统**: 创建/加入房间、搜索房间、密码房
- 🔫 **武器系统**: 可配置的枪械参数 (伤害、射速、弹道等)
- 👤 **玩家系统**: 注册登录、战绩统计、等级系统
- 🔧 **配置管理**: 通过后台管理游戏参数

## 技术栈

### 前端
- **框架**: React 18 + TypeScript
- **路由**: React Router v6
- **状态管理**: Zustand
- **构建工具**: Vite
- **3D 引擎**: Three.js
- **HTTP 客户端**: Axios
- **实时通信**: Socket.io Client

### 后端
- **运行时**: Node.js
- **框架**: Express.js
- **数据库**: MongoDB + Mongoose
- **实时通信**: Socket.io
- **认证**: JWT + bcrypt

## 项目结构

```
fire-assault/
├── client/                 # React 前端
│   ├── src/
│   │   ├── components/    # React 组件
│   │   ├── pages/         # 页面组件
│   │   ├── context/       # React Context
│   │   ├── hooks/         # 自定义 Hooks
│   │   ├── services/     # API 服务
│   │   ├── types/         # TypeScript 类型
│   │   └── styles/        # CSS 样式
│   ├── public/
│   │   └── game.html      # 游戏主页面 (Three.js)
│   └── package.json
│
├── server/                 # Node.js 后端
│   ├── src/
│   │   ├── models/        # MongoDB 模型
│   │   ├── routes/        # API 路由
│   │   ├── middleware/    # 中间件
│   │   ├── socket/        # Socket.io 处理
│   │   └── services/      # 业务逻辑
│   └── package.json
│
├── docs/                   # 文档
│   └── ARCHITECTURE.md    # 架构设计
│
└── README.md
```

## 快速开始

### 前置要求

- Node.js 18+
- MongoDB 4.4+

### 安装

1. 克隆仓库
```bash
git clone https://github.com/yourusername/fire-assault.git
cd fire-assault
```

2. 安装后端依赖
```bash
cd server
npm install
```

3. 安装前端依赖
```bash
cd ../client
npm install
```

### 配置

1. 创建 `.env` 文件 (server/.env)
```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/fire-assault
JWT_SECRET=your-secret-key-change-in-production
JWT_EXPIRE=7d
```

### 启动

1. 启动 MongoDB
```bash
mongod
```

2. 启动后端服务器
```bash
cd server
npm start
```

3. 启动前端开发服务器
```bash
cd client
npm run dev
```

4. 访问游戏
- 前端: http://localhost:5173
- 后端 API: http://localhost:3000/api

### 构建生产版本

```bash
cd client
npm run build
```

构建产物在 `client/dist` 目录。

## 功能说明

### 玩家系统
- 注册/登录 (JWT 认证)
- 等级经验系统
- 金币系统
- 战绩统计 (击杀、死亡、胜率等)

### 大厅系统
- 公开房间列表
- 创建房间 (公开/私密)
- 加入房间 (普通/密码)
- 房间搜索
- 快速加入

### 房间系统
- 房主权限 (踢人/开始/设置)
- 队伍分配 (CT/T)
- 准备状态
- 房间设置 (模式/地图/规则)

### 游戏系统
- 实时位置同步
- 开火/命中事件
- 伤害计算
- 回合制游戏逻辑
- 击杀/死亡事件

### 配置系统
- 武器参数 (伤害、射速、弹道等)
- 角色参数 (移速、跳跃、重力等)
- 地图配置
- 游戏模式配置

## API 接口

### 认证
- `POST /api/auth/register` - 注册
- `POST /api/auth/login` - 登录
- `GET /api/auth/verify` - 验证 Token

### 玩家
- `GET /api/player/profile` - 获取个人信息
- `PUT /api/player/profile` - 更新个人信息
- `GET /api/player/stats` - 获取战绩统计
- `GET /api/player/leaderboard` - 玩家排行榜

### 大厅
- `GET /api/lobby/rooms` - 获取房间列表
- `POST /api/lobby/rooms` - 创建房间
- `GET /api/lobby/room/:roomId` - 获取房间信息
- `POST /api/lobby/join/:roomId` - 加入房间
- `POST /api/lobby/leave/:roomId` - 离开房间

### 配置
- `GET /api/config` - 获取游戏配置
- `GET /api/config/weapons` - 获取武器列表
- `GET /api/config/maps` - 获取地图列表
- `PUT /api/config/weapons/:id` - 更新武器配置

## Socket.io 事件

### 大厅
- `room:join` - 加入房间
- `room:leave` - 离开房间
- `room:ready` - 准备状态
- `room:switchTeam` - 切换队伍

### 游戏
- `game:start` - 开始游戏
- `game:playerMove` - 玩家移动
- `game:shoot` - 开火
- `game:hit` - 命中
- `game:roundEnd` - 回合结束

## 管理后台

访问 `/admin` 使用游戏配置管理界面。

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License - see [LICENSE](LICENSE) for details.

## 截图

![Main Menu](docs/screenshots/menu.png)
![Lobby](docs/screenshots/lobby.png)
![Room](docs/screenshots/room.png)