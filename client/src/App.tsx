import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import MainMenu from './pages/MainMenu';
import AuthScreen from './pages/AuthScreen';
import Lobby from './pages/Lobby';
import Room from './pages/Room';
import Game from './pages/Game';

function App() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#0a0a0f',
        color: '#FF6A00',
        fontFamily: 'Orbitron, sans-serif'
      }}>
        Loading...
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<MainMenu />} />
      <Route path="/auth" element={isAuthenticated ? <Navigate to="/lobby" /> : <AuthScreen />} />
      <Route path="/lobby" element={isAuthenticated ? <Lobby /> : <Navigate to="/auth" />} />
      <Route path="/room/:roomId" element={isAuthenticated ? <Room /> : <Navigate to="/auth" />} />
      <Route path="/game" element={isAuthenticated ? <Game /> : <Navigate to="/auth" />} />
    </Routes>
  );
}

export default App;