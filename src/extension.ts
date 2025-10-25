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
  path: string;
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

type TrackedSelections = {
  files: string[];
  treeHighlights: string[];
};

let statusItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext | undefined;

type WorkspaceTrackingState = {
  history: string[];
  manualFiles: Set<string>;
  manualDirectories: Map<string, Set<string>>;
};

type ManualTrackingStorage = {
  files: string[];
  directories: Record<string, string[]>;
};

const PRIVACY_NOTICE_KEY = 'copyContext.privacyNoticeAcknowledged';
const WORKSPACE_MANUAL_TRACK_KEY_PREFIX = 'copyContext.manualSelections:';
const MAX_TRACKED_FILES_PER_DIRECTORY = 200;
const workspaceTrackers = new Map<string, WorkspaceTrackingState>();
let suppressTracking = false;

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  const cmd = vscode.commands.registerCommand('copyContext.copy', async () => {
    try {
      const result = await buildContextMarkdown();
      await vscode.env.clipboard.writeText(result.text);

      const infoMessage = result.truncated
        ? (() => {
            const truncatedDetail =
              result.truncatedFiles.length > 0
                ? `truncated ${result.truncatedFiles.length} file section(s)`
                : 'truncated part of the content';
            const limitText =
              result.maxChars > 0
                ? `content exceeded the ${result.maxChars} character limit and ${truncatedDetail}`
                : truncatedDetail;
            return `Project context copied to clipboard (${limitText}. Update copyContext.maxChars to adjust the limit).`;
          })()
        : 'Project context copied to clipboard.';
      vscode.window.showInformationMessage(infoMessage);

      if (result.skippedFiles.length > 0) {
        const previewCount = 5;
        const previewList = result.skippedFiles.slice(0, previewCount).join(', ');
        const extraCount = result.skippedFiles.length - previewCount;
        const suffix = extraCount > 0 ? ` and ${extraCount} more` : '';
        vscode.window.showWarningMessage(
          `ContextPack-Pro: Skipped ${result.skippedFiles.length} file(s) due to read errors: ${previewList}${suffix}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`ContextPack-Pro failed to copy project context: ${message}`);
    }
  });
  context.subscriptions.push(cmd);

  const toggleTrackingCmd = vscode.commands.registerCommand(
    'copyContext.toggleTracking',
    async (resource: vscode.Uri | undefined) => {
      try {
        await toggleManualTracking(resource);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`ContextPack-Pro failed to toggle tracking: ${message}`);
      }
    },
  );
  context.subscriptions.push(toggleTrackingCmd);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = '$(files) ContextPack-Pro';
  statusItem.command = 'copyContext.copy';
  statusItem.tooltip = 'Copy project structure and related files to clipboard';
  statusItem.show();
  context.subscriptions.push(statusItem);

  if (vscode.window.activeTextEditor) {
    trackDocument(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => trackDocument(document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => trackDocument(editor?.document ?? undefined)),
  );

  void showPrivacyNoticeOnce(context);
}

export function deactivate() {}

async function toggleManualTracking(resource: vscode.Uri | undefined): Promise<void> {
  const targetUri = resource ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    vscode.window.showWarningMessage('ContextPack-Pro: No file or folder selected for tracking.');
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
  if (!workspaceFolder) {
    vscode.window.showWarningMessage('ContextPack-Pro: Selected item is not within an open workspace.');
    return;
  }

  const tracker = getWorkspaceTracker(workspaceFolder);
  const relative = toPosix(path.relative(workspaceFolder.uri.fsPath, targetUri.fsPath));

  if (!relative || relative.startsWith('..')) {
    vscode.window.showWarningMessage('ContextPack-Pro: Unable to track items outside the workspace folder.');
    return;
  }

  let fileStat: vscode.FileStat | undefined;
  try {
    fileStat = await vscode.workspace.fs.stat(targetUri);
  } catch {
    fileStat = undefined;
  }

  const isDirectory = Boolean(fileStat && (fileStat.type & vscode.FileType.Directory));

  if (isDirectory) {
    if (tracker.manualDirectories.has(relative)) {
      tracker.manualDirectories.delete(relative);
      await saveManualTracking(workspaceFolder, tracker);
      vscode.window.showInformationMessage(`ContextPack-Pro: Removed folder ${relative} from tracking.`);
      return;
    }

    const collectedFiles = await collectFilesUnderDirectory(workspaceFolder, relative);
    tracker.manualDirectories.set(relative, new Set(collectedFiles));
    await saveManualTracking(workspaceFolder, tracker);
    const label = collectedFiles.length === 1 ? 'file' : 'files';
    vscode.window.showInformationMessage(
      `ContextPack-Pro: Tracking folder ${relative} (${collectedFiles.length} ${label}).`,
    );
    return;
  }

  if (tracker.manualFiles.has(relative)) {
    tracker.manualFiles.delete(relative);
    await saveManualTracking(workspaceFolder, tracker);
    vscode.window.showInformationMessage(`ContextPack-Pro: Removed ${relative} from tracking.`);
    return;
  }

  tracker.manualFiles.add(relative);
  await saveManualTracking(workspaceFolder, tracker);
  vscode.window.showInformationMessage(`ContextPack-Pro: Tracking ${relative}.`);
}

async function buildContextMarkdown(): Promise<CopyContextResult> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error('No workspace folder is open.');
  }

  const config = vscode.workspace.getConfiguration('copyContext');
  const treeDepth = config.get<number>('treeDepth', 3);
  const ignoreGlobs = config.get<string[]>('ignoreGlobs', []);
  const sourceStrategy = config.get<string>('sources', 'openEditors');
  const maxFiles = config.get<number>('maxFiles', 5);
  const maxCharsSetting = config.get<number>('maxChars', 40000);
  const structureModeSetting = config.get<string>('structureMode', 'smart');
  const structureMode = structureModeSetting === 'full' ? 'full' : 'smart';
  const trackedSelections = getTrackedSelections(
    workspaceFolder,
    vscode.window.activeTextEditor?.document,
  );

  const treeText = await generateProjectTree(
    workspaceFolder,
    treeDepth,
    ignoreGlobs,
    structureMode,
    trackedSelections.treeHighlights,
  );
  const { files, skipped } = await collectRelevantFiles(
    workspaceFolder,
    sourceStrategy,
    maxFiles,
    trackedSelections.files,
  );

  const now = new Date();
  const header = `# Context — ${workspaceFolder.name} — ${formatTimestamp(now)}`;

  const structureText = treeText || '_No files found at this depth._';

  const structureHeading =
    structureMode === 'full'
      ? `## Structure (mode=full, depth=${treeDepth})`
      : '## Structure (mode=smart, top-level overview + tracked files)';

  const baseLines = [
    header,
    '',
    structureHeading,
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
  structureMode: string,
  highlightPaths: string[],
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
  const trackedDepth = highlightPaths.reduce((max, entry) => {
    if (!entry) {
      return max;
    }
    const depth = entry.split('/').length;
    return depth > max ? depth : max;
  }, 1);
  const effectiveDepth = structureMode === 'smart' ? Math.max(treeDepth, trackedDepth) : treeDepth;

  const rawEntries = await fg(patterns, {
    cwd: rootPath,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    markDirectories: true,
    unique: true,
    deep: effectiveDepth,
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

  const expandPaths = new Set<string>();
  if (structureMode === 'smart') {
    for (const relative of highlightPaths) {
      if (!relative) {
        continue;
      }
      const parts = relative.split('/');
      for (let index = 1; index < parts.length; index++) {
        const prefix = parts.slice(0, index).join('/');
        if (prefix) {
          expandPaths.add(prefix);
        }
      }
    }
  }

  const tree = buildTree(entries, workspaceFolder.name, structureMode, expandPaths);
  return tree;
}

async function collectRelevantFiles(
  workspaceFolder: vscode.WorkspaceFolder,
  sourceStrategy: string,
  maxFiles: number,
  trackedFiles: string[],
): Promise<CollectionResult> {
  const documents = new Map<string, vscode.TextDocument>();
  const uniqueTrackedPaths = Array.from(
    new Set(trackedFiles.filter((entry): entry is string => Boolean(entry))),
  );

  const activeEditor = vscode.window.activeTextEditor;
  if (sourceStrategy === 'smart') {
    if (activeEditor) {
      documents.set(activeEditor.document.uri.toString(), activeEditor.document);
    }
  } else if (sourceStrategy === 'activeOnly') {
    if (activeEditor) {
      documents.set(activeEditor.document.uri.toString(), activeEditor.document);
    }
  } else {
    const editors = sourceStrategy === 'openEditors'
      ? vscode.window.visibleTextEditors
      : [];
    for (const editor of editors) {
      documents.set(editor.document.uri.toString(), editor.document);
    }
  }

  if (documents.size === 0 && activeEditor) {
    documents.set(activeEditor.document.uri.toString(), activeEditor.document);
  }

  const rootPath = workspaceFolder.uri.fsPath;
  const collected: CollectedFile[] = [];
  const skipped: string[] = [];

  if (sourceStrategy === 'smart') {
    for (const relative of uniqueTrackedPaths) {
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, relative);
      const key = uri.toString();
      if (documents.has(key)) {
        continue;
      }
      try {
        suppressTracking = true;
        const document = await vscode.workspace.openTextDocument(uri);
        documents.set(key, document);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push(`${relative}: ${reason}`);
      } finally {
        suppressTracking = false;
      }
    }
  }

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

function trackDocument(document: vscode.TextDocument | undefined): void {
  if (suppressTracking) {
    return;
  }
  if (!document || document.uri.scheme !== 'file') {
    return;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return;
  }
  const relative = toPosix(path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath));
  if (!relative || relative.startsWith('..')) {
    return;
  }
  const tracker = getWorkspaceTracker(workspaceFolder);
  tracker.history.push(relative);
  if (tracker.history.length > 10) {
    tracker.history.shift();
  }
}

function getTrackedSelections(
  workspaceFolder: vscode.WorkspaceFolder,
  activeDocument: vscode.TextDocument | undefined,
): TrackedSelections {
  const tracker = getWorkspaceTracker(workspaceFolder);
  const history = tracker.history;
  const counts = new Map<string, { count: number; lastIndex: number }>();

  history.forEach((entry, index) => {
    const existing = counts.get(entry);
    if (existing) {
      existing.count += 1;
      existing.lastIndex = index;
    } else {
      counts.set(entry, { count: 1, lastIndex: index });
    }
  });

  const sortedByFrequency = Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1].count !== a[1].count) {
        return b[1].count - a[1].count;
      }
      return b[1].lastIndex - a[1].lastIndex;
    })
    .map(([filePath]) => filePath);

  const files: string[] = [];
  const treeHighlights = new Set<string>();
  const seen = new Set<string>();

  const addFile = (entry: string | undefined) => {
    if (!entry || entry.startsWith('..') || entry === '' || seen.has(entry)) {
      return;
    }
    seen.add(entry);
    files.push(entry);
  };

  const manualFileEntries = Array.from(tracker.manualFiles);
  for (const file of manualFileEntries) {
    treeHighlights.add(file);
    addFile(file);
  }

  for (const [dir, trackedFiles] of tracker.manualDirectories.entries()) {
    treeHighlights.add(dir);
    for (const file of trackedFiles) {
      treeHighlights.add(file);
      addFile(file);
    }
  }

  const activePath =
    activeDocument && activeDocument.uri.scheme === 'file'
      ? toPosix(path.relative(workspaceFolder.uri.fsPath, activeDocument.uri.fsPath))
      : undefined;

  if (activePath && !activePath.startsWith('..') && activePath !== '') {
    treeHighlights.add(activePath);
    addFile(activePath);
  }

  for (const candidate of sortedByFrequency) {
    if (files.length >= 3) {
      break;
    }
    if (!candidate || candidate === activePath) {
      continue;
    }
    treeHighlights.add(candidate);
    addFile(candidate);
  }

  if (files.length < 3) {
    for (let index = history.length - 1; index >= 0 && files.length < 3; index--) {
      const candidate = history[index];
      if (!candidate || candidate === activePath) {
        continue;
      }
      treeHighlights.add(candidate);
      addFile(candidate);
    }
  }

  return { files, treeHighlights: Array.from(treeHighlights) };
}

function getWorkspaceTracker(workspaceFolder: vscode.WorkspaceFolder): WorkspaceTrackingState {
  let tracker = workspaceTrackers.get(workspaceFolder.uri.toString());
  if (!tracker) {
    const manual = loadManualTracking(workspaceFolder);
    tracker = {
      history: [],
      manualFiles: new Set(manual.files),
      manualDirectories: new Map(
        Object.entries(manual.directories).map(([dir, files]) => [dir, new Set(files)]),
      ),
    };
    workspaceTrackers.set(workspaceFolder.uri.toString(), tracker);
  }
  return tracker;
}

function getManualTrackingKey(workspaceFolder: vscode.WorkspaceFolder): string {
  return `${WORKSPACE_MANUAL_TRACK_KEY_PREFIX}${workspaceFolder.uri.toString()}`;
}

function loadManualTracking(workspaceFolder: vscode.WorkspaceFolder): ManualTrackingStorage {
  if (!extensionContext) {
    return { files: [], directories: {} };
  }
  const stored = extensionContext.workspaceState.get<ManualTrackingStorage>(
    getManualTrackingKey(workspaceFolder),
    { files: [], directories: {} },
  );
  if (!stored) {
    return { files: [], directories: {} };
  }

  const files = Array.isArray(stored.files)
    ? Array.from(new Set(stored.files.map((entry) => toPosix(entry)).filter((entry) => !!entry)))
    : [];
  const directories: Record<string, string[]> = {};
  if (stored.directories && typeof stored.directories === 'object') {
    for (const [dir, entries] of Object.entries(stored.directories)) {
      if (Array.isArray(entries)) {
        const normalizedDir = toPosix(dir);
        if (!normalizedDir) {
          continue;
        }
        const normalizedEntries = Array.from(
          new Set(entries.map((entry) => toPosix(entry)).filter((entry) => !!entry)),
        );
        directories[normalizedDir] = normalizedEntries;
      }
    }
  }

  return { files, directories };
}

async function saveManualTracking(
  workspaceFolder: vscode.WorkspaceFolder,
  tracker: WorkspaceTrackingState,
): Promise<void> {
  if (!extensionContext) {
    return;
  }
  const serialized: ManualTrackingStorage = {
    files: Array.from(tracker.manualFiles),
    directories: Object.fromEntries(
      Array.from(tracker.manualDirectories.entries()).map(([dir, files]) => [dir, Array.from(files)]),
    ),
  };
  await extensionContext.workspaceState.update(getManualTrackingKey(workspaceFolder), serialized);
}

async function collectFilesUnderDirectory(
  workspaceFolder: vscode.WorkspaceFolder,
  relativeDir: string,
): Promise<string[]> {
  const absolute = path.join(workspaceFolder.uri.fsPath, relativeDir);
  try {
    const entries = await fg(['**/*'], {
      cwd: absolute,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
    });
    return entries
      .slice(0, MAX_TRACKED_FILES_PER_DIRECTORY)
      .map((entry) => toPosix(path.join(relativeDir, entry)));
  } catch {
    return [];
  }
}

async function showPrivacyNoticeOnce(context: vscode.ExtensionContext): Promise<void> {
  const alreadyAcknowledged = context.globalState.get<boolean>(PRIVACY_NOTICE_KEY, false);
  if (alreadyAcknowledged) {
    return;
  }
  const message =
    'ContextPack-Pro copies project information to your clipboard. The clipboard may include sensitive data—please review before sharing it with third-party services.';
  await vscode.window.showInformationMessage(message);
  await context.globalState.update(PRIVACY_NOTICE_KEY, true);
}

function buildTree(
  entries: TreeEntry[],
  rootName: string,
  structureMode: string,
  expandPaths: Set<string>,
): string {
  const root: TreeNode = {
    name: rootName,
    isDir: true,
    children: [],
    childMap: new Map<string, TreeNode>(),
    path: '',
  };

  for (const entry of entries) {
    insertPath(root, entry.path.split('/'), entry.isDir);
  }

  sortTree(root);

  const lines: string[] = [root.name];
  renderTreeChildren(root.children, '', lines, structureMode, expandPaths);
  return lines.join('\n');
}

function insertPath(node: TreeNode, parts: string[], isDir: boolean): void {
  if (parts.length === 0) {
    return;
  }

  const [head, ...rest] = parts;
  let child = node.childMap.get(head);
  if (!child) {
    const childPath = node.path ? `${node.path}/${head}` : head;
    child = {
      name: head,
      isDir: rest.length > 0 || isDir,
      children: [],
      childMap: new Map<string, TreeNode>(),
      path: childPath,
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

function renderTreeChildren(
  children: TreeNode[],
  prefix: string,
  lines: string[],
  mode: string,
  expandPaths: Set<string>,
): void {
  children.forEach((child, index) => {
    const isLast = index === children.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    lines.push(`${prefix}${branch}${child.name}`);
    const nextPrefix = prefix + (isLast ? '    ' : '│   ');
    const shouldExpand =
      child.children.length > 0 &&
      (mode === 'full' || (child.isDir && expandPaths.has(child.path)));
    if (shouldExpand) {
      renderTreeChildren(child.children, nextPrefix, lines, mode, expandPaths);
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
