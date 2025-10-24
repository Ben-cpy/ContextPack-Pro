# ContextPack-Pro

Stop wasting time copying and pasting code snippets. One click gets your entire project context—structure, files, and all—ready to paste into any AI chat.

## Why?

LLMs work better with more upfront context. Instead of explaining your codebase piece by piece, just give it everything it needs in one shot. Saves time, saves tokens, saves headaches.

## Who's it for?

- You're tired of manually copying code into ChatGPT/Claude
- You use VS Code AI chat and want clean, relevant context
- You need to share project snapshots quickly


## How to use

1. Click the `ContextPack-Pro` button in the bottom left status bar (or use Command Palette → **Copy Project Context**)
2. Everything gets copied to your clipboard as nice, formatted Markdown
3. Paste wherever you need it—AI chat, docs, issues, whatever


## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `copyContext.sources` | `openEditors` | Strategy for selecting which documents to include (`openEditors`, `activeOnly`, or `smart`). |
| `copyContext.maxFiles` | `5` | Maximum number of files whose contents are added to the clipboard. |
| `copyContext.treeDepth` | `3` | Maximum directory depth when rendering the project tree in **full** mode. |
| `copyContext.ignoreGlobs` | `['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**']` | Extra glob patterns to ignore during workspace scans. |
| `copyContext.maxChars` | `40000` | Character limit for the clipboard payload; optional sections are truncated if the limit is exceeded. |
| `copyContext.structureMode` | `smart` | Select `full` for the entire tree or `smart` to expand only the tracked files while keeping the top-level overview. |

## Heads up

- Check what you're copying before pasting it publicly—could have sensitive stuff
- Binary files and ignored folders get skipped automatically
- Huge repos? Tweak `maxChars` or `maxFiles` in settings

## Coming soon

- `git diff` support to show what changed
- Smarter file selection and chunking for long files
- Better handling of multi-root workspaces
