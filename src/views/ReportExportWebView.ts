import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../services/GitService';
import { StateService } from '../services/StateService';
import { ReportService } from '../services/ReportService';

export class ReportExportWebView {
  public static readonly viewType = 'gitArchaeologist.reportExport';
  private _currentView?: vscode.WebviewView;

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService,
    private stateService: StateService,
    private reportService: ReportService,
    private workspaceRoot: string
  ) {
    this.stateService.onDidChangeBranch(async () => {
      if (this._currentView && this._currentView.visible) {
        try { await this.refreshPreview(this._currentView); } catch {}
      }
    });
    this.stateService.onDidChangeFilter(async () => {
      if (this._currentView && this._currentView.visible) {
        try { await this.refreshPreview(this._currentView); } catch {}
      }
    });
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this._currentView = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getInitialHtml();

    webviewView.onDidChangeVisibility(async () => {
      if (webviewView.visible) {
        await this.refreshPreview(webviewView);
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'generatePreview':
          await this.refreshPreview(webviewView);
          break;
        case 'exportMarkdown':
          await this.exportMarkdown(webviewView);
          break;
        case 'exportJson':
          await this.exportJson(webviewView);
          break;
        case 'copyStoryline':
          await this.copyStoryline();
          break;
        case 'generateStoryline':
          await this.showStoryline();
          break;
        case 'openDiffCommits':
          await vscode.commands.executeCommand('gitArchaeologist.diffCommits');
          break;
      }
    });
  }

  private async refreshPreview(webviewView: vscode.WebviewView): Promise<void> {
    try {
      webviewView.webview.postMessage({ command: 'showLoading' });

      const options = this.stateService.getFilterOptions();
      const [repoInfo, commits, hotFiles, authors] = await Promise.all([
        this.gitService.getRepositoryInfo(),
        this.gitService.getCommits(options),
        this.gitService.getHotFiles(20),
        this.gitService.getAllAuthors()
      ]);

      const reportMd = this.reportService.generateMarkdownReport(
        repoInfo, commits, options, hotFiles, authors
      );
      const storylines = this.reportService.generateStorylines(commits);
      const favorites = commits.filter(c => this.stateService.isFavorite(c.hash));

      webviewView.webview.postMessage({
        command: 'updatePreview',
        data: {
          options,
          repoInfo,
          totalCommits: commits.length,
          totalAuthors: authors.length,
          hotFilesCount: hotFiles.length,
          favoritesCount: favorites.length,
          storylinesCount: storylines.length,
          highImpactCount: storylines.filter(s => s.impact === 'high').length,
          mediumImpactCount: storylines.filter(s => s.impact === 'medium').length,
          lowImpactCount: storylines.filter(s => s.impact === 'low').length,
          featureCount: storylines.filter(s => s.category === 'feature').length,
          fixCount: storylines.filter(s => s.category === 'fix').length,
          refactorCount: storylines.filter(s => s.category === 'refactor').length,
          docsCount: storylines.filter(s => s.category === 'docs').length,
          choreCount: storylines.filter(s => s.category === 'chore').length,
          otherCount: storylines.filter(s => s.category === 'other').length,
          storylines: storylines.slice(0, 50),
          reportPreview: reportMd.substring(0, 5000)
        }
      });
    } catch (err) {
      webviewView.webview.postMessage({
        command: 'showError',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async exportMarkdown(webviewView: vscode.WebviewView): Promise<void> {
    try {
      const options = this.stateService.getFilterOptions();
      const [repoInfo, commits, hotFiles, authors] = await Promise.all([
        this.gitService.getRepositoryInfo(),
        this.gitService.getCommits(options),
        this.gitService.getHotFiles(20),
        this.gitService.getAllAuthors()
      ]);

      const reportMd = this.reportService.generateMarkdownReport(
        repoInfo, commits, options, hotFiles, authors
      );

      const defaultPath = path.join(
        this.workspaceRoot,
        `git-archaeologist-report-${new Date().toISOString().substring(0, 10)}.md`
      );

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultPath),
        filters: { 'Markdown': ['md'] }
      });

      if (!uri) return;

      fs.writeFileSync(uri.fsPath, reportMd, 'utf-8');
      vscode.window.showInformationMessage(`报告已导出: ${uri.fsPath}`);

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      vscode.window.showErrorMessage(`导出失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async exportJson(webviewView: vscode.WebviewView): Promise<void> {
    try {
      const options = this.stateService.getFilterOptions();
      const [repoInfo, commits, hotFiles, authors] = await Promise.all([
        this.gitService.getRepositoryInfo(),
        this.gitService.getCommits(options),
        this.gitService.getHotFiles(100),
        this.gitService.getAllAuthors()
      ]);

      const storylines = this.reportService.generateStorylines(commits);
      const favorites = commits.filter(c => this.stateService.isFavorite(c.hash));

      const allDefects = new Map<string, number>();
      for (const commit of commits) {
        const defects = this.reportService.extractDefectsFromMessage(commit.message, commit.body);
        const linked = this.stateService.getDefectIds(commit.hash);
        [...defects, ...linked].forEach(d => {
          allDefects.set(d, (allDefects.get(d) || 0) + 1);
        });
      }

      const jsonData = {
        generatedAt: new Date().toISOString(),
        repository: repoInfo,
        filter: options,
        summary: {
          totalCommits: commits.length,
          totalAuthors: authors.length,
          totalFilesChanged: new Set(commits.flatMap(c => c.files.map(f => f.filePath))).size,
          totalLinesAdded: commits.reduce((s, c) => s + (c.stats?.totalAdditions || 0), 0),
          totalLinesDeleted: commits.reduce((s, c) => s + (c.stats?.totalDeletions || 0), 0)
        },
        commitsByAuthor: authors.map(a => ({ name: a.name, email: a.email, count: a.commitCount })),
        hotFiles,
        storylines: storylines.map(s => ({
          commitHash: s.commit.hash,
          narrative: s.narrative,
          category: s.category,
          impact: s.impact
        })),
        favoriteCommits: favorites.map(c => ({
          hash: c.hash,
          shortHash: c.shortHash,
          author: c.authorName,
          date: c.date,
          message: c.message,
          note: this.stateService.getNote(c.hash),
          defects: this.stateService.getDefectIds(c.hash)
        })),
        topDefects: Array.from(allDefects.entries())
          .map(([id, count]) => ({ id, count }))
          .sort((a, b) => b.count - a.count),
        rawCommits: commits.map(c => ({
          hash: c.hash,
          shortHash: c.shortHash,
          author: c.authorName,
          authorEmail: c.authorEmail,
          date: c.date,
          message: c.message,
          body: c.body,
          parents: c.parentHashes,
          stats: c.stats,
          files: c.files.map(f => ({
            status: f.status,
            filePath: f.filePath,
            oldFilePath: f.oldFilePath,
            additions: f.additions,
            deletions: f.deletions
          })),
          isFavorite: this.stateService.isFavorite(c.hash),
          note: this.stateService.getNote(c.hash),
          defectIds: this.stateService.getDefectIds(c.hash)
        }))
      };

      const defaultPath = path.join(
        this.workspaceRoot,
        `git-archaeologist-data-${new Date().toISOString().substring(0, 10)}.json`
      );

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultPath),
        filters: { 'JSON': ['json'] }
      });

      if (!uri) return;

      fs.writeFileSync(uri.fsPath, JSON.stringify(jsonData, null, 2), 'utf-8');
      vscode.window.showInformationMessage(`数据已导出: ${uri.fsPath}`);
    } catch (err) {
      vscode.window.showErrorMessage(`导出失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async copyStoryline(): Promise<void> {
    try {
      const options = this.stateService.getFilterOptions();
      const commits = await this.gitService.getCommits(options);
      const storylines = this.reportService.generateStorylines(commits);

      let text = '# Git 仓库改动故事线\n\n';
      text += `> 生成时间: ${new Date().toLocaleString('zh-CN')}\n\n`;

      const groups: Record<string, typeof storylines> = {
        high: storylines.filter(s => s.impact === 'high'),
        medium: storylines.filter(s => s.impact === 'medium'),
        low: storylines.filter(s => s.impact === 'low')
      };

      for (const [impact, list] of Object.entries(groups)) {
        if (list.length === 0) continue;
        const label = impact === 'high' ? '大规模变更' : impact === 'medium' ? '中等规模变更' : '小范围变更';
        text += `## ${label} (${list.length})\n\n`;
        for (const s of list) {
          text += `- ${this.formatDate(s.commit.date)} ${s.narrative}\n`;
        }
        text += '\n';
      }

      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('改动故事线已复制到剪贴板');
    } catch (err) {
      vscode.window.showErrorMessage(`复制失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async showStoryline(): Promise<void> {
    try {
      const options = this.stateService.getFilterOptions();
      const commits = await this.gitService.getCommits(options);
      const storylines = this.reportService.generateStorylines(commits);

      const panel = vscode.window.createWebviewPanel(
        'gitStoryline',
        '改动故事线',
        vscode.ViewColumn.One,
        { enableScripts: true }
      );

      panel.webview.html = this.getStorylineHtml(storylines);
    } catch (err) {
      vscode.window.showErrorMessage(`生成故事线失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private getStorylineHtml(storylines: any[]): string {
    const categoryColors: Record<string, string> = {
      feature: '#2ea043',
      fix: '#da3633',
      refactor: '#8957e5',
      docs: '#1f6feb',
      chore: '#6e7781',
      other: '#57606a'
    };
    const categoryLabels: Record<string, string> = {
      feature: '新功能', fix: '缺陷修复', refactor: '代码重构',
      docs: '文档更新', chore: '日常维护', other: '代码变更'
    };
    const impactIcons: Record<string, string> = { high: '🔥', medium: '⚡', low: '✨' };
    const impactLabels: Record<string, string> = { high: '大规模', medium: '中等规模', low: '小范围' };

    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif; padding: 24px; max-width: 900px; margin: 0 auto; background: #fff; color: #333; }
      h1 { font-size: 24px; margin-bottom: 8px; }
      .subtitle { color: #666; margin-bottom: 24px; font-size: 13px; }
      .timeline { position: relative; padding-left: 30px; }
      .timeline::before { content: ''; position: absolute; left: 10px; top: 0; bottom: 0; width: 2px; background: #e0e0e0; }
      .entry { position: relative; margin-bottom: 16px; }
      .entry::before {
        content: ''; position: absolute; left: -26px; top: 6px; width: 14px; height: 14px;
        border-radius: 50%; background: #fff; border: 3px solid var(--cat-color, #888); z-index: 1;
      }
      .entry-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12px; }
      .category-tag {
        display: inline-block; padding: 2px 8px; border-radius: 10px;
        background: var(--cat-bg, #eee); color: var(--cat-color, #333);
        font-size: 11px; font-weight: 500;
      }
      .impact-tag { font-size: 14px; }
      .entry-date { color: #666; font-family: monospace; font-size: 11px; }
      .entry-author { font-weight: 500; color: #444; }
      .entry-hash {
        font-family: 'Cascadia Code', Consolas, monospace; font-size: 11px;
        color: #1f6feb; background: #f0f6ff; padding: 1px 4px; border-radius: 3px;
      }
      .entry-narrative { font-size: 13px; line-height: 1.6; color: #333; margin-top: 4px; }
      .entry-message { font-size: 12px; color: #666; margin-top: 4px; padding: 6px 10px; background: #f8f8f8; border-radius: 4px; border-left: 3px solid var(--cat-color, #ccc); }
      .stats { display: flex; gap: 16px; margin-bottom: 20px; padding: 12px; background: #f8f8f8; border-radius: 8px; flex-wrap: wrap; }
      .stat { text-align: center; }
      .stat-num { font-size: 20px; font-weight: 700; color: #1f6feb; }
      .stat-label { font-size: 11px; color: #666; text-transform: uppercase; }
      .filter-bar { display: flex; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; }
      .filter-btn {
        padding: 4px 10px; border: 1px solid #ddd; background: #fff; border-radius: 4px;
        cursor: pointer; font-size: 12px;
      }
      .filter-btn.active { background: #1f6feb; color: #fff; border-color: #1f6feb; }
    </style></head><body>
      <h1>📖 Git 仓库改动故事线</h1>
      <p class="subtitle">共 ${storylines.length} 条提交记录 · 生成于 ${new Date().toLocaleString('zh-CN')}</p>

      <div class="stats">
        <div class="stat"><div class="stat-num">${storylines.length}</div><div class="stat-label">总提交</div></div>
        <div class="stat"><div class="stat-num">${storylines.filter(s => s.impact === 'high').length}</div><div class="stat-label">🔥 大规模</div></div>
        <div class="stat"><div class="stat-num">${storylines.filter(s => s.impact === 'medium').length}</div><div class="stat-label">⚡ 中等</div></div>
        <div class="stat"><div class="stat-num">${storylines.filter(s => s.impact === 'low').length}</div><div class="stat-label">✨ 小范围</div></div>
        <div class="stat"><div class="stat-num">${storylines.filter(s => s.category === 'feature').length}</div><div class="stat-label">新功能</div></div>
        <div class="stat"><div class="stat-num">${storylines.filter(s => s.category === 'fix').length}</div><div class="stat-label">修复</div></div>
        <div class="stat"><div class="stat-num">${storylines.filter(s => s.category === 'refactor').length}</div><div class="stat-label">重构</div></div>
      </div>

      <div class="filter-bar">
        <button class="filter-btn active" data-filter="all">全部</button>
        <button class="filter-btn" data-filter="high">🔥 大规模</button>
        <button class="filter-btn" data-filter="medium">⚡ 中等</button>
        <button class="filter-btn" data-filter="low">✨ 小范围</button>
        <button class="filter-btn" data-cat="feature">🌟 新功能</button>
        <button class="filter-btn" data-cat="fix">🐛 缺陷修复</button>
        <button class="filter-btn" data-cat="refactor">♻️ 重构</button>
      </div>

      <div class="timeline">
        ${storylines.map(s => `
          <div class="entry" data-impact="${s.impact}" data-category="${s.category}"
            style="--cat-color: ${categoryColors[s.category]}; --cat-bg: ${categoryColors[s.category]}15">
            <div class="entry-header">
              <span class="impact-tag" title="${impactLabels[s.impact]}">${impactIcons[s.impact]}</span>
              <span class="category-tag">${categoryLabels[s.category]}</span>
              <span class="entry-date">${this.formatDate(s.commit.date)}</span>
              <span class="entry-author">${s.commit.authorName}</span>
              <span class="entry-hash">${s.commit.shortHash}</span>
            </div>
            <div class="entry-narrative">${s.narrative}</div>
            <div class="entry-message">💬 ${this.escapeHtml(s.commit.message)}</div>
          </div>
        `).join('')}
      </div>

      <script>
        document.querySelectorAll('.filter-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const filter = btn.dataset.filter;
            const cat = btn.dataset.cat;
            document.querySelectorAll('.entry').forEach(e => {
              let show = true;
              if (filter && filter !== 'all') {
                show = e.dataset.impact === filter;
              }
              if (cat) {
                show = e.dataset.category === cat;
              }
              e.style.display = show ? '' : 'none';
            });
          });
        });
      </script>
    </body></html>`;
  }

  private getInitialHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    padding: 16px;
    font-size: 13px;
    color: var(--vscode-editor-foreground, #333);
    background: var(--vscode-editor-background, #fff);
    line-height: 1.5;
  }
  h1 { font-size: 16px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  .card {
    background: var(--vscode-editor-inactiveSelectionBackground, #f5f5f5);
    border: 1px solid var(--vscode-panel-border, #ddd);
    border-radius: 6px;
    padding: 14px;
    margin-bottom: 14px;
  }
  .card h3 { font-size: 13px; margin-bottom: 10px; color: var(--vscode-descriptionForeground, #666); text-transform: uppercase; }
  .action-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn {
    padding: 8px 14px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .btn-primary { background: var(--vscode-button-background, #0078d4); color: var(--vscode-button-foreground, white); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground, #e8e8e8); color: var(--vscode-button-secondaryForeground, #333); }
  .btn:hover { opacity: 0.9; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; }
  .stat-item {
    text-align: center;
    padding: 10px;
    background: var(--vscode-editor-background, #fff);
    border: 1px solid var(--vscode-panel-border, #ddd);
    border-radius: 4px;
  }
  .stat-num { font-size: 20px; font-weight: 700; color: var(--vscode-textLink-activeForeground, #0078d4); }
  .stat-label { font-size: 10px; color: var(--vscode-descriptionForeground, #888); text-transform: uppercase; margin-top: 2px; }
  .category-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .cat-item {
    padding: 6px 8px;
    background: var(--vscode-editor-background, #fff);
    border-radius: 4px;
    text-align: center;
    font-size: 11px;
  }
  .cat-num { font-weight: 700; font-size: 16px; }
  .preview-section { max-height: 400px; overflow-y: auto; }
  .preview-section pre {
    background: var(--vscode-editor-background, #fff);
    padding: 12px;
    border-radius: 4px;
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 350px;
    overflow-y: auto;
  }
  .loading { padding: 30px; text-align: center; color: #888; display: none; }
  .loading.show { display: block; }
  .spinner { font-size: 28px; animation: spin 1s linear infinite; display: inline-block; margin-bottom: 8px; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .storyline-list { max-height: 300px; overflow-y: auto; }
  .storyline-item {
    padding: 8px 10px;
    margin: 4px 0;
    background: var(--vscode-editor-background, #fff);
    border-left: 3px solid var(--vscode-textLink-activeForeground, #0078d4);
    border-radius: 0 4px 4px 0;
    font-size: 12px;
  }
  .storyline-meta { font-size: 10px; color: #888; margin-bottom: 3px; }
</style>
</head>
<body>
  <h1>📤 报告导出</h1>

  <div class="card">
    <h3>📊 数据概览</h3>
    <div class="loading show" id="loading">
      <div class="spinner">⏳</div>
      <div>正在加载数据...</div>
    </div>
    <div id="overviewData" style="display:none">
      <div class="stats-grid" id="statsGrid"></div>
      <div style="margin-top:12px">
        <h4 style="font-size:11px;color:#888;margin-bottom:6px;text-transform:uppercase">按分类统计</h4>
        <div class="category-grid" id="categoryGrid"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>📖 改动故事线</h3>
    <div class="action-row" style="margin-bottom:10px">
      <button class="btn btn-secondary" onclick="generateStoryline()">📖 生成完整故事线</button>
      <button class="btn btn-secondary" onclick="copyStoryline()">📋 复制到剪贴板</button>
    </div>
    <div class="storyline-list" id="storylineList"></div>
  </div>

  <div class="card">
    <h3>💾 导出选项</h3>
    <div class="action-row">
      <button class="btn btn-primary" onclick="exportMarkdown()">📄 导出 Markdown 报告</button>
      <button class="btn btn-secondary" onclick="exportJson()">📦 导出 JSON 数据</button>
    </div>
    <p style="font-size:11px;color:#888;margin-top:8px">报告内容基于当前筛选条件（分支、日期、作者、关键词）生成。</p>
  </div>

  <div class="card">
    <h3>🔀 比较工具</h3>
    <div class="action-row">
      <button class="btn btn-secondary" onclick="openDiff()">🔀 比较两个版本差异</button>
    </div>
    <p style="font-size:11px;color:#888;margin-top:8px">在时间线中选中两个提交后可进行差异比较。</p>
  </div>

  <div class="card">
    <h3>📝 报告预览</h3>
    <div class="preview-section">
      <pre id="reportPreview">点击上方"生成预览"或导出按钮生成报告</pre>
    </div>
  </div>

<script>
  const vs = acquireVsCodeApi();
  function exportMarkdown() { vs.postMessage({ command: 'exportMarkdown' }); }
  function exportJson() { vs.postMessage({ command: 'exportJson' }); }
  function copyStoryline() { vs.postMessage({ command: 'copyStoryline' }); }
  function generateStoryline() { vs.postMessage({ command: 'generateStoryline' }); }
  function openDiff() { vs.postMessage({ command: 'openDiffCommits' }); }
  function doRefresh() {
    document.getElementById('loading').classList.add('show');
    document.getElementById('overviewData').style.display = 'none';
    vs.postMessage({ command: 'generatePreview' });
  }
  setTimeout(doRefresh, 300);
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'showLoading') {
      document.getElementById('loading').classList.add('show');
    }
    if (msg.command === 'updatePreview') {
      document.getElementById('loading').classList.remove('show');
      document.getElementById('overviewData').style.display = '';
      const d = msg.data;
      document.getElementById('statsGrid').innerHTML = \`
        <div class="stat-item"><div class="stat-num">\${d.totalCommits}</div><div class="stat-label">提交</div></div>
        <div class="stat-item"><div class="stat-num">\${d.totalAuthors}</div><div class="stat-label">作者</div></div>
        <div class="stat-item"><div class="stat-num">\${d.hotFilesCount}</div><div class="stat-label">热文件</div></div>
        <div class="stat-item"><div class="stat-num">\${d.favoritesCount}</div><div class="stat-label">收藏</div></div>
        <div class="stat-item"><div class="stat-num">\${d.highImpactCount}</div><div class="stat-label" style="color:#da3633">🔥 大规模</div></div>
        <div class="stat-item"><div class="stat-num">\${d.mediumImpactCount}</div><div class="stat-label" style="color:#d4a72c">⚡ 中等</div></div>
        <div class="stat-item"><div class="stat-num">\${d.lowImpactCount}</div><div class="stat-label" style="color:#2ea043">✨ 小范围</div></div>
        <div class="stat-item"><div class="stat-num">\${d.storylinesCount}</div><div class="stat-label">故事</div></div>
      \`;
      document.getElementById('categoryGrid').innerHTML = \`
        <div class="cat-item"><div class="cat-num" style="color:#2ea043">\${d.featureCount}</div>新功能</div>
        <div class="cat-item"><div class="cat-num" style="color:#da3633">\${d.fixCount}</div>缺陷修复</div>
        <div class="cat-item"><div class="cat-num" style="color:#8957e5">\${d.refactorCount}</div>重构</div>
        <div class="cat-item"><div class="cat-num" style="color:#1f6feb">\${d.docsCount}</div>文档</div>
        <div class="cat-item"><div class="cat-num" style="color:#6e7781">\${d.choreCount}</div>维护</div>
        <div class="cat-item"><div class="cat-num" style="color:#57606a">\${d.otherCount}</div>其他</div>
      \`;
      document.getElementById('storylineList').innerHTML = d.storylines.map(s => \`
        <div class="storyline-item">
          <div class="storyline-meta">\${new Date(s.commit.date).toLocaleString('zh-CN')} · \${s.commit.authorName} · <span style="color:#1f6feb">\${s.commit.shortHash}</span>
            · <span style="color:\${s.impact==='high'?'#da3633':s.impact==='medium'?'#d4a72c':'#2ea043'}">\${s.impact==='high'?'🔥大规模':s.impact==='medium'?'⚡中等':'✨小范围'}</span>
            · <span style="color:\${s.category==='feature'?'#2ea043':s.category==='fix'?'#da3633':s.category==='refactor'?'#8957e5':'#666'}">\${({feature:'新功能',fix:'缺陷修复',refactor:'重构',docs:'文档',chore:'维护',other:'其他'})[s.category]}</span>
          </div>
          <div>\${s.narrative}</div>
        </div>
      \`).join('');
      document.getElementById('reportPreview').textContent = d.reportPreview + (d.reportPreview.length >= 5000 ? '\\n\\n... (内容已截断，完整内容请导出 Markdown 查看)' : '');
    }
    if (msg.command === 'showError') {
      document.getElementById('loading').classList.remove('show');
      alert('错误: ' + msg.message);
    }
  });
</script>
</body>
</html>`;
  }

  private formatDate(dateStr: string): string {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return dateStr;
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
