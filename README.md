# Copy Context

Day 1 delivers a runnable VS Code extension skeleton with a status bar entry point for the upcoming context capture workflow.

## Features
- Adds a `Copy Context` status bar button (`$(clippy)` icon) that triggers the `copyContext.copy` command.
- Copies a placeholder Markdown snippet to the clipboard and confirms the action with a notification (`已复制占位文本`).

## Getting Started
- Run `npm install` to install dependencies.
- Run `npm run compile` to bundle the extension once with esbuild into `out/extension.js`.
- Run `npm run watch` to rebuild on file changes while developing.
- Use VS Code's `Run > Start Debugging` (Extension Development Host) after building to try the command and status bar button.

## Configuration Preview
- `copyContext.sources`: choose how related files are gathered (`openEditors`, `activeOnly`, `smart`).
- `copyContext.maxFiles`: limit the number of file contents included.
- `copyContext.treeDepth`: cap the directory tree depth when listing files.
- `copyContext.ignoreGlobs`: extend ignore rules beyond `.gitignore`.
- `copyContext.maxChars`: plan for future chunking of clipboard output.

## Next Steps
- Replace the placeholder clipboard payload with real project context data.
- Implement the configuration-driven strategies and ignore handling.
