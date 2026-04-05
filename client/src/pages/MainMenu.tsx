import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function MainMenu() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const handlePlay = () => {
    if (isAuthenticated) {
      navigate('/lobby');
    } else {
      navigate('/auth');
    }
  };

  return (
    <div id="main-menu" className="screen">
      <div id="menu-bg-effects">
        <div className="menu-line" style={{ left: '20%', animationDelay: '0s' }}></div>
        <div className="menu-line" style={{ left: '50%', animationDelay: '2s' }}></div>
        <div className="menu-line" style={{ left: '80%', animationDelay: '4s' }}></div>
      </div>
      <div id="menu-corner-tl" className="menu-corner"></div>
      <div id="menu-corner-tr" className="menu-corner"></div>
      <div id="menu-corner-bl" className="menu-corner"></div>
      <div id="menu-corner-br" className="menu-corner"></div>

      <div id="menu-content">
        <div id="game-logo">烈火突击</div>
        <div id="game-subtitle">CROSSFIRE ASSAULT</div>
        <button className="menu-btn primary" onClick={handlePlay}>
          开始战斗
        </button>
        <button className="menu-btn" onClick={() => alert('操作说明\nWASD移动 | 鼠标射击 | R换弹 | 空格跳 | 1/2/3切枪 | Shift静步 | Ctrl下蹲')}>
          操作说明
        </button>
      </div>

      <div id="menu-footer">TACTICAL COMBAT SIMULATOR v2.1</div>
    </div>
  );
}