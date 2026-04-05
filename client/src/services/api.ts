import axios from 'axios';
import type { AuthResponse, Player, Room, RoomListItem, Weapon, CharacterConfig, GameMap, GameMode } from '../types';

const API_BASE = '/api';

/** 与后端 MongoDB 房间号一致（大写） */
function lobbyRoomIdParam(roomId: string) {
  return encodeURIComponent(String(roomId || '').trim().toUpperCase());
}

const api = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const url = error.config?.url || '';
      if (!url.includes('/auth/')) {
        localStorage.removeItem('token');
        localStorage.removeItem('player');
        window.location.href = '/';
      }
    }
    return Promise.reject(error);
  }
);

export const authApi = {
  register: (data: { username: string; password: string; nickname?: string }) =>
    api.post<AuthResponse>('/auth/register', data),

  login: (data: { username: string; password: string }) =>
    api.post<AuthResponse>('/auth/login', data),

  verify: () => api.get<{ valid: boolean; player: Player }>('/auth/verify'),
};

export const playerApi = {
  getProfile: () => api.get<Player>('/player/profile'),

  updateProfile: (data: Partial<Player>) => api.put('/player/profile', data),

  getStats: () => api.get('/player/stats'),

  getInventory: () => api.get('/player/inventory'),

  updateSettings: (data: { sensitivity?: number; volume?: number; crosshairColor?: string }) =>
    api.put('/player/settings', data),

  getLeaderboard: (limit = 10) => api.get(`/player/leaderboard?limit=${limit}`),
};

export const lobbyApi = {
  getRooms: () => api.get<RoomListItem[]>('/lobby/rooms'),

  searchRoom: (roomId: string) => api.get(`/lobby/rooms/search/${lobbyRoomIdParam(roomId)}`),

  createRoom: (data: { name: string; password?: string; settings?: Partial<Room['settings']> }) =>
    api.post('/lobby/rooms', data),

  getRoom: (roomId: string) => api.get<Room>(`/lobby/room/${lobbyRoomIdParam(roomId)}`),

  joinRoom: (roomId: string, password?: string, team?: 'CT' | 'T') =>
    api.post(`/lobby/join/${lobbyRoomIdParam(roomId)}`, { password, team }),

  leaveRoom: (roomId: string) => api.post(`/lobby/leave/${lobbyRoomIdParam(roomId)}`),

  updateRoomSettings: (roomId: string, settings: Partial<Room['settings']>) =>
    api.put(`/lobby/room/${lobbyRoomIdParam(roomId)}/settings`, { settings }),

  kickPlayer: (roomId: string, playerId: string) =>
    api.post(`/lobby/room/${lobbyRoomIdParam(roomId)}/kick`, { playerId }),
};

export const configApi = {
  getAll: () => api.get('/config'),

  getWeapons: () => api.get<Weapon[]>('/config/weapons'),

  getWeapon: (id: string) => api.get<Weapon>(`/config/weapons/${id}`),

  updateWeapon: (id: string, data: Partial<Weapon>) =>
    api.put(`/config/weapons/${id}`, data),

  updateCharacter: (data: Partial<CharacterConfig>) =>
    api.put('/config/character', data),

  getMaps: () => api.get<GameMap[]>('/config/maps'),

  getModes: () => api.get<GameMode[]>('/config/modes'),
};

export default api;