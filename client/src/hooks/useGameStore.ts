import { create } from 'zustand';
import type { Room, RoomListItem } from '../types';
import { lobbyApi } from '../services/api';

interface GameStore {
  // Lobby
  rooms: RoomListItem[];
  isLoadingRooms: boolean;
  loadRooms: () => Promise<void>;
  searchRooms: (query: string) => Promise<void>;

  // Room
  currentRoom: Room | null;
  isInRoom: boolean;
  isHost: boolean;
  isReady: boolean;
  createRoom: (data: { name: string; password?: string; settings?: any }) => Promise<string>;
  joinRoom: (roomId: string, password?: string, team?: 'CT' | 'T') => Promise<void>;
  leaveRoom: () => Promise<void>;
  setReady: (ready: boolean) => void;
  updateRoom: (room: Room) => void;
  startGame: () => void;
  reset: () => void;
}

export const useGameStore = create<GameStore>((set, get) => ({
  // Lobby state
  rooms: [],
  isLoadingRooms: false,

  loadRooms: async () => {
    set({ isLoadingRooms: true });
    try {
      const response = await lobbyApi.getRooms();
      set({ rooms: response.data, isLoadingRooms: false });
    } catch (error) {
      console.error('Failed to load rooms:', error);
      set({ isLoadingRooms: false });
    }
  },

  searchRooms: async (query: string) => {
    if (!query.trim()) {
      get().loadRooms();
      return;
    }
    set({ isLoadingRooms: true });
    try {
      const response = await lobbyApi.searchRoom(query.toUpperCase());
      set({ rooms: response.data ? [response.data] : [], isLoadingRooms: false });
    } catch {
      set({ rooms: [], isLoadingRooms: false });
    }
  },

  // Room state
  currentRoom: null,
  isInRoom: false,
  isHost: false,
  isReady: false,

  createRoom: async (data) => {
    const response = await lobbyApi.createRoom(data);
    const roomId = response.data.room.roomId;
    // 获取最新房间数据
    const roomResponse = await lobbyApi.getRoom(roomId);
    set({
      currentRoom: roomResponse.data,
      isInRoom: true,
      isHost: true,
      isReady: false
    });
    return roomId;
  },

  joinRoom: async (roomId: string, password?: string, team?: 'CT' | 'T') => {
    await lobbyApi.joinRoom(roomId, password, team);
    // 获取最新房间数据
    const roomResponse = await lobbyApi.getRoom(roomId);
    const playerStr = localStorage.getItem('player');
    const player = playerStr ? JSON.parse(playerStr) : null;
    const isHost = roomResponse.data.players.some((p: any) => p.isHost && p.playerId === player?.id);
    set({
      currentRoom: roomResponse.data,
      isInRoom: true,
      isHost: isHost,
      isReady: false
    });
  },

  leaveRoom: async () => {
    const room = get().currentRoom;
    if (room) {
      try {
        await lobbyApi.leaveRoom(room.roomId);
      } catch (e) {
        // Ignore errors on leave
      }
    }
    set({
      currentRoom: null,
      isInRoom: false,
      isHost: false,
      isReady: false
    });
  },

  setReady: (ready: boolean) => {
    set({ isReady: ready });
  },

  updateRoom: (room: Room) => {
    const playerStr = localStorage.getItem('player');
    const player = playerStr ? JSON.parse(playerStr) : null;
    const myId = player?.id;
    const me = room.players.find((p: any) => {
      const pid = p.playerId && (typeof p.playerId === 'object' ? p.playerId._id || p.playerId : p.playerId);
      return pid != null && String(pid) === String(myId);
    });
    set({
      currentRoom: room,
      isInRoom: !!me,
      isHost: !!me?.isHost,
      isReady: me ? !!me.isReady : false
    });
  },

  startGame: () => {
    // Game start logic - will integrate with game canvas
    console.log('Starting game...');
  },

  reset: () => {
    set({
      rooms: [],
      currentRoom: null,
      isInRoom: false,
      isHost: false,
      isReady: false
    });
  }
}));