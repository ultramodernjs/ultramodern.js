# Modern.js Skills（用户向）

本目录存放 Modern.js 官方面向**用户**的 **Agent Skills**：给 AI Agent（Claude Code / Codex / Cursor 等）读取的可触发工作流，核心是 `SKILL.md`，可附带 `scripts/`、`references/`。遵循 [Agent Skills 开放标准](https://github.com/vercel-labs/skills)。

## 已落地

- `modernjs-feature-enable` —— 为 v3 应用启用 BFF / SSG / styled-components / Tailwind / 自定义 Web Server

## UltraModern 工作区

UltraModern 的创建、添加 vertical/shell、Effect API、TanStack 路由与发布更新
使用现有框架命令，见 [native workflows](../docs/ultramodern-native-workflows.md)。
`modernjs-feature-enable` 会先区分 UltraModern 工作区与普通 Modern.js 应用，避免误跑
函数式 BFF 启用。

## 安装

仓库根 `skills/` 就是标准 `skills` CLI 默认发现的位置，直接从 GitHub 安装：

```bash
# 列出可安装的 Skills
npx skills add web-infra-dev/modern.js --list

# 安装单个 Skill（--agent 可选 claude-code / codex / cursor）
```

锁版本：在仓库后加 `#<tag>`（含本 Skill 的发布 tag / 分支 / commit），如

> 参与 Modern.js 框架开发时使用的 Skills（如依赖检查），见 [`.agents/skills/`](../.agents/skills/README.md)。
