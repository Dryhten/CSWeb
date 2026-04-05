/**
 * 将 Vite 产出的 game.html 与 game-*.js 同步到 public/，供 iframe 静态路径 /game.html 使用。
 * 避免 public 里残留旧 hash（如 game-BNZteO0j.js）导致线上仍跑旧逻辑。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const pub = path.join(root, 'public');
const distGameHtml = path.join(dist, 'game.html');
const pubGameHtml = path.join(pub, 'game.html');

if(!fs.existsSync(distGameHtml)) {
  console.warn('[sync-game-public] dist/game.html 不存在，跳过');
  process.exit(0);
}

fs.copyFileSync(distGameHtml, pubGameHtml);

const distAssets = path.join(dist, 'assets');
const pubAssets = path.join(pub, 'assets');
const html = fs.readFileSync(distGameHtml, 'utf8');
const m = html.match(/\/assets\/(game-[A-Za-z0-9_-]+\.js)/);
const gameJs = m ? m[1] : null;

if(gameJs && fs.existsSync(path.join(distAssets, gameJs))) {
  fs.copyFileSync(path.join(distAssets, gameJs), path.join(pubAssets, gameJs));
  for(const f of fs.readdirSync(pubAssets)) {
    if(/^game-.*\.js$/.test(f) && f !== gameJs) {
      fs.unlinkSync(path.join(pubAssets, f));
      console.log('[sync-game-public] 已删除旧包:', f);
    }
  }
  for(const f of fs.readdirSync(distAssets)) {
    if(/^game-.*\.js$/.test(f) && f !== gameJs) {
      fs.unlinkSync(path.join(distAssets, f));
      console.log('[sync-game-public] 已清理 dist 旧包:', f);
    }
  }
  console.log('[sync-game-public] 已同步', gameJs);
} else {
  console.warn('[sync-game-public] 无法从 dist/game.html 解析 game-*.js');
}
