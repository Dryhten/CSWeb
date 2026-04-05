// @ts-nocheck
/** 游戏数值与武器表（供 entry 与各子模块 import） */

export const GAME = {
  running: false,
  paused: false,
  kills: 0,
  score: 0,
  headshots: 0,
  money: 16000,
  health: 100,
  maxHealth: 100,
  /** 联机/房间内阵营，影响出生点与友军判定 */
  playerTeam: 'CT',
  playerIsHost: false,
  mouseSensitivity: 0.003,
  gravity: -25,
  jumpForce: 9,
  moveKnifeSpeed: 6,
  sprintMultiplier: 1.6,
  playerHeight: 1.7,
  playerRadius: 0.4,
  mapSize: 60,
  /** 使用 public 目录下 de_dust2.glb（合并网格 + BVH 碰撞） */
  useDust2GlbMap: true,
  dust2GlbUrl: 'assets/models/maps/de_dust2.glb',
  /**
   * Sketchfab 等导出常为「整图几单位」或厘米感；游戏按米（人高 1.7）。
   * 若仍显小/大，在 30～200 之间微调。
   */
  dust2MapScale: 4,
  dust2MapPosition: [0, 0, 0],
  dust2MapRotationY: 0,
  /** 加载后将包围盒 min.y 贴到世界 y=0，避免整体悬空 */
  dust2AlignMinYToZero: true,
  /** 出生/重生时脚底比射线地面略高（米），减少卡进地面与掉落 */
  dust2SpawnFeetLift: 0.12,
  /**
   * 行走时相对当前脚底最多自动抬高（米），超过需跳跃；防止走上矮箱/台阶状装饰。
   * 约 0.12～0.16 可挡「四分之一箱高」类物体；过小会卡正常台阶。
   */
  dust2MaxWalkStepUp: 0.14,
  /**
   * 下坡时若仅略高于地面（射线地面低于相机），仍视为可贴地站立；需大于单帧坡面可能落差，否则 onGround 长期为 false 无法跳跃。
   */
  dust2MaxWalkStepDown: 0.52,
  /**
   * 仅当竖直速度「不太像自由落体」时才允许用 dust2MaxWalkStepDown 做宽间隙贴地；跳跃落地 vy 很大负值时不应整段瞬移贴地。
   * 典型单帧重力约 -0.42（gravity=-25, 60fps），下坡取略宽于该值。
   */
  dust2SlopeGroundSnapMaxFallVy: -1.38,
  /** 快落地时间隙小于此（米）时仍强制贴地，避免卡浮点 */
  dust2LandSnapNearGap: 0.048,
  /**
   * BVH 水平扇区：法线朝上分量 ≥ 此值视为坡/地，不挡水平移动（略高可减少碎起伏、裂缝竖面误挡）
   */
  dust2WallWalkableMinNy: 0.44,
  /** 水平射线起点相对目标点向内收（米），略大则少蹭到边缘碎三角 */
  dust2WallRayInset: 0.14,
  /**
   * 水平扇区射线：判定为挡墙时 hit 距离上限 = playerRadius + 此值（米）。
   * 略大于旧版固定 0.22，贴边缘平行蹭时更早触发挡墙，减少卡进缝/碎面（对标 CS 系 hull 与几何间留 epsilon）。
   */
  dust2WallCastExtra: 0.3,
  /**
   * 未落地时（蹭平面下落、沿坡滑）水平挡墙用此余量，略小于站立值，避免接缝竖面反复挡位移。
   */
  dust2WallCastExtraAir: 0.22,
  /** 扇区数量（略少可减少碎几何误挡；过少女墙可能漏检） */
  dust2WallSectorCount: 14,
  /**
   * 命中距离小于此值且法线较「侧立」时，视为裂缝/碎面而非实体墙（米）
   */
  dust2WallMicroGapMaxDist: 0.14,
  /** 未落地时略增大，更易忽略地面接缝处的极近竖向命中（米） */
  dust2WallMicroGapAir: 0.22,
  /**
   * BVH 挤出：pad 越大越「深」才修正，减少台沿假穿透抖动；配合 maxPush 单步上限防穿模又不易卡死
   */
  dust2ResolvePenetrationPad: 0.11,
  /** 玩家每轮挤出在 XZ 上最多移动（米），多轮迭代仍温和 */
  dust2ResolvePenetrationMaxPush: 0.034,
  /** 贴墙滑移步允许相对上一帧略增的陷入深度（米），与 xzPenetrationExcess 配合 */
  dust2WallSlidePenetrationSlack: 0.006,
  /**
   * 仅「慢速飘落、几乎贴地」时挤出乘数（见 resolvePlayerWallPenetration）；正常下落贴竖箱仍用 1，避免贴模无法滑移。
   */
  dust2ResolvePenetrationPushScaleAir: 0.45,
  dust2AirborneMaxFeetDrop: 3.5,
  /** 出生采样时 u/v 远离包围盒边界的比例（过大易落在模型外） */
  dust2SpawnEdgeMargin: 0.07,
  /** 单点抖动幅度（相对包围盒 0~1） */
  dust2SpawnJitter: 0.011,
  /** 躯干处与网格最小净空（米），过小视为生在墙/装饰内 */
  dust2SpawnTorsoMinClear: 0.13,
  /** 脚底附近四方地面高度差上限（米），过大视为坡/异常面 */
  dust2SpawnMaxGroundSlope: 1.15,
  /** 每个预设 UV 尝试次数（抖动） */
  dust2SpawnPerUvTries: 16,
  /** 预设 UV 全失败后，在包围盒内随机撒点次数 */
  dust2SpawnMonteCarloTries: 80,
  /**
   * 若当前 GLB 与默认 UV 轴向不一致，可尝试 true 再试
   */
  dust2SpawnUvFlipU: false,
  dust2SpawnUvFlipV: false,
  /**
   * 按 id 覆盖默认 UV，例如 { t_spawn: { u: 0.52, v: 0.82 }, ct_spawn: { u: 0.48, v: 0.15 } }
   */
  dust2SpawnUvOverrides: null,

  /**
   * true：出生只从 dust2FixedSpawnPoints 里轮换（无抖动），便于先测固定点。
   * false：仍用多 UV + 抖动 + 蒙特卡洛等逻辑。
   */
  dust2UseFixedSpawnPointsOnly: true,
  /**
   * 旧版兼容：未配置分队出生点时仍使用
   * @deprecated 优先使用 dust2CtSpawnPoints / dust2TSpawnPoints
   */
  dust2FixedSpawnPoints: [],
  /** CT 侧 UV 出生（空数组则不用；有 dust2WorldSpawnPoints 时由世界坐标优先） */
  dust2CtSpawnPoints: [],
  /** T 侧 UV 出生 */
  dust2TSpawnPoints: [],
  /** 固定点全部校验失败时，是否退回原来的随机撒点；测试阶段建议 false */
  dust2SpawnFallbackToRandom: false,

  /**
   * 沙漠2：开局与复活共用，世界空间 XZ（与调试面板「脚底」一致）。
   * 非空时最优先；复活时在若干次随机抽取中选离阵亡位置较远的一点。
   */
  dust2WorldSpawnPoints: [
    { x: -40.164, z: -36.999 },
    { x: -45.133, z: 4.666 },
    { x: -42.555, z: 57.928 },
    { x: -4.094, z: 58.113 },
    { x: 28.801, z: 46.272 },
    { x: -5.211, z: 22.434 },
    { x: 32.89, z: 4.431 },
    { x: 40.542, z: 23.916 },
    { x: 50.066, z: 29.872 },
    { x: 60.977, z: 14.698 },
    { x: 43.986, z: -44.676 },
    { x: 20.391, z: -28.919 },
    { x: 25.081, z: -12.043 },
  ],

  /** 脚底相对「周围地面」过高则拒绝（排除屋顶、箱子顶等） */
  dust2SpawnLocalGroundSampleRadius: 1.85,
  dust2SpawnMaxAboveLocalGround: 1.05,
  /** 脚底不高于地图包围盒 min.y + 该值（米），抑制高层可走面（按你 scale 可调） */
  dust2SpawnMaxAbsHeightAboveMin: 14,
  /** 水平方向至少近似该半径内无墙（米），视为开阔 */
  dust2SpawnMinOpenRadius: 1.85,
  /**
   * 脚底射线地面（不含 lift）不得低于包围盒 min.y 超过该值（米），否则禁止作为出生点（防地图底外/模型下方）
   */
  dust2SpawnForbiddenBelowMinY: 0.12,
};

export const RECOIL_PATTERNS = { ak: [], usp: [], awp: [] };
(function buildRecoilPatterns() {
  for(let i = 0; i < 40; i++) {
    let up = 0.0068 + i * 0.0034 + Math.max(0, i - 9) * 0.00085;
    if(i === 0) up = 0.0018;
    else if(i === 1) up = 0.0032;
    else if(i === 2) up = 0.005;
    let side = Math.sin(i * 0.88) * (0.0014 + i * 0.00011);
    if(i > 3 && i < 18) side += Math.sin(i * 1.35) * 0.0011;
    if(i < 2) side *= 0.4;
    RECOIL_PATTERNS.ak.push({ x: side, y: up });
  }
  for(let i = 0; i < 16; i++) {
    const up = 0.009 + i * 0.0042;
    const side = Math.sin(i * 0.72) * (0.0028 + i * 0.00025);
    RECOIL_PATTERNS.usp.push({ x: side, y: up });
  }
  RECOIL_PATTERNS.awp.push({ x: 0, y: 0.052 });
})();

export const WEAPONS = [
  { name:'AK-47', type:'rifle', damage:36, fireRate:100, bulletSpeed:355, magSize:30, reserve:90, reloadTime:2430,
    maxSpeedU:215, weightSU:25, price:2700,
    rangeSU:500, rangeModifier:0.98,
    headMult:4, dmgChestMult:1, dmgStomachMult:1, dmgLimbMult:0.75,
    armorPenetration:77.5, penetration:2,
    patternId:'ak', patternRng:0.00105, inaccuracyCrouchMult:0.5,
    inaccuracyStand:0.00205, inaccuracyMove:0.0142, inaccuracySpray:0.00092, inaccuracyMax:0.048,
    vmKickZ:0.048, vmKickY:0.145, vmRecoilBackMax:0.132, auto:true, label:'AK-47', slotLabel:'AK', mode:'AUTO' },
  { name:'USP-S', type:'pistol', damage:35, fireRate:170, bulletSpeed:218, magSize:12, reserve:24, reloadTime:2200,
    maxSpeedU:230, weightSU:1, price:200,
    rangeSU:500, rangeModifier:0.85,
    headMult:4, dmgChestMult:1, dmgStomachMult:1, dmgLimbMult:0.75,
    armorPenetration:50.5, penetration:1,
    patternId:'usp', patternRng:0.0016, inaccuracyCrouchMult:0.55,
    inaccuracyStand:0.00145, inaccuracyMove:0.0098, inaccuracySpray:0.00058, inaccuracyMax:0.034,
    vmKickZ:0.03, vmKickY:0.085, vmRecoilBackMax:0.072, auto:false, label:'USP-S', slotLabel:'USP', mode:'SEMI' },
  { name:'AWP', type:'sniper', damage:115, fireRate:1480, bulletSpeed:428, magSize:5, reserve:30, reloadTime:3670,
    maxSpeedU:200, weightSU:30, price:4750,
    rangeSU:8192, rangeModifier:0.99,
    headMult:4, dmgChestMult:1, dmgStomachMult:1, dmgLimbMult:0.75,
    armorPenetration:97.5, penetration:3,
    patternId:'awp', patternRng:0.00035, inaccuracyCrouchMult:0.48,
    inaccuracyStand:0.00115, inaccuracyMove:0.042, inaccuracySpray:0, inaccuracyMax:0.065,
    inaccuracyScoped:0.00022,
    vmKickZ:0.1, vmKickY:0.38, vmRecoilBackMax:0.142, auto:false, label:'AWP', slotLabel:'AWP', mode:'BOLT' },
  { name:'Knife', type:'melee', damage:40, fireRate:400, bulletSpeed:0, magSize:999, reserve:999, reloadTime:0,
    maxSpeedU:250, weightSU:0, price:0,
    rangeSU:60, rangeModifier:1,
    headMult:1, dmgChestMult:1, dmgStomachMult:1, dmgLimbMult:1,
    armorPenetration:0, penetration:0,
    patternId:null, patternRng:0, inaccuracyCrouchMult:0.5,
    inaccuracyStand:0, inaccuracyMove:0, inaccuracySpray:0, inaccuracyMax:0,
    vmKickZ:0, vmKickY:0, vmRecoilBackMax:0, auto:false, label:'Knife', slotLabel:'🔪', mode:'MELEE' },
];

export const SPRAY_RESET_MS = 320;

export const VM_AMBIENT_MULT = 1.55;
export const VM_HEMI_MULT = 1.4;
export const VM_SUN_MULT = 1.12;
export const MAX_BULLET_DECALS = 120;
export const BULLET_DECAL_LIFE = 42;
export const BULLET_DECAL_FADE = 6;

export const SCOPE_ZOOM_DURATION = 0.3;
export const SCOPE_VM_HIDE_AT = 0.2;
export const CAM_FOV_HIP = 75;
export const CAM_FOV_SCOPED_1 = 26;
export const CAM_FOV_SCOPED_2 = 14;
export const VM_FOV_HIP = 64;
export const VM_FOV_AWP_HIP = 64;
export const VM_FOV_SCOPED_1 = 34;
export const VM_FOV_SCOPED_2 = 22;
export const SCOPE_SENS_MULT = 0.26;
export const SCOPE_SENS_MULT_2 = 0.2;

export const THIRD_PERSON_DIST = 3.05;
export const THIRD_PERSON_Y_LIFT = 0.36;
/**
 * 沿视点相机右轴平移（米）。负值=机位在角色左侧后（左肩后），人物落在画面右下；
 * 正值=右肩后，人物在左下。须与 thirdPersonCamera 中「保持朝向、不 lookAt 眼部」配合。
 */
export const THIRD_PERSON_SHOULDER_OFFSET = -0.68;
/** 第三人称武器相对第一人称手/眼矩阵的世界 Y 偏移（米，负值下移），统一对齐胸部高度 */
export const THIRD_PERSON_WEAPON_Y_OFFSET = -0.16;

/** 空字符串则仅用程序第三人称替身（不请求 GLB） */
export const PLAYER_AVATAR_GLB = '';
export const PLAYER_AVATAR_YAW_OFFSET = Math.PI;
export const PLAYER_AVATAR_FEET_LIFT = 0.1;
