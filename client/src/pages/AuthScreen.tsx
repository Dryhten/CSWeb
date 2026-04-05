import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function AuthScreen() {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const { login, register } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isLogin) {
        await login(username, password);
      } else {
        await register(username, password, nickname || username);
      }
      navigate('/lobby');
    } catch (err: any) {
      setError(err.response?.data?.error || '操作失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div id="auth-screen" className="screen">
      <div className="auth-container">
        <div className="auth-tabs">
          <button
            className={`auth-tab ${isLogin ? 'active' : ''}`}
            onClick={() => setIsLogin(true)}
          >
            登录
          </button>
          <button
            className={`auth-tab ${!isLogin ? 'active' : ''}`}
            onClick={() => setIsLogin(false)}
          >
            注册
          </button>
        </div>

        <form id="login-form" className={`auth-form ${!isLogin ? 'hidden' : ''}`} onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={20}
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />
          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? '登录中...' : '登录'}
          </button>
          {error && <div className="auth-error">{error}</div>}
        </form>

        <form id="register-form" className={`auth-form ${isLogin ? 'hidden' : ''}`} onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="用户名 (3-20字符)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={20}
          />
          <input
            type="password"
            placeholder="密码 (至少6位)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />
          <input
            type="text"
            placeholder="昵称 (可选)"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? '注册中...' : '注册'}
          </button>
          {error && <div className="auth-error">{error}</div>}
        </form>

        <button className="auth-back" onClick={() => navigate('/')}>
          返回
        </button>
      </div>
    </div>
  );
}