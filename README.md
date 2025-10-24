# ContextPack-Pro

ContextPack-Pro is a VS Code extension that copies a concise yet informative snapshot of your project—structure and key files—straight to the clipboard.

## Features

- 🧭 **Minimal UI:** A single status bar button triggers the clipboard action, and the same command is available as `Copy Project Context` from the Command Palette.
- 📋 **Rich clipboard payload:** Captures a Markdown document containing the project tree and the most relevant file contents.
- 🧠 **Smart relevance tracking:** Prioritises the active editor plus the most frequently opened files from your recent work.
- 🌲 **Configurable structure views:** Choose between a full directory listing or a smart mode that expands only the tracked files within the top-level tree.
- 🔒 **Privacy reminder:** On first use, ContextPack-Pro gently reminds you that clipboard contents might include sensitive information.

## Installation & Build

1. Install dependencies: `npm install`
2. Build the extension: `npm run build`
3. (Optional) Watch for changes during development: `npm run watch`
4. Launch an Extension Development Host from VS Code to try it out.

To create a VSIX package for distribution, install `vsce` globally (`npm i -g @vscode/vsce`) and run `vsce package`.

## Usage

1. Click the `ContextPack-Pro` status bar item or run **Copy Project Context** from the Command Palette.
2. The extension gathers the project structure, tracks your most relevant files, and copies the resulting Markdown to the clipboard.
3. Paste the Markdown into an issue, document, or prompt as needed.

All runtime notifications are in English. The initial privacy warning appears only once per user unless you reset VS Code's global state.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `copyContext.sources` | `openEditors` | Strategy for selecting which documents to include (`openEditors`, `activeOnly`, or `smart`). |
| `copyContext.maxFiles` | `5` | Maximum number of files whose contents are added to the clipboard. |
| `copyContext.treeDepth` | `3` | Maximum directory depth when rendering the project tree in **full** mode. |
| `copyContext.ignoreGlobs` | `['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**']` | Extra glob patterns to ignore during workspace scans. |
| `copyContext.maxChars` | `40000` | Character limit for the clipboard payload; optional sections are truncated if the limit is exceeded. |
| `copyContext.structureMode` | `smart` | Select `full` for the entire tree or `smart` to expand only the tracked files while keeping the top-level overview. |

## Privacy & Limitations

- Clipboard payloads may include proprietary or sensitive information—review before sharing externally.
- Binary files and files blocked by ignore rules are skipped automatically.
- Extremely large repositories may require adjusting `copyContext.maxChars` or `copyContext.maxFiles`.

## Roadmap Highlights

- Change detection for diffs (`git diff` integration).
- Improved relevance heuristics and chunked outputs for long files.
- Intelligent grouping for multi-root workspaces.
