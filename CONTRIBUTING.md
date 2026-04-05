# Contribution Guide

## 如何贡献

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 游戏客户端（Three.js）

- 主入口：`client/game.html`，逻辑在 `client/src/game/entry.ts`（Vite 打包，`three@0.128` 与原先 CDN 版本一致）。
- 开发：`npm run dev -w @client/fire-assault`，对战内 iframe 加载 `/game.html`。
- 静态资源：`client/public/`（如 `assets/models/`）构建后仍在站点根路径。
- 仓库根目录的 `index.html` 为旧版单文件，新功能请改 `client/` 下代码。

## 开发规范

### 代码风格
- 使用 TypeScript 进行类型检查
- 遵循 ESLint 规则
- 使用有意义的变量/函数命名

### 提交信息格式
```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

类型 (type):
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具

## 问题反馈

请使用 GitHub Issues 报告问题。