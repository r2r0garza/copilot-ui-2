import * as vscode from "vscode";

export class WorkbenchSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "deepagentsSpike.launcher";

  constructor(private readonly openWorkbench: () => Promise<void>) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = renderSidebar(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "openWorkbench"
      ) {
        void this.openWorkbench();
      }
    });
  }
}

function renderSidebar(webview: vscode.Webview): string {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Agent Workbench</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }
    .eyebrow {
      margin-top: 14px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    h1 {
      margin: 8px 0 10px;
      font-size: 24px;
      line-height: 1.15;
      letter-spacing: -.02em;
    }
    p {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }
    button {
      width: 100%;
      margin-top: 24px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border: 1px solid var(--vscode-button-border, transparent);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .arrow { font-size: 20px; line-height: 1; }
    .status {
      margin-top: 22px;
      padding-top: 16px;
      display: flex;
      gap: 9px;
      align-items: center;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed);
    }
  </style>
</head>
<body>
  <div class="eyebrow">Deep Agents</div>
  <h1>Agent Workbench</h1>
  <p>Open the full editor to work with workspace-scoped agents.</p>
  <button id="open" type="button">
    <span>Open Workbench</span>
    <span class="arrow">→</span>
  </button>
  <div class="status"><span class="dot"></span><span>Local workspace · Copilot models</span></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("open").addEventListener("click", () => {
      vscode.postMessage({ type: "openWorkbench" });
    });
  </script>
</body>
</html>`;
}
