import * as vscode from 'vscode';

let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand('copyContext.copy', async () => {
    await vscode.env.clipboard.writeText('Copy Context: hello world');
    vscode.window.showInformationMessage('\u5df2\u590d\u5236\u5360\u4f4d\u6587\u672c');
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
