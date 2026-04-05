const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Player = require('../models/Player');

// 获取个人信息
router.get('/profile', auth, async (req, res) => {
  try {
    const player = req.player;
    res.json({
      id: player._id,
      username: player.username,
      nickname: player.nickname,
      avatar: player.avatar,
      level: player.level,
      exp: player.exp,
      coins: player.coins,
      registerTime: player.registerTime,
      lastLoginTime: player.lastLoginTime,
      stats: player.stats,
      inventory: player.inventory,
      settings: player.settings
    });
  } catch (error) {
    console.error('获取个人信息错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

// 更新个人信息
router.put('/profile', auth, async (req, res) => {
  try {
    const { nickname, avatar, settings } = req.body;
    const player = req.player;
    
    if (nickname) player.nickname = nickname;
    if (avatar) player.avatar = avatar;
    if (settings) {
      player.settings = { ...player.settings.toObject(), ...settings };
    }
    
    await player.save();
    res.json({ message: '更新成功', player: player.toPublicJSON() });
  } catch (error) {
    console.error('更新个人信息错误:', error);
    res.status(500).json({ error: '更新失败' });
  }
});

// 获取战绩统计
router.get('/stats', auth, async (req, res) => {
  try {
    const player = req.player;
    res.json({
      totalKills: player.stats.totalKills,
      totalDeaths: player.stats.totalDeaths,
      totalWins: player.stats.totalWins,
      totalLosses: player.stats.totalLosses,
      totalMVP: player.stats.totalMVP,
      headshots: player.stats.headshots,
      accuracy: player.stats.accuracy,
      playTime: player.stats.playTime,
      kd: player.stats.totalDeaths > 0 
        ? (player.stats.totalKills / player.stats.totalDeaths).toFixed(2) 
        : player.stats.totalKills,
      winRate: (player.stats.totalWins + player.stats.totalLosses) > 0
        ? ((player.stats.totalWins / (player.stats.totalWins + player.stats.totalLosses)) * 100).toFixed(1)
        : 0
    });
  } catch (error) {
    console.error('获取战绩错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

// 获取背包
router.get('/inventory', auth, async (req, res) => {
  try {
    const player = req.player;
    res.json(player.inventory);
  } catch (error) {
    console.error('获取背包错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

// 添加金币
router.post('/coins', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: '无效数量' });
    }
    
    req.player.coins += amount;
    await req.player.save();
    
    res.json({ message: '添加成功', coins: req.player.coins });
  } catch (error) {
    console.error('添加金币错误:', error);
    res.status(500).json({ error: '操作失败' });
  }
});

// 更新设置
router.put('/settings', auth, async (req, res) => {
  try {
    const { sensitivity, volume, crosshairColor } = req.body;
    const player = req.player;
    
    if (sensitivity !== undefined) player.settings.sensitivity = sensitivity;
    if (volume !== undefined) player.settings.volume = volume;
    if (crosshairColor !== undefined) player.settings.crosshairColor = crosshairColor;
    
    await player.save();
    res.json({ message: '设置已更新', settings: player.settings });
  } catch (error) {
    console.error('更新设置错误:', error);
    res.status(500).json({ error: '更新失败' });
  }
});

// 玩家排行榜
router.get('/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const players = await Player.find()
      .sort({ 'stats.totalKills': -1 })
      .limit(limit)
      .select('nickname level stats.totalKills stats.totalWins stats.accuracy');
    
    res.json(players.map((p, i) => ({
      rank: i + 1,
      id: p._id,
      nickname: p.nickname,
      level: p.level,
      kills: p.stats.totalKills,
      wins: p.stats.totalWins,
      accuracy: p.stats.accuracy
    })));
  } catch (error) {
    console.error('获取排行榜错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

module.exports = router;