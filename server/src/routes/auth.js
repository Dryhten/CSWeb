const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Player = require('../models/Player');

// 注册
router.post('/register', async (req, res) => {
  try {
    const { username, password, nickname } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: '用户名长度需在3-20个字符之间' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少6个字符' });
    }
    
    const existingPlayer = await Player.findOne({ username });
    if (existingPlayer) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    
    const player = new Player({
      username,
      password,
      nickname: nickname || username,
      inventory: {
        weapons: ['AK-47', 'USP-S', 'AWP'],
        currentWeapon: 'AK-47'
      }
    });
    
    await player.save();
    
    const token = jwt.sign(
      { playerId: player._id },
      process.env.JWT_SECRET || 'default-secret',
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );
    
    res.status(201).json({
      message: '注册成功',
      token,
      player: {
        id: player._id,
        username: player.username,
        nickname: player.nickname,
        level: player.level,
        coins: player.coins
      }
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

// 登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    const player = await Player.findOne({ username });
    if (!player) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    const isMatch = await player.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    player.lastLoginTime = new Date();
    await player.save();
    
    const token = jwt.sign(
      { playerId: player._id },
      process.env.JWT_SECRET || 'default-secret',
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );
    
    res.json({
      message: '登录成功',
      token,
      player: {
        id: player._id,
        username: player.username,
        nickname: player.nickname,
        avatar: player.avatar,
        level: player.level,
        coins: player.coins,
        settings: player.settings
      }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

// 验证token
router.get('/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ valid: false });
    }
    
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-secret');
    const player = await Player.findById(decoded.playerId);
    
    if (!player) {
      return res.status(401).json({ valid: false });
    }
    
    res.json({
      valid: true,
      player: {
        id: player._id,
        username: player.username,
        nickname: player.nickname,
        avatar: player.avatar,
        level: player.level,
        coins: player.coins
      }
    });
  } catch (error) {
    res.status(401).json({ valid: false });
  }
});

module.exports = router;