const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const GameConfig = require('../models/GameConfig');

// 获取游戏配置
router.get('/', async (req, res) => {
  try {
    const config = await GameConfig.findOne({ isActive: true });
    if (!config) {
      return res.status(404).json({ error: '未找到游戏配置' });
    }
    
    res.json({
      character: config.character,
      gameModes: config.gameModes,
      maps: config.maps
    });
  } catch (error) {
    console.error('获取配置错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

// 获取武器列表
router.get('/weapons', async (req, res) => {
  try {
    const config = await GameConfig.findOne({ isActive: true });
    if (!config) {
      return res.status(404).json({ error: '未找到游戏配置' });
    }
    
    res.json(config.weapons);
  } catch (error) {
    console.error('获取武器列表错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

// 获取单个武器配置
router.get('/weapons/:id', async (req, res) => {
  try {
    const config = await GameConfig.findOne({ isActive: true });
    if (!config) {
      return res.status(404).json({ error: '未找到游戏配置' });
    }
    
    const weapon = config.weapons.find(w => w.id === req.params.id);
    if (!weapon) {
      return res.status(404).json({ error: '武器不存在' });
    }
    
    res.json(weapon);
  } catch (error) {
    console.error('获取武器错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

// 更新武器配置 (管理员)
router.put('/weapons/:id', auth, async (req, res) => {
  try {
    // 检查是否是管理员 (简化版: 直接通过)
    const config = await GameConfig.findOne({ isActive: true });
    if (!config) {
      return res.status(404).json({ error: '未找到游戏配置' });
    }
    
    const weaponIndex = config.weapons.findIndex(w => w.id === req.params.id);
    if (weaponIndex === -1) {
      return res.status(404).json({ error: '武器不存在' });
    }
    
    config.weapons[weaponIndex] = { 
      ...config.weapons[weaponIndex].toObject(),
      ...req.body
    };
    
    await config.save();
    res.json({ message: '武器配置已更新', weapon: config.weapons[weaponIndex] });
  } catch (error) {
    console.error('更新武器配置错误:', error);
    res.status(500).json({ error: '更新失败' });
  }
});

// 更新角色配置 (管理员)
router.put('/character', auth, async (req, res) => {
  try {
    const config = await GameConfig.findOne({ isActive: true });
    if (!config) {
      return res.status(404).json({ error: '未找到游戏配置' });
    }
    
    config.character = { ...config.character.toObject(), ...req.body };
    await config.save();
    
    res.json({ message: '角色配置已更新', character: config.character });
  } catch (error) {
    console.error('更新角色配置错误:', error);
    res.status(500).json({ error: '更新失败' });
  }
});

// 获取所有配置 (管理员)
router.get('/all', auth, async (req, res) => {
  try {
    const config = await GameConfig.findOne({ isActive: true });
    if (!config) {
      return res.status(404).json({ error: '未找到游戏配置' });
    }
    
    res.json(config);
  } catch (error) {
    console.error('获取所有配置错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

// 获取地图列表
router.get('/maps', async (req, res) => {
  try {
    const config = await GameConfig.findOne({ isActive: true });
    if (!config) {
      return res.status(404).json({ error: '未找到游戏配置' });
    }
    
    res.json(config.maps);
  } catch (error) {
    console.error('获取地图列表错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

// 获取游戏模式
router.get('/modes', async (req, res) => {
  try {
    const config = await GameConfig.findOne({ isActive: true });
    if (!config) {
      return res.status(404).json({ error: '未找到游戏配置' });
    }
    
    res.json(config.gameModes);
  } catch (error) {
    console.error('获取游戏模式错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

module.exports = router;