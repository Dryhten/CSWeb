export interface Player {
  id: string;
  username: string;
  nickname: string;
  avatar?: string;
  level: number;
  coins: number;
  settings?: PlayerSettings;
}

export interface PlayerSettings {
  sensitivity: number;
  volume: number;
  crosshairColor: string;
}

export interface PlayerStats {
  totalKills: number;
  totalDeaths: number;
  totalWins: number;
  totalLosses: number;
  totalMVP: number;
  headshots: number;
  accuracy: number;
  playTime: number;
}

export interface Room {
  roomId: string;
  name: string;
  isPrivate: boolean;
  settings: RoomSettings;
  players: RoomPlayer[];
  gameState: GameState;
  createdAt: Date;
}

export interface RoomSettings {
  mode: 'pvp' | 'pve' | 'deathmatch' | '1v1';
  map: string;
  maxPlayers: number;
  roundTime: number;
  winScore: number;
  friendlyFire: boolean;
}

export interface RoomPlayer {
  odId: string;
  playerId?: string;
  nickname: string;
  team: 'CT' | 'T' | 'spectator';
  isReady: boolean;
  isHost: boolean;
  stats: PlayerRoomStats;
}

export interface PlayerRoomStats {
  kills: number;
  deaths: number;
  score: number;
  mvps: number;
  damage: number;
}

export interface GameState {
  status: 'waiting' | 'playing' | 'ended';
  round: number;
  ctScore: number;
  tScore: number;
}

export interface Weapon {
  id: string;
  name: string;
  type: 'rifle' | 'pistol' | 'sniper' | 'smg' | 'shotgun';
  damage: number;
  fireRate: number;
  bulletSpeed: number;
  magSize: number;
  reserve: number;
  reloadTime: number;
  maxSpeedU: number;
  price: number;
  rangeSU: number;
  rangeModifier: number;
  headMult: number;
  dmgChestMult: number;
  dmgStomachMult: number;
  dmgLimbMult: number;
  armorPenetration: number;
  penetration: number;
  inaccuracyStand: number;
  inaccuracyMove: number;
  inaccuracyMax: number;
  vmKickZ: number;
  vmKickY: number;
  vmRecoilBackMax: number;
  auto: boolean;
  mode: 'AUTO' | 'SEMI' | 'BOLT';
  label: string;
  slotLabel: string;
}

export interface CharacterConfig {
  moveKnifeSpeed: number;
  sprintMultiplier: number;
  jumpForce: number;
  gravity: number;
  playerHeight: number;
  playerRadius: number;
}

export interface GameMap {
  id: string;
  name: string;
  description?: string;
  thumbnail?: string;
  isActive: boolean;
}

export interface GameMode {
  id: string;
  name: string;
  description?: string;
  maxPlayers: number;
  defaultRoundTime: number;
  defaultWinScore: number;
}

export interface AuthResponse {
  message: string;
  token: string;
  player: Player;
}

export interface RoomListItem {
  roomId: string;
  name: string;
  mode: string;
  map: string;
  maxPlayers: number;
  currentPlayers: number;
  gameState: string;
  createdAt: Date;
}