# claude-multi-proxy

[![NPM](https://nodei.co/npm/claude-multi-proxy.svg)](https://nodei.co/npm/claude-multi-proxy/)

Use Claude Code with multiple AI providers. Switch between Claude (Anthropic) and Codex (OpenAI) models using `/model`.

> Forked from [pinion05/codex-claudecode-proxy](https://github.com/pinion05/codex-claudecode-proxy)

## How it works

```
Claude Code ──→ Local Proxy (CLIProxyAPI) ──→ Anthropic API (Claude OAuth)
                      ↓
                      └──→ Codex API (OpenAI OAuth)
```

Both providers use **OAuth authentication** — no API keys needed. Just log in with your existing subscriptions.

## Quick Start

```bash
npx -y claude-multi-proxy
```

This will:
1. Download and install CLIProxyAPI
2. Prompt OAuth login for Claude and Codex
3. Configure Claude Code to route through the proxy
4. Set up a LaunchAgent for auto-start

## Model Switching

After installation, use `/model` in Claude Code:

| Command | Model | Provider |
|---------|-------|----------|
| `/model opus` | Claude Opus | Anthropic |
| `/model sonnet` | Claude Sonnet | Anthropic |
| `/model haiku` | Claude Haiku | Anthropic |
| **`/model codex`** | **GPT-5.3 Codex** | **OpenAI** |

## Commands

```bash
# Install (safe to re-run)
npx -y claude-multi-proxy

# OAuth login (individual)
npx -y claude-multi-proxy claude-login
npx -y claude-multi-proxy codex-login

# Status
npx -y claude-multi-proxy status

# Start/stop
npx -y claude-multi-proxy start
npx -y claude-multi-proxy stop

# Uninstall: stop proxy and restore Claude Code settings
npx -y claude-multi-proxy uninstall

# Purge: uninstall + remove all proxy files
npx -y claude-multi-proxy purge
```

## Requirements

- macOS (LaunchAgent-based)
- Node.js >= 18
- Claude Code installed
- Anthropic account (Claude subscription)
- OpenAI account (for Codex)

## Differences from upstream

| Feature | [codex-claudecode-proxy](https://github.com/pinion05/codex-claudecode-proxy) | claude-multi-proxy |
|---------|----------------------------------------------|-------------------|
| Target user | No Claude subscription | Both subscriptions |
| Providers | Codex only | Claude + Codex |
| Model slots | All overridden to Codex | Original Claude models preserved |
| Codex access | Replaces Sonnet/Opus/Haiku | Separate `/model codex` |
| Auth method | Codex CLI token sync | CLIProxyAPI native OAuth |
| LaunchAgents | 2 (proxy + token sync) | 1 (proxy only) |

## Safety

- Claude Code settings are backed up before any changes
- `uninstall` restores original Claude Code settings
- Proxy binds to `127.0.0.1` only (localhost)

## License

MIT
