import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { authApi } from '../services/api';
import socketService from '../services/socket';
import type { Player } from '../types';

interface AuthContextType {
  player: Player | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, nickname?: string) => Promise<void>;
  logout: () => void;
  updatePlayer: (data: Partial<Player>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [player, setPlayer] = useState<Player | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    const storedPlayer = localStorage.getItem('player');

    if (storedToken && storedPlayer) {
      setToken(storedToken);
      const player = JSON.parse(storedPlayer);
      setPlayer(player);
      localStorage.setItem('playerId', player.id);
      localStorage.setItem('nickname', player.nickname);
      socketService.connect();
    }

    setIsLoading(false);
  }, []);

  const login = async (username: string, password: string) => {
    const response = await authApi.login({ username, password });
    const { token: newToken, player: newPlayer } = response.data;

    localStorage.setItem('token', newToken);
    localStorage.setItem('playerId', newPlayer.id);
    localStorage.setItem('nickname', newPlayer.nickname);
    localStorage.setItem('player', JSON.stringify(newPlayer));

    setToken(newToken);
    setPlayer(newPlayer);
    socketService.connect();
  };

  const register = async (username: string, password: string, nickname?: string) => {
    const response = await authApi.register({ username, password, nickname });
    const { token: newToken, player: newPlayer } = response.data;

    localStorage.setItem('token', newToken);
    localStorage.setItem('playerId', newPlayer.id);
    localStorage.setItem('nickname', newPlayer.nickname);
    localStorage.setItem('player', JSON.stringify(newPlayer));

    setToken(newToken);
    setPlayer(newPlayer);
    socketService.connect();
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('playerId');
    localStorage.removeItem('nickname');
    localStorage.removeItem('player');

    setToken(null);
    setPlayer(null);
    socketService.disconnect();
  };

  const updatePlayer = (data: Partial<Player>) => {
    if (player) {
      const updated = { ...player, ...data };
      setPlayer(updated);
      localStorage.setItem('player', JSON.stringify(updated));
    }
  };

  return (
    <AuthContext.Provider
      value={{
        player,
        token,
        isLoading,
        isAuthenticated: !!player && !!token,
        login,
        register,
        logout,
        updatePlayer,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}