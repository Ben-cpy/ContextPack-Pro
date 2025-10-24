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

let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand('copyContext.copy', async () => {
    try {
      const markdown = await buildContextMarkdown();
      await vscode.env.clipboard.writeText(markdown);
      vscode.window.showInformationMessage('已复制项目信息到剪贴板');
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

async function buildContextMarkdown(): Promise<string> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error('未找到正在打开的工作区');
  }

  const config = vscode.workspace.getConfiguration('copyContext');
  const treeDepth = config.get<number>('treeDepth', 3);
  const ignoreGlobs = config.get<string[]>('ignoreGlobs', []);
  const sourceStrategy = config.get<string>('sources', 'openEditors');
  const maxFiles = config.get<number>('maxFiles', 5);

  const treeText = await generateProjectTree(workspaceFolder, treeDepth, ignoreGlobs);
  const files = await collectRelevantFiles(workspaceFolder, sourceStrategy, maxFiles);

  const now = new Date();
  const header = `# Context — ${workspaceFolder.name} — ${formatTimestamp(now)}`;

  const lines: string[] = [header, '', `## Structure (depth=${treeDepth})`, treeText || '_No files found at this depth._', ''];

  lines.push(`## Files (${files.length})`);
  if (files.length === 0) {
    lines.push('', '_No files selected._');
  } else {
    for (const file of files) {
      lines.push('', `### ${file.path} (${file.loc} LOC)`, '', '```' + file.language);
      lines.push(file.content);
      lines.push('```');
    }
  }

  return lines.join('\n');
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
): Promise<CollectedFile[]> {
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

  for (const document of Array.from(documents.values()).slice(0, Math.max(maxFiles, 0))) {
    if (document.uri.scheme !== 'file') {
      continue;
    }

    const relative = toPosix(path.relative(rootPath, document.uri.fsPath));
    if (!relative || relative.startsWith('..')) {
      continue;
    }

    const fileBuffer = await vscode.workspace.fs.readFile(document.uri);
    const content = Buffer.from(fileBuffer).toString('utf8');
    const loc = countLines(content);
    const language = document.languageId || guessLanguageFromPath(document.uri.fsPath);

    collected.push({
      path: relative,
      content,
      language,
      loc,
    });
  }

  return collected;
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
