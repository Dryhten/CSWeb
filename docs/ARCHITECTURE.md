# 烈火突击 - 游戏架构设计方案

## 1. 技术栈

### 后端
- **运行时**: Node.js + Express
- **实时通信**: Socket.io (WebSocket)
- **数据库**: MongoDB + Mongoose
- **认证**: JWT + bcrypt

### 前端
- **游戏引擎**: Three.js (保持现有)
- **UI框架**: 原生HTML/CSS/JS
- **状态管理**: 前端SessionStorage

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                        客户端 (浏览器)                        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────┐  │
│  │ 游戏主程序 │  │ 大厅UI  │  │ 房间UI  │  │ 管理后台(可选)   │  │
│  └────┬────┘  └────┬────┘  └────┬────┘  └───────┬────────┘  │
└───────┼───────────┼───────────┼───────────────┼────────────┘
        │           │           │               │
        └───────────┴───────────┴───────────────┘
                          │
                    Socket.io / HTTP
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                        服务器                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                    API 服务 (Express)                │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │  │
│  │  │ 玩家API  │ │ 房间API  │ │ 大厅API  │ │ 配置API │  │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘  │  │
│  └───────┼────────────┼────────────┼──────────┼───────┘  │
│          │            │            │          │          │
│  ┌───────┴────────────┴────────────┴──────────┴───────┐  │
│  │              Socket.io 游戏同步服务                    │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │  │
│  │  │ 大厅管理  │ │ 房间管理  │ │ 战斗同步  │ │ 状态同步│  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘  │  │
│  └───────────────────────────┬─────────────────────────┘  │
│                              │                             │
│  ┌───────────────────────────┴─────────────────────────┐  │
│  │              MongoDB 数据库                          │  │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌─────────────┐  │  │
│  │  │ 玩家   │ │ 房间   │ │ 战绩   │ │ 游戏配置    │  │  │
│  │  └────────┘ └────────┘ └────────┘ └─────────────┘  │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 3. 数据库模型

### 玩家 (Player)
```javascript
{
  _id: ObjectId,
  username: String,        // 用户名 (唯一)
  password: String,        // 密码 (加密)
  nickname: String,        // 昵称
  avatar: String,          // 头像URL
  level: Number,           // 等级
  exp: Number,            // 经验值
  coins: Number,          // 金币
  registerTime: Date,      // 注册时间
  lastLoginTime: Date,    // 最后登录
  
  // 战绩统计
  stats: {
    totalKills: Number,    // 总击杀
    totalDeaths: Number,   // 总死亡
    totalWins: Number,     // 总胜场
    totalLosses: Number,   // 总负场
    totalMVP: Number,      // MVP次数
    headshots: Number,     // 爆头数
    accuracy: Number,      // 命中率(%)
    playTime: Number       // 游玩时间(秒)
  },
  
  // 背包/武器
  inventory: {
    weapons: [String],     // 已拥有武器ID列表
    currentWeapon: String  // 当前装备主武器
  },
  
  // 设置
  settings: {
    sensitivity: Number,   // 鼠标灵敏度
    volume: Number,        // 音量
    crosshairColor: String // 准星颜色
  }
}
```

### 房间 (Room)
```javascript
{
  _id: ObjectId,
  roomId: String,          // 房间号 (唯一, 如 "ABC123")
  name: String,           // 房间名称
  password: String,       // 房间密码 (可选, 隐藏房间)
  isPrivate: Boolean,     // 是否私密
  
  // 房间设置
  settings: {
    mode: String,         // "pvp" / "pve"
    map: String,         // 地图ID
    maxPlayers: Number,   // 最大人数 (默认10)
    roundTime: Number,   // 回合时间(秒)
    winScore: Number,    // 获胜分数
    friendlyFire: Boolean // 友军伤害
  },
  
  // 玩家列表
  players: [{
    odId: String,         // socket.id
    playerId: ObjectId,   // 玩家ID
    team: String,         // "CT" / "T"
    isReady: Boolean,
    isHost: Boolean,      // 房主
    stats: {             // 房间内数据
      kills: Number,
      deaths: Number,
      score: Number
    }
  }],
  
  // 游戏状态
  gameState: {
    status: String,      // "waiting" / "playing" / "ended"
    round: Number,       // 当前回合
    ctScore: Number,
    tScore: Number,
    startTime: Date,
    endTime: Date
  },
  
  createdAt: Date,
  createdBy: ObjectId
}
```

### 游戏配置 (GameConfig)
```javascript
{
  _id: ObjectId,
  name: String,           // 配置名称
  
  // 武器配置
  weapons: [{
    id: String,
    name: String,
    type: String,        // "rifle" / "pistol" / "sniper" / "smg"
    damage: Number,
    fireRate: Number,    // 射速(ms)
    bulletSpeed: Number,
    magSize: Number,     // 弹匣容量
    reserve: Number,     // 备弹
    reloadTime: Number,  // 换弹时间(ms)
    maxSpeedU: Number,   // 持枪移速
    price: Number,       // 价格
    
    // 伤害参数
    rangeSU: Number,
    rangeModifier: Number,
    headMult: Number,    // 头部伤害倍率
    armorPenetration: Number,
    penetration: Number,
    
    // 弹道参数
    inaccuracyStand: Number,
    inaccuracyMove: Number,
    inaccuracyCrouch: Number,
    inaccuracyMax: Number,
    
    // 枪模参数
    vmKickZ: Number,
    vmKickY: Number,
    vmRecoilBackMax: Number,
    
    auto: Boolean,
    mode: String         // "AUTO" / "SEMI" / "BOLT"
  }],
  
  // 角色配置
  character: {
    moveKnifeSpeed: Number,  // 持刀移速
    sprintMultiplier: Number,// 冲刺倍率
    jumpForce: Number,       // 跳跃力度
    gravity: Number,         // 重力
    playerHeight: Number,    // 身高
    playerRadius: Number     // 碰撞半径
  },
  
  // 模式配置
  gameModes: [{
    id: String,
    name: String,
    maxPlayers: Number,
    defaultRoundTime: Number,
    defaultWinScore: Number
  }],
  
  // 地图配置
  maps: [{
    id: String,
    name: String,
    description: String,
    thumbnail: String,
    isActive: Boolean
  }],
  
  isActive: Boolean,     // 是否激活
  updatedAt: Date
}
```

### 战绩记录 (MatchRecord)
```javascript
{
  _id: ObjectId,
  roomId: ObjectId,
  mode: String,
  map: String,
  
  players: [{
    playerId: ObjectId,
    team: String,
    kills: Number,
    deaths: Number,
    score: Number,
    mvps: Number,
    headshots: Number,
    damage: Number
  }],
  
  result: {
    winner: String,      // "CT" / "T" / "draw"
    ctScore: Number,
    tScore: Number
  },
  
  duration: Number,      // 时长(秒)
  playedAt: Date
}
```

## 4. API 接口设计

### 玩家相关
- `POST /api/auth/register` - 注册
- `POST /api/auth/login` - 登录
- `GET /api/player/profile` - 获取个人信息
- `PUT /api/player/profile` - 更新个人信息
- `GET /api/player/stats` - 获取战绩统计
- `GET /api/player/inventory` - 获取背包
- `PUT /api/player/settings` - 更新设置

### 大厅相关
- `GET /api/lobby/rooms` - 获取公开房间列表
- `POST /api/lobby/rooms` - 创建房间
- `GET /api/lobby/room/:roomId` - 获取房间信息
- `POST /api/lobby/join/:roomId` - 加入房间
- `POST /api/lobby/leave/:roomId` - 离开房间

### 游戏配置
- `GET /api/config/weapons` - 获取武器列表
- `PUT /api/config/weapons/:id` - 更新武器配置
- `GET /api/config/maps` - 获取地图列表
- `GET /api/config/modes` - 获取模式列表

## 5. Socket.io 事件

### 大厅事件
- `lobby:rooms` - 房间列表更新
- `lobby:create` - 创建房间
- `lobby:join` - 加入房间
- `lobby:leave` - 离开房间
- `lobby:ready` - 准备就绪

### 游戏事件
- `game:start` - 开始游戏
- `game:sync` - 状态同步
- `player:move` - 玩家移动
- `player:shoot` - 开火
- `player:hit` - 命中
- `player:death` - 死亡
- `game:round` - 回合切换
- `game:end` - 游戏结束

## 6. 功能模块

### 6.1 玩家系统
- 注册/登录 (JWT)
- 等级经验系统
- 金币系统
- 战绩统计

### 6.2 大厅系统
- 公开房间列表
- 创建房间 (公开/私密)
- 加入房间 (普通/密码)
- 房间搜索
- 玩家准备状态

### 6.3 房间系统
- 房主权限 (踢人/开始/设置)
- 队伍分配 (CT/T)
- 房间设置 (模式/地图/规则)
- 实时玩家列表

### 6.4 战斗系统
- 实时位置同步
- 子弹命中检测
- 伤害计算
- 击杀/死亡事件
- 回合制游戏逻辑

### 6.5 配置系统
- 武器参数 (伤害/射速/弹道等)
- 角色参数 (移速/跳跃/重力等)
- 地图配置
- 游戏模式配置