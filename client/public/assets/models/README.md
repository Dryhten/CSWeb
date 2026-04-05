# 第一人称武器配置（`weapons_manifest.json`）

游戏会从 **`weapons_manifest.json`** 读取每把枪的 glTF 路径与持枪姿态；加载失败时使用 `fallback` 对应的程序生成模型。逻辑在 `game.html` 的 viewmodel 初始化中。

路径相对于网站根目录（例如 `assets/models/xxx.glb`）。

---

## 角度单位（固定为「度」）

以下字段在 JSON 里**一律按角度（°）**填写，程序内部会换算为弧度：

- **`meshAlignEuler`**：`[x, y, z]`，欧拉角顺序 **XYZ**（度）
- **`glbRot`**：`[x, y, z]`（度）
- **`rollExtraDeg`**：绕 **Z** 轴额外旋转（度）；可写在 **`defaults`** 里作为全局默认，单条武器可覆盖

不要使用弧度填写上述项。

---

## 顶层字段

| 字段 | 含义 |
|------|------|
| `version` | 配置格式版本，预留。 |
| `defaults` | 各武器条目的**默认缺省值**。 |
| `weapons` | 武器条目数组，每条对应一个槽位（如步枪、手枪）。 |

### `defaults` 里常见项

| 字段 | 含义 |
|------|------|
| `meshAlignEuler` | `[x, y, z]` **度**，把 glb 网格旋转到与第一人称相机前向（大致 **-Z**）对齐；未写单条时用 `[0, 90, 0]`。 |
| `targetSize` | 用包围盒最大边归一化时的**目标长度**（世界单位）。 |
| `rollExtraDeg` | 全局默认「歪头」角（度）；单条可写同名字段覆盖。 |

---

## 每条武器（`weapons[]`）字段说明

示例（近战）：

```json
{
  "id": "melee",
  "url": "assets/models/m9_bayonet_knife.glb",
  "fallback": "procedural_knife",
  "glbPos": [0.38, -0.14, -0.32],
  "glbRot": [6.88, 11.46, 3.44],
  "targetSize": 0.55,
  "vmScale": 0.5
}
```

| 字段 | 含义 |
|------|------|
| `id` | 槽位 ID：`rifle` / `pistol` / `sniper` / `melee`，勿随意改名。 |
| `url` | 该槽位 **glb** 路径（相对站点根目录）。 |
| `fallback` | glb 加载失败时的程序模：`procedural_ak` / `procedural_usp` / `procedural_awp` / `procedural_knife`。 |
| `glbPos` | `[x, y, z]`，持枪根在 viewmodel 相机空间中的**位置**（无角度含义）。 |
| `glbRot` | `[x, y, z]` **度**，持枪根欧拉角（顺序 XYZ）。 |
| `targetSize` | 仅对加载成功的 glb：按包围盒最大边缩放到该长度。 |
| `meshAlignEuler` | （可选）覆盖 `defaults.meshAlignEuler`，**度**。 |
| `vmScale` | 在 `targetSize` 归一化后再乘的缩放。 |
| `rollExtraDeg` | （可选）覆盖 `defaults.rollExtraDeg`。 |

### 仅 `sniper`：开镜额外偏移 `scopeView`（可选）

在程序内置的 AWP 开镜动画**之后**再叠加一层，便于微调贴脸照门/倍镜位置。

| 字段 | 含义 |
|------|------|
| `offsetPos` | `[x, y, z]`，与 `glbPos` 相同单位，按开镜过渡系数 **0→1** 乘上去。 |
| `offsetRotDeg` | `[x, y, z]` **度**，欧拉 XYZ，同样按开镜系数混合。 |

### 仅 `melee`：刺击动画系数 `meleeView`（可选）

覆盖 `client/src/game/entry.ts` 里 `DEFAULT_MELEE_VM` 的同名字段（弧度位移，非角度）。不写则全用代码默认值。

| 字段 | 含义 |
|------|------|
| `chargePullZ` / `chargePullRx` / `chargePullY` | 右键蓄力 1s 期间「后收」位移。 |
| `thrustWindupZ` / `thrustWindupRx` / `thrustWindupBy` | 刺击前摇。 |
| `thrustStabZ` / `thrustStabRx` / `thrustStabRy` / `thrustStabBy` / `thrustStabBx` | 向前刺出主段。 |
| `lightWu` | 轻击：前摇占动画比例 **0～1**。 |
| `heavyWu` | 重击刺击段内「再前摇」占比（相对 **重刺时段**），默认 **0**。蓄力与重刺 **总长 1s** 由代码常量 `MELEE_HEAVY_TOTAL_MS` / `MELEE_HEAVY_CHARGE_MS` 控制。 |
| `thrustScale` | 对上述刺击位移的总倍率。 |
| `heavyThrustStabZ` 等 | （可选）仅**重击**刺击段：`heavyThrustWindupZ/Rx/By`、`heavyThrustStabZ/Rx/Ry/By/Bx`。`heavyThrustStabZ` 为负表示沿准星前向（view **-Z**）伸出。 |

持枪静态位置仍用 **`glbPos` / `glbRot`**；`meleeView` 只调**动画增量**。

---

## 快速改新枪

1. 换 **`url`** 指向新 glb。  
2. 轴向不对：调 **`meshAlignEuler`**（度）或在 Blender 里统一导出。  
3. 大小：调 **`targetSize`** / **`vmScale`**。  
4. 位置/准星：调 **`glbPos`** / **`glbRot`**（度）。  

修改后刷新页面；`fetch` 失败时使用 `game.html` 内嵌备用配置，请保持两者一致或确保能访问本 JSON。
