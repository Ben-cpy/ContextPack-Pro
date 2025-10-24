import * as path from 'path';
import * as vscode from 'vscode';
import fg from 'fast-glob';
import ignore from 'ignore';

type TreeEntry = {
  path: string;
  isDir: boolean;
};

type TreeNode = {
  name: string;
  isDir: boolean;
  children: TreeNode[];
  childMap: Map<string, TreeNode>;
};

type CollectedFile = {
  path: string;
  content: string;
  language: string;
  loc: number;
};

type CollectionResult = {
  files: CollectedFile[];
  skipped: string[];
};

type OutputSegment = {
  text: string;
  required?: boolean;
  label?: string;
};

type CopyContextResult = {
  text: string;
  truncated: boolean;
  truncatedFiles: string[];
  includedFiles: string[];
  totalFiles: number;
  skippedFiles: string[];
  maxChars: number;
};

let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand('copyContext.copy', async () => {
    try {
      const result = await buildContextMarkdown();
      await vscode.env.clipboard.writeText(result.text);

      const infoMessage = result.truncated
        ? (() => {
            const truncatedDetail =
              result.truncatedFiles.length > 0
                ? `已裁剪 ${result.truncatedFiles.length} 个文件`
                : '部分内容已裁剪';
            const limitText =
              result.maxChars > 0
                ? `内容超过阈值 ${result.maxChars} 字符，${truncatedDetail}`
                : truncatedDetail;
            return `已复制项目信息到剪贴板（${limitText}，可在设置 copyContext.maxChars 调整）`;
          })()
        : '已复制项目信息到剪贴板';
      vscode.window.showInformationMessage(infoMessage);

      if (result.skippedFiles.length > 0) {
        const previewCount = 5;
        const previewList = result.skippedFiles.slice(0, previewCount).join(', ');
        const extraCount = result.skippedFiles.length - previewCount;
        const suffix = extraCount > 0 ? ` 等（仅展示前 ${previewCount} 个）` : '';
        vscode.window.showWarningMessage(
          `Copy Context: ${result.skippedFiles.length} 个文件读取失败，已跳过：${previewList}${suffix}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Copy Context 失败: ${message}`);
    }
  });
  context.subscriptions.push(cmd);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = '$(files) Copy Context';
  statusItem.command = 'copyContext.copy';
  statusItem.tooltip = 'Copy project structure and related files to clipboard';
  statusItem.show();
  context.subscriptions.push(statusItem);
}

export function deactivate() {}

async function buildContextMarkdown(): Promise<CopyContextResult> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error('未找到正在打开的工作区');
  }

  const config = vscode.workspace.getConfiguration('copyContext');
  const treeDepth = config.get<number>('treeDepth', 3);
  const ignoreGlobs = config.get<string[]>('ignoreGlobs', []);
  const sourceStrategy = config.get<string>('sources', 'openEditors');
  const maxFiles = config.get<number>('maxFiles', 5);
  const maxCharsSetting = config.get<number>('maxChars', 40000);

  const treeText = await generateProjectTree(workspaceFolder, treeDepth, ignoreGlobs);
  const { files, skipped } = await collectRelevantFiles(workspaceFolder, sourceStrategy, maxFiles);

  const now = new Date();
  const header = `# Context — ${workspaceFolder.name} — ${formatTimestamp(now)}`;

  const structureText = treeText || '_No files found at this depth._';

  const baseLines = [
    header,
    '',
    `## Structure (depth=${treeDepth})`,
    structureText,
    '',
    `## Files (${files.length})`,
  ];

  if (files.length === 0) {
    baseLines.push('', '_No files selected._');
  }

  const segments: OutputSegment[] = [{ text: baseLines.join('\n'), required: true }];

  if (files.length > 0) {
    for (const file of files) {
      const codeFence = '```' + (file.language || '');
      const sectionLines = ['', `### ${file.path} (${file.loc} LOC)`, '', codeFence, file.content, '```'];
      segments.push({ text: sectionLines.join('\n'), label: file.path });
    }
  }

  if (skipped.length > 0) {
    const skippedLines = ['', '## Skipped Files', '', ...skipped.map((entry) => `- ${entry}`)];
    segments.push({ text: skippedLines.join('\n'), required: true });
  }

  const { text, truncated, truncatedFiles, includedFiles } = composeSegments(
    segments,
    maxCharsSetting,
  );

  return {
    text,
    truncated,
    truncatedFiles,
    includedFiles,
    totalFiles: files.length,
    skippedFiles: skipped,
    maxChars: Number.isFinite(maxCharsSetting) ? Math.floor(maxCharsSetting) : 0,
  };
}

async function generateProjectTree(
  workspaceFolder: vscode.WorkspaceFolder,
  treeDepth: number,
  ignoreGlobs: string[],
): Promise<string> {
  const rootPath = workspaceFolder.uri.fsPath;
  const ig = ignore();

  const gitignoreUri = vscode.Uri.joinPath(workspaceFolder.uri, '.gitignore');
  try {
    const file = await vscode.workspace.fs.readFile(gitignoreUri);
    const content = Buffer.from(file).toString('utf8');
    if (content.trim().length > 0) {
      ig.add(content);
    }
  } catch {
    // ignore missing .gitignore or read errors
  }

  if (ignoreGlobs.length > 0) {
    ig.add(ignoreGlobs);
  }

  const patterns = ['*', '**/*'];
  const rawEntries = await fg(patterns, {
    cwd: rootPath,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    markDirectories: true,
    unique: true,
    deep: treeDepth,
  });

  const entries: TreeEntry[] = [];
  for (const entry of rawEntries) {
    const normalized = toPosix(entry.replace(/\/$/, ''));
    if (!normalized) {
      continue;
    }
    if (ig.ignores(normalized)) {
      continue;
    }

    const isDir = entry.endsWith('/');
    entries.push({ path: normalized, isDir });
  }

  const tree = buildTree(entries, workspaceFolder.name);
  return tree;
}

async function collectRelevantFiles(
  workspaceFolder: vscode.WorkspaceFolder,
  sourceStrategy: string,
  maxFiles: number,
): Promise<CollectionResult> {
  const documents = new Map<string, vscode.TextDocument>();

  const activeEditor = vscode.window.activeTextEditor;
  if (sourceStrategy === 'activeOnly') {
    if (activeEditor) {
      documents.set(activeEditor.document.uri.toString(), activeEditor.document);
    }
  } else {
    const editors = sourceStrategy === 'openEditors' || sourceStrategy === 'smart'
      ? vscode.window.visibleTextEditors
      : [];
    for (const editor of editors) {
      documents.set(editor.document.uri.toString(), editor.document);
    }
    if (sourceStrategy === 'smart' && activeEditor) {
      documents.set(activeEditor.document.uri.toString(), activeEditor.document);
    }
  }

  if (documents.size === 0 && activeEditor) {
    documents.set(activeEditor.document.uri.toString(), activeEditor.document);
  }

  const rootPath = workspaceFolder.uri.fsPath;
  const collected: CollectedFile[] = [];
  const skipped: string[] = [];

  const docList = Array.from(documents.values());
  const normalizedLimit = Number.isFinite(maxFiles) ? Math.floor(maxFiles) : undefined;
  const limitedDocs =
    normalizedLimit === undefined
      ? docList
      : normalizedLimit <= 0
        ? []
        : docList.slice(0, normalizedLimit);

  for (const document of limitedDocs) {
    if (document.uri.scheme !== 'file') {
      continue;
    }

    const relative = toPosix(path.relative(rootPath, document.uri.fsPath));
    if (!relative || relative.startsWith('..')) {
      continue;
    }

    let content: string;
    try {
      if (document.isDirty || document.isUntitled) {
        content = document.getText();
      } else {
        const fileBuffer = await vscode.workspace.fs.readFile(document.uri);
        content = Buffer.from(fileBuffer).toString('utf8');
      }
    } catch (error) {
      const originalReason = error instanceof Error ? error.message : String(error);
      try {
        content = document.getText();
      } catch (fallbackError) {
        const fallbackReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        const combinedReason = fallbackReason
          ? `${originalReason}; ${fallbackReason}`
          : originalReason;
        skipped.push(`${relative}: ${combinedReason}`);
        continue;
      }
    }

    const loc = countLines(content);
    const language = document.languageId || guessLanguageFromPath(document.uri.fsPath);

    collected.push({
      path: relative,
      content,
      language,
      loc,
    });
  }

  return { files: collected, skipped };
}

function buildTree(entries: TreeEntry[], rootName: string): string {
  const root: TreeNode = {
    name: rootName,
    isDir: true,
    children: [],
    childMap: new Map<string, TreeNode>(),
  };

  for (const entry of entries) {
    insertPath(root, entry.path.split('/'), entry.isDir);
  }

  sortTree(root);

  const lines: string[] = [root.name];
  renderTreeChildren(root.children, '', lines);
  return lines.join('\n');
}

function insertPath(node: TreeNode, parts: string[], isDir: boolean): void {
  if (parts.length === 0) {
    return;
  }

  const [head, ...rest] = parts;
  let child = node.childMap.get(head);
  if (!child) {
    child = {
      name: head,
      isDir: rest.length > 0 || isDir,
      children: [],
      childMap: new Map<string, TreeNode>(),
    };
    node.childMap.set(head, child);
    node.children.push(child);
  } else if (rest.length === 0 && isDir) {
    child.isDir = true;
  }

  if (rest.length > 0) {
    insertPath(child, rest, isDir);
  }
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    sortTree(child);
  }
}

function renderTreeChildren(children: TreeNode[], prefix: string, lines: string[]): void {
  children.forEach((child, index) => {
    const isLast = index === children.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    lines.push(`${prefix}${branch}${child.name}`);
    const nextPrefix = prefix + (isLast ? '    ' : '│   ');
    if (child.children.length > 0) {
      renderTreeChildren(child.children, nextPrefix, lines);
    }
  });
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function formatTimestamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = `${date.getMonth() + 1}`.padStart(2, '0');
  const dd = `${date.getDate()}`.padStart(2, '0');
  const hh = `${date.getHours()}`.padStart(2, '0');
  const min = `${date.getMinutes()}`.padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

function guessLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.js':
      return 'javascript';
    case '.jsx':
      return 'jsx';
    case '.json':
      return 'json';
    case '.md':
      return 'md';
    case '.py':
      return 'python';
    case '.java':
      return 'java';
    case '.rb':
      return 'ruby';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.c':
      return 'c';
    case '.cpp':
    case '.cc':
    case '.cxx':
      return 'cpp';
    case '.cs':
      return 'csharp';
    case '.php':
      return 'php';
    case '.html':
      return 'html';
    case '.css':
      return 'css';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.xml':
      return 'xml';
    case '.sh':
      return 'bash';
    case '.bat':
      return 'bat';
    default:
      return '';
  }
}

function composeSegments(
  segments: OutputSegment[],
  maxChars: number | undefined,
): {
  text: string;
  truncated: boolean;
  truncatedFiles: string[];
  includedFiles: string[];
} {
  const normalizedLimit = Number.isFinite(maxChars) ? Math.floor(maxChars ?? 0) : NaN;
  const effectiveLimit = normalizedLimit > 0 ? normalizedLimit : undefined;

  const textParts: string[] = [];
  const includedFiles: string[] = [];
  const truncatedFiles: string[] = [];

  if (!effectiveLimit) {
    for (const segment of segments) {
      textParts.push(segment.text);
      if (!segment.required && segment.label) {
        includedFiles.push(segment.label);
      }
    }
    return {
      text: textParts.join(''),
      truncated: false,
      truncatedFiles: [],
      includedFiles,
    };
  }

  let currentLength = 0;
  let truncated = false;
  let optionalLimitReached = false;
  let breakIndex = segments.length;

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const segmentLength = segment.text.length;

    if (segment.required) {
      if (currentLength + segmentLength <= effectiveLimit) {
        textParts.push(segment.text);
        currentLength += segmentLength;
      } else {
        const remaining = effectiveLimit - currentLength;
        if (remaining > 0) {
          textParts.push(segment.text.slice(0, remaining));
          currentLength += remaining;
        }
        truncated = true;
        breakIndex = index;
        break;
      }
      continue;
    }

    if (optionalLimitReached) {
      if (segment.label) {
        truncatedFiles.push(segment.label);
      }
      truncated = true;
      continue;
    }

    if (currentLength + segmentLength <= effectiveLimit) {
      textParts.push(segment.text);
      currentLength += segmentLength;
      if (segment.label) {
        includedFiles.push(segment.label);
      }
    } else {
      optionalLimitReached = true;
      if (segment.label) {
        truncatedFiles.push(segment.label);
      }
      truncated = true;
    }
  }

  if (truncated && breakIndex < segments.length - 1) {
    for (let i = breakIndex + 1; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment.required && segment.label) {
        truncatedFiles.push(segment.label);
      }
    }
  }

  return {
    text: textParts.join(''),
    truncated,
    truncatedFiles,
    includedFiles,
  };
}
