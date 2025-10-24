import * as vscode from "vscode";

/**
 * Extension activation entry point.
 */
export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "vscode-copy-context.helloWorld",
    () => {
      vscode.window.showInformationMessage("Hello from vscode-copy-context!");
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {
  // Intentionally left empty; add cleanup logic here if needed.
}
