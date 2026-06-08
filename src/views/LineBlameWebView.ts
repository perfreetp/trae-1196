import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../services/GitService';
import { StateService } from '../services/StateService';
import { ReportService } from '../services/ReportService';
import { BlameLine } from '../models/types';

export class LineBlameWebView {
  public static readonly viewType = 'gitArchaeologist.lineBlame';
  private currentFile?: string;
  private blameLines: BlameLine[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService,
    private stateService: StateService,
    private reportService: ReportService,
    private workspaceRoot: string
  ) {
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor && editor.document && !editor.document.isUntitled) {
        this.currentFile = path.relative(workspaceRoot, editor.document.fileName);
      }
    });

    if (vscode.window.activeTextEditor?.document && !vscode.window.activeTextEditor.document.isUntitled) {
      this.currentFile = path.relative(workspaceRoot, vscode.window.activeTextEditor.document.fileName);
    }
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getInitialHtml();

    webviewView.onDidChangeVisibility(async () => {
      if (webviewView.visible) {
        await this.refreshView(webviewView);
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'selectFile':
          this.currentFile = msg.filePath;
          await this.refreshView(webviewView);
          break;
        case 'loadBlame':
          this.currentFile = msg.filePath;
          await this.refreshView(webviewView);
          break;
        case 'openCommit':
          await vscode.commands.executeCommand('gitArchaeologist.openCommit', msg.commitHash);
          break;
        case 'copyLocationLink':
          const link = this.reportService.generateLocationLink(
            this.workspaceRoot, msg.commitHash, this.currentFile, msg.lineNumber
          );
          await vscode.env.clipboard.writeText(link);
          vscode.window.showInformationMessage('定位链接已复制到剪贴板');
          break;
        case 'showDiff':
          await this.showDiff(msg.commitHash, webviewView);
          break;
        case 'goToLine':
          await this.goToLine(msg.lineNumber);
          break;
        case 'addNote':
          await vscode.commands.executeCommand('gitArchaeologist.addCommitNote', msg.commitHash);
          break;
        case 'toggleFavorite':
          await vscode.commands.executeCommand('gitArchaeologist.favoriteCommit', msg.commitHash);
          await this.refreshView(webviewView);
          break;
      }
    });

    await this.refreshView(webviewView);
  }

  async setAndLoadFile(filePath: string): Promise<void> {
    this.currentFile = filePath;
    const view = await this.ensureViewVisible();
    if (view) {
      await this.refreshView(view);
    }
  }

  private async ensureViewVisible(): Promise<vscode.WebviewView | undefined> {
    return new Promise(async (resolve) => {
      await vscode.commands.executeCommand('gitArchaeologist.lineBlame.focus');
      setTimeout(() => {
        const disposable = vscode.window.registerWebviewViewProvider(
          LineBlameWebView.viewType,
          {
            resolveWebviewView: (view) => {
              disposable.dispose();
              resolve(view);
            }
          } as vscode.WebviewViewProvider
        );
      }, 300);
    });
  }

  private async refreshView(webviewView: vscode.WebviewView): Promise<void> {
    try {
      let filePath = this.currentFile;
      if (!filePath) {
        webviewView.webview.html = this.getNoFileHtml();
        return;
      }

      webviewView.webview.html = this.getLoadingHtml();

      this.blameLines = await this.gitService.getBlame(filePath);
      const fileHistory = await this.gitService.getFileHistory(filePath, {
        branch: this.stateService.getCurrentBranch(),
        maxCommits: 50
      });

      webviewView.webview.html = this.getBlameHtml(filePath, this.blameLines, fileHistory);
    } catch (err) {
      webviewView.webview.html = this.getErrorHtml(err instanceof Error ? err.message : String(err));
    }
  }

  private async showDiff(commitHash: string, webviewView: vscode.WebviewView): Promise<void> {
    try {
      const diff = await this.gitService.getDiff(commitHash);
      await vscode.commands.executeCommand('gitArchaeologist.openCommit', commitHash);
    } catch (err) {
      vscode.window.showErrorMessage(`显示差异失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async goToLine(lineNumber: number): Promise<void> {
    if (!this.currentFile) return;
    const fullPath = path.join(this.workspaceRoot, this.currentFile);
    const doc = await vscode.workspace.openTextDocument(fullPath);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(Math.max(0, lineNumber - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  private getInitialHtml(): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body { font-family: sans-serif; padding: 20px; color: #888; }
      input { width: 100%; padding: 6px 10px; box-sizing: border-box; margin: 10px 0; }
      button { padding: 6px 12px; }
    </style></head><body><h2>行级溯源</h2><p>请选择文件或通过右键菜单查看当前文件的行级责任信息。</p></body></html>`;
  }

  private getNoFileHtml(): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body { font-family: sans-serif; padding: 30px; text-align: center; color: #888; }
      .icon { font-size: 48px; margin-bottom: 16px; }
    </style></head><body>
      <div class="icon">📄</div>
      <h3>请在编辑器中打开一个文件</h3>
      <p>或输入文件路径:</p>
      <input type="text" id="filePath" placeholder="如: src/app.ts" />
      <button onclick="loadFile()">加载</button>
      <script>
        const vscode = acquireVsCodeApi();
        function loadFile() {
          const p = document.getElementById('filePath').value.trim();
          if (p) vscode.postMessage({ command: 'loadBlame', filePath: p });
        }
      </script>
    </body></html>`;
  }

  private getLoadingHtml(): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body { font-family: sans-serif; padding: 40px; text-align: center; color: #888; }
      .spinner { font-size: 36px; animation: spin 1s linear infinite; display: inline-block; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    </style></head><body><div class="spinner">⏳</div><p>正在分析代码责任...</p></body></html>`;
  }

  private getErrorHtml(error: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body { font-family: sans-serif; padding: 40px; color: #f44; }
      .err { background: rgba(255,68,68,0.1); border: 1px solid #f44; padding: 16px; border-radius: 6px; font-family: monospace; }
    </style></head><body>
      <h2>❌ 加载失败</h2><div class="err"><pre>${error}</pre></div>
      <p><input type="text" id="fp" placeholder="换个文件试试" />
      <button onclick="loadF()">重试</button></p>
      <script>const vs = acquireVsCodeApi(); function loadF() {
        const p = document.getElementById('fp').value.trim();
        vs.postMessage({ command: p ? 'loadBlame' : 'refresh', filePath: p });
      }</script>
    </body></html>`;
  }

  private getBlameHtml(filePath: string, lines: BlameLine[], history: any[]): string {
    const authorColors = new Map<string, string>();
    const colorPalette = ['#ffd1dc', '#e0bbff', '#bbdefb', '#b2dfdb', '#ffe0b2', '#f0f4c3', '#ffccbc', '#d1c4e9'];
    let colorIdx = 0;

    const summary = new Map<string, { count: number; author: string; email: string; date: string }>();
    for (const line of lines) {
      if (!summary.has(line.commitHash)) {
        summary.set(line.commitHash, { count: 0, author: line.authorName, email: line.authorEmail, date: line.date });
      }
      summary.get(line.commitHash)!.count++;
    }

    const topContributors = Array.from(summary.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 12px;
    color: var(--vscode-editor-foreground, #333);
    background: var(--vscode-editor-background, #fff);
  }
  .header {
    position: sticky; top: 0; z-index: 100;
    background: var(--vscode-editor-background, #fff);
    border-bottom: 1px solid var(--vscode-panel-border, #ddd);
    padding: 10px 14px;
  }
  .header h2 { font-size: 14px; margin-bottom: 6px; }
  .file-path {
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: 11px; color: var(--vscode-descriptionForeground, #666);
    background: var(--vscode-textBlockQuote-background, #f5f5f5);
    padding: 4px 8px; border-radius: 3px; display: inline-block;
    word-break: break-all;
  }
  .controls { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .controls input, .controls button {
    padding: 4px 8px; font-size: 11px; border: 1px solid var(--vscode-panel-border, #ccc);
    border-radius: 3px; background: var(--vscode-input-background, #fff);
    color: var(--vscode-input-foreground, #333);
  }
  .controls button { cursor: pointer; background: var(--vscode-button-background, #0078d4); color: white; border: none; }

  .stats-bar {
    display: flex; gap: 8px; padding: 10px 14px; flex-wrap: wrap;
    background: var(--vscode-editor-inactiveSelectionBackground, #f8f8f8);
    border-bottom: 1px solid var(--vscode-panel-border, #ddd);
  }
  .stat-chip {
    background: var(--vscode-badge-background, #e0e0e0);
    color: var(--vscode-badge-foreground, #333);
    padding: 3px 8px; border-radius: 10px; font-size: 11px;
  }

  .blame-container { max-height: calc(100vh - 280px); overflow-y: auto; }
  .blame-line {
    display: flex; align-items: stretch;
    border-bottom: 1px solid var(--vscode-editor-lineBorder, #f0f0f0);
    cursor: pointer;
    transition: background 0.15s;
  }
  .blame-line:hover { background: var(--vscode-list-hoverBackground, #f0f7ff); }
  .blame-meta {
    flex-shrink: 0;
    width: 220px;
    padding: 3px 8px;
    border-right: 1px solid var(--vscode-panel-border, #eee);
    display: flex; flex-direction: column;
    font-size: 11px;
    overflow: hidden;
    position: relative;
  }
  .blame-meta-info { display: flex; justify-content: space-between; gap: 4px; }
  .blame-author { font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
  .blame-date { color: var(--vscode-descriptionForeground, #888); flex-shrink: 0; }
  .blame-hash {
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: 10px;
    color: var(--vscode-textLink-activeForeground, #0078d4);
    display: inline-block;
    max-width: 100%;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }
  .blame-line-num {
    flex-shrink: 0;
    width: 42px;
    padding: 3px 8px 3px 4px;
    text-align: right;
    color: var(--vscode-editorLineNumber-foreground, #999);
    font-family: 'Cascadia Code', Consolas, monospace;
    border-right: 1px solid var(--vscode-editor-lineBorder, #f0f0f0);
    user-select: none;
  }
  .blame-content {
    flex: 1;
    padding: 3px 8px;
    font-family: 'Cascadia Code', Consolas, monospace;
    white-space: pre;
    overflow-x: auto;
    min-width: 0;
  }
  .blame-actions {
    position: absolute; right: 4px; top: 2px;
    display: none; gap: 2px;
  }
  .blame-line:hover .blame-actions { display: flex; }
  .action-btn {
    font-size: 10px;
    padding: 1px 4px;
    background: var(--vscode-button-secondaryBackground, #e0e0e0);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    color: var(--vscode-button-secondaryForeground, #333);
  }

  .color-bar {
    position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  }

  .top-contributors {
    padding: 10px 14px;
    background: var(--vscode-editor-inactiveSelectionBackground, #f8f8f8);
    border-bottom: 1px solid var(--vscode-panel-border, #ddd);
  }
  .top-contributors h4 { font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin-bottom: 6px; text-transform: uppercase; }
  .contrib-row { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
  .contrib-color { width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0; }
  .contrib-name { flex: 1; font-size: 11px; min-width: 0; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
  .contrib-count { font-size: 11px; font-weight: 600; }

  .history-section {
    padding: 10px 14px;
    border-top: 1px solid var(--vscode-panel-border, #ddd);
  }
  .history-section h4 { font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin-bottom: 6px; text-transform: uppercase; }
  .history-item {
    padding: 6px 8px;
    margin: 3px 0;
    background: var(--vscode-editor-inactiveSelectionBackground, #f8f8f8);
    border-radius: 3px;
    cursor: pointer;
  }
  .history-item:hover { background: var(--vscode-list-hoverBackground, #f0f7ff); }
  .history-meta { font-size: 10px; color: var(--vscode-descriptionForeground, #888); margin-bottom: 2px; }
  .history-msg { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>
  <div class="header">
    <h2>🔍 行级溯源</h2>
    <div class="file-path" title="${filePath}">📄 ${filePath}</div>
    <div class="controls">
      <input type="text" id="newFile" placeholder="切换文件路径..." style="flex:1; min-width: 150px;" />
      <button onclick="loadFile()">切换</button>
      <input type="text" id="searchLine" placeholder="搜索内容..." style="flex:1; min-width: 150px;" />
      <button onclick="doSearch()">搜索</button>
    </div>
  </div>

  <div class="stats-bar">
    <span class="stat-chip">📝 ${lines.length.toLocaleString()} 行</span>
    <span class="stat-chip">📊 ${summary.size} 次提交</span>
    <span class="stat-chip">👥 ${new Set(lines.map(l => l.authorName)).size} 位作者</span>
  </div>

  <div class="top-contributors">
    <h4>👑 主要贡献者</h4>
    ${topContributors.map(([hash, info]) => {
      if (!authorColors.has(info.author)) {
        authorColors.set(info.author, colorPalette[colorIdx % colorPalette.length]);
        colorIdx++;
      }
      const pct = ((info.count / lines.length) * 100).toFixed(1);
      return `<div class="contrib-row">
        <div class="contrib-color" style="background:${authorColors.get(info.author)}"></div>
        <div class="contrib-name" title="${info.email}">${info.author}</div>
        <div class="contrib-count">${info.count}行 (${pct}%)</div>
      </div>`;
    }).join('')}
  </div>

  <div class="blame-container" id="blameContainer">
    ${lines.map(line => {
      if (!authorColors.has(line.authorName)) {
        authorColors.set(line.authorName, colorPalette[colorIdx % colorPalette.length]);
        colorIdx++;
      }
      const isFav = this.stateService.isFavorite(line.commitHash) ? '⭐' : '';
      return `<div class="blame-line" onclick="openCommit('${line.commitHash}')" ondblclick="goToLine(${line.lineNumber})">
        <div class="color-bar" style="background:${authorColors.get(line.authorName)}"></div>
        <div class="blame-meta">
          <div class="blame-actions">
            <button class="action-btn" onclick="event.stopPropagation(); copyLink('${line.commitHash}', ${line.lineNumber})">🔗</button>
            <button class="action-btn" onclick="event.stopPropagation(); showDiff('${line.commitHash}')">📄</button>
            <button class="action-btn" onclick="event.stopPropagation(); toggleFav('${line.commitHash}')">⭐</button>
          </div>
          <div class="blame-meta-info">
            <span class="blame-author">${isFav}${this.escapeHtml(line.authorName)}</span>
            <span class="blame-date">${this.formatShortDate(line.date)}</span>
          </div>
          <span class="blame-hash" title="点击查看提交">${line.shortHash}</span>
        </div>
        <div class="blame-line-num">${line.lineNumber}</div>
        <div class="blame-content">${this.escapeHtml(line.content) || '&nbsp;'}</div>
      </div>`;
    }).join('')}
  </div>

  <div class="history-section">
    <h4>📜 文件历史 (最近 ${history.length} 次)</h4>
    ${history.slice(0, 20).map(h => `<div class="history-item" onclick="openCommit('${h.commitHash}')">
      <div class="history-meta">${this.formatShortDate(h.date)} · ${this.escapeHtml(h.author)} · ${h.status === 'A' ? '[新增]' : h.status === 'D' ? '[删除]' : h.status === 'M' ? '[修改]' : h.status === 'R' ? '[重命名]' : ''} +${h.additions}/-${h.deletions}</div>
      <div class="history-msg">${this.escapeHtml(h.message)}</div>
    </div>`).join('')}
  </div>

<script>
  const vs = acquireVsCodeApi();
  function loadFile() {
    const p = document.getElementById('newFile').value.trim();
    if (p) vs.postMessage({ command: 'loadBlame', filePath: p });
  }
  function openCommit(h) { vs.postMessage({ command: 'openCommit', commitHash: h }); }
  function copyLink(h, l) { vs.postMessage({ command: 'copyLocationLink', commitHash: h, lineNumber: l }); }
  function showDiff(h) { vs.postMessage({ command: 'showDiff', commitHash: h }); }
  function toggleFav(h) { vs.postMessage({ command: 'toggleFavorite', commitHash: h }); }
  function goToLine(l) { vs.postMessage({ command: 'goToLine', lineNumber: l }); }
  function doSearch() {
    const q = document.getElementById('searchLine').value.toLowerCase();
    if (!q) return;
    const container = document.getElementById('blameContainer');
    const items = container.querySelectorAll('.blame-content');
    for (const item of items) {
      const text = item.textContent || '';
      if (text.toLowerCase().includes(q)) {
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        item.parentElement.style.background = 'var(--vscode-editor-findMatchHighlightBackground, #ffd800)';
        setTimeout(() => item.parentElement.style.background = '', 2000);
        break;
      }
    }
  }
</script>
</body>
</html>`;
  }

  private formatShortDate(dateStr: string): string {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    } catch {
      return dateStr.substring(5, 10);
    }
  }

  private escapeHtml(str: string): string {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
