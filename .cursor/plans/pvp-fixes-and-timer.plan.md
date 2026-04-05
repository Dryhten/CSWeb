---
name: ""
overview: ""
todos: []
isProject: false
---

# PVP 修复与对局计时（修订版）

## 1. 单向无伤害（与「对手 id」）

**你的补充**：对手 id 不应依赖「过期」假设；希望标识稳定、与系统一致。

**实现导向**：

- **不再把「odId 过期」当作唯一根因**；仍可做低成本保险（例如 1v1 下按唯一真人对手解析阵营），但**主路径**应是：**父页 `init` 中的 `players` 与当前 socket 一致**，并在对局页持续与房间事件同步（见下节计时里同一套「以服务端房间状态为准」的思路）。
- 若仍出现无命中上报，应查：`game:hit` 是否到达服务端、`spawnProtectBySocket` 是否对目标误判、以及射线是否被 `shouldTreatRemotePlayerAsHostile` 拦截（与 `multiplayerData` 一致性）。

**仍建议保留的客户端修复**：`markRemotePlayerAlive` 不误删世界掉枪（见第 2 节），与 id 问题无关。

---

## 2. 1v1 / PVP 地面枪复活即消失

**根因**：`[markRemotePlayerAlive](e:/work/CSWeb/client/src/game/entry.ts)` 对 `entry.dropWeaponGroup` 执行 `scene.remove`，把阵亡掉落物删掉。

**修复**：复活时仅 `entry.dropWeaponGroup = null`，不 `remove` 世界拾取物（与 `[spawnWorldWeaponDrop](e:/work/CSWeb/client/src/game/entry.ts)` 中 1v1 无过期一致）。

---

## 3. 对局时间：由「本机进房时刻」改为「房间 / 服务端锚点」

**现状**： `[setupPvpMatchTimerForStart](e:/work/CSWeb/client/src/game/entry.ts)` （约 7428–7439 行）使用 `performance.now() + PVP_MATCH_DURATION_MS`，且在 `[startGame](e:/work/CSWeb/client/src/game/entry.ts)`（约 7025 行）调用 → **每名玩家本地进图时刻不同则结束时刻不同**；且时长写死 5 分钟，与 `[Room.settings.roundTime](e:/work/CSWeb/server/src/models/Room.js)`（秒，默认 120）无关。

**服务端已有**：`[game:start](e:/work/CSWeb/server/src/socket/index.js)` 写入 `room.gameState.startTime = new Date()`，并通过 `game:started` 下发 `gameState.startTime` 与 `settings`（含 `roundTime`）。

**目标行为**：

- **结束时刻** = `startTime`（服务端开局时间）+ `settings.roundTime`（秒）× 1000，用 `**Date` 墙钟** 计算剩余时间（与 `performance.now()` 解耦），避免「晚进房多玩一会」。
- **晚加入**：从父页 `init` 带入的 `gameState.startTime` + `settings.roundTime` 计算 **剩余秒数** 初始化 HUD；若已超时则直接走结束逻辑或与服务端对齐（需约定：仅房主/服务端可 `game:start`，补位进 `playing` 时必带最新 `gameState`）。
- **可选增强**（若担心客户端时钟漂移）：在 `game:started`（或 `init`）中附带服务端 `serverNow`（ms），客户端记 `offset = serverNow - Date.now()`，用 `(Date.now() + offset)` 参与截止计算。

**涉及文件**：

- `[client/src/game/entry.ts](e:/work/CSWeb/client/src/game/entry.ts)`：`setupPvpMatchTimerForStart` 改为接收或使用 `multiplayerData.gameState.startTime`、`multiplayerData.settings.roundTime`；`updatePvpMatchTimerDisplay` 用截止时间与当前时间差；去掉或仅保留常量作兜底默认。
- `[client/src/pages/Game.tsx](e:/work/CSWeb/client/src/pages/Game.tsx)`：`sendInit` 确保把 `gameState.startTime`（及完整 `settings`）传给 iframe；若用户从 `getRoom` 进门，响应里应含上述字段。
- 若 `[Room.tsx](e:/work/CSWeb/client/src/pages/Room.tsx)` 在 `game:started` 时合并了 `gameState`，导航到 Game 时 store 应已带 `startTime`——需核对类型与序列化（ISO 字符串 → `Date`）。

**服务端（按需）**：若希望「时间到」由**服务端**强制结束，可增加定时器或客户端 `game:matchTimeUp` 由服务端校验后广播 `game:ended` / `room:gameStateUpdated`；首版可先客户端统一用服务端 `startTime` + `roundTime`，减少双端不同步。

---

## 4. 1v1 单局时长：房间设置可自定义

**现状**：`[roundTime](e:/work/CSWeb/server/src/routes/lobby.js)` 在创建房间时写入（默认 120），客户端 **暂无** 创建/编辑房间 UI 暴露 `roundTime`（`grep` 客户端 tsx 无引用）。

**目标**：1v1（或可扩展到 PVP）房主可在房间内设置 **单局时长（秒）**，与第 3 节客户端计时共用 `settings.roundTime`。

**实现要点**：

- 使用已有 `[PUT /room/:roomId/settings](e:/work/CSWeb/server/src/routes/lobby.js)`（若已支持合并 `settings`）增加对 `roundTime` 的校验（例如 60–600 秒）并在 1v1 下允许修改。
- `[Room.tsx](e:/work/CSWeb/client/src/pages/Room.tsx)`（或创建房间页）：增加「单局时间」输入/下拉，写入 `settings.roundTime`；仅房主可见。
- 类型 `[RoomSettings](e:/work/CSWeb/client/src/types/index.ts)` 已含 `roundTime`，无需改模型。

---

## 5. 执行顺序建议

1. 掉枪：`markRemotePlayerAlive` 不删世界掉落（小改动、低风险）。
2. 计时：iframe 用 `startTime` + `roundTime`；`Game.tsx` init 字段齐全。
3. 房间 UI：`roundTime` 可配置（1v1 优先）。
4. 伤害：在 id 稳定前提下，若仍复现再针对性加日志或保留 1v1 阵营兜底。

---

## Todos

- `entry.ts`：`markRemotePlayerAlive` 仅断开 `dropWeaponGroup` 引用，不 remove 场景
- `entry.ts`：PVP 倒计时基于 `gameState.startTime` + `settings.roundTime`，晚进房剩余时间正确
- `Game.tsx`：init 传入完整 `gameState.startTime` 与 `settings`（含 `roundTime`）
- `Room.tsx` + API：1v1 房主可设置 `roundTime` 并保存
- （可选）`game:started` 增加 `serverNow` 校正客户端时钟
- （按需）伤害：父页监听 `room:playerJoined` 等刷新 `players`；或 1v1 唯一对手阵营兜底

