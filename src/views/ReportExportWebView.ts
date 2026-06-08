import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../services/GitService';
import { StateService } from '../services/StateService';
import { ReportService } from '../services/ReportService';
import { GitCommit, ReportTemplate, ReportSectionKey, BranchDiffSummary, HotFile, FilterOptions } from '../models/types';

interface CachedReportData {
  repoInfo: { name: string; rootPath: string; totalCommits: number; firstCommitDate: string; lastCommitDate: string; defaultBranch: string; remoteUrl?: string };
  commits: GitCommit[];
  hotFiles: HotFile[];
  authors: { name: string; email: string; commitCount: number }[];
  options: FilterOptions;
  diffSummary?: BranchDiffSummary;
  template: ReportTemplate;
  selectedSections: ReportSectionKey[];
  baseBranchForDiff?: string;
  allBranches: { name: string; isRemote: boolean; isCurrent: boolean }[];
}

export class ReportExportWebView {
  public static readonly viewType = 'gitArchaeologist.reportExport';
  private _currentView?: vscode.WebviewView;

  private _currentTemplate: ReportTemplate = 'handoff';
  private _selectedSections: ReportSectionKey[] = this.reportService.getTemplateDefaultSections('handoff');
  private _baseBranchForDiff?: string;
  private _cached?: CachedReportData;

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
        case 'selectTemplate':
          if (msg.template) {
            this._currentTemplate = msg.template as ReportTemplate;
            this._selectedSections = this.reportService.getTemplateDefaultSections(this._currentTemplate);
            await this.refreshPreview(webviewView);
          }
          break;
        case 'toggleSection':
          if (msg.section) {
            const key = msg.section as ReportSectionKey;
            const idx = this._selectedSections.indexOf(key);
            if (idx >= 0) {
              this._selectedSections.splice(idx, 1);
            } else {
              this._selectedSections.push(key);
            }
            await this.refreshPreview(webviewView);
          }
          break;
        case 'pickBaseBranch':
          await this.pickBaseBranch(webviewView);
          break;
        case 'clearBaseBranch':
          this._baseBranchForDiff = undefined;
          await this.refreshPreview(webviewView);
          break;
        case 'openCommitFromDiff':
          if (msg.commitHash) {
            await vscode.commands.executeCommand('gitArchaeologist.openCommit', msg.commitHash);
          }
          break;
        case 'showFileHistoryFromDiff':
          if (msg.filePath) {
            await vscode.commands.executeCommand('gitArchaeologist.showFileHistory', msg.filePath);
          }
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

  private async pickBaseBranch(webviewView: vscode.WebviewView): Promise<void> {
    try {
      const branches = await this.gitService.getBranches();
      const current = this.stateService.getCurrentBranch();
      const items = branches
        .filter(b => !b.isRemote && b.name !== current)
        .map(b => ({
          label: `🌿 ${b.name}`,
          description: b.lastCommitDate ? `更新于 ${this.formatDate(b.lastCommitDate)}` : undefined,
          name: b.name
        }));

      const pick = await vscode.window.showQuickPick(items, {
        title: '选择基准分支（与当前选中分支对比）',
        placeHolder: '选择用于对比的基准分支...'
      });

      if (pick) {
        this._baseBranchForDiff = pick.name;
        await this.refreshPreview(webviewView);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`选择基准分支失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async refreshPreview(webviewView: vscode.WebviewView): Promise<void> {
    try {
      webviewView.webview.postMessage({ command: 'showLoading' });

      const options = this.stateService.getFilterOptions();
      const branchArg = options.branch || undefined;
      const [repoInfo, commits, hotFiles, authors, allBranches] = await Promise.all([
        this.gitService.getRepositoryInfo(branchArg),
        this.gitService.getCommits(options),
        this.gitService.getHotFiles(20, branchArg),
        this.gitService.getAllAuthors(branchArg),
        this.gitService.getBranches()
      ]);

      let diffSummary: BranchDiffSummary | undefined;
      const baseBranch = this._baseBranchForDiff;
      if (baseBranch && options.branch && baseBranch !== options.branch) {
        const diff = await this.gitService.getBranchDiff(baseBranch, options.branch);
        const baseAuthors = await this.gitService.getAllAuthors(baseBranch);
        const baseAuthorEmails = new Set(baseAuthors.map(a => a.email.toLowerCase()));
        const targetAuthorEmails = new Set(authors.map(a => a.email.toLowerCase()));
        const authorsOnlyInTarget = authors.filter(a => !baseAuthorEmails.has(a.email.toLowerCase()));
        const authorsOnlyInBase = baseAuthors.filter(a => !targetAuthorEmails.has(a.email.toLowerCase()));
        const riskyCommits = this.gitService.getRiskyCommits(diff.addedCommits);

        diffSummary = {
          baseBranch,
          targetBranch: options.branch,
          addedCommits: diff.addedCommits,
          removedCommits: diff.removedCommits,
          authorsOnlyInTarget,
          authorsOnlyInBase,
          changedFiles: diff.changedFiles,
          riskyCommits
        };
      }

      this._cached = {
        repoInfo,
        commits,
        hotFiles,
        authors,
        options,
        diffSummary,
        template: this._currentTemplate,
        selectedSections: [...this._selectedSections],
        baseBranchForDiff: baseBranch,
        allBranches: allBranches.map(b => ({ name: b.name, isRemote: b.isRemote, isCurrent: b.isCurrent }))
      };

      const reportMd = this.reportService.generateMarkdownReport(
        repoInfo, commits, options, hotFiles, authors,
        {
          template: this._currentTemplate,
          sections: this._selectedSections,
          baseBranchForDiff: baseBranch
        },
        diffSummary
      );

      const storylines = this.reportService.generateStorylines(commits);
      const favorites = commits.filter(c => this.stateService.isFavorite(c.hash));
      const topDefects = this.reportService.computeTopDefects(commits);
      const templates = this.reportService.getAvailableTemplates();
      const sectionsMeta = this.reportService.getAllSectionsMeta();

      webviewView.webview.postMessage({
        command: 'updatePreview',
        data: {
          templates,
          currentTemplate: this._currentTemplate,
          sectionsMeta,
          selectedSections: this._selectedSections,
          options,
          baseBranchForDiff: baseBranch,
          diffSummary,
          repoInfo,
          totalCommits: commits.length,
          totalAuthors: authors.length,
          hotFilesCount: hotFiles.length,
          favoritesCount: favorites.length,
          defectsCount: topDefects.length,
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
          topAuthors: authors.slice(0, 10),
          topHotFiles: hotFiles.slice(0, 10),
          topDefects: topDefects.slice(0, 10),
          favorites: favorites.slice(0, 10),
          reportPreview: reportMd.substring(0, 8000),
          reportIsTruncated: reportMd.length > 8000,
          fullReportLength: reportMd.length
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
      if (!this._cached) {
        await this.refreshPreview(webviewView);
      }
      if (!this._cached) return;

      const c = this._cached;
      const reportMd = this.reportService.generateMarkdownReport(
        c.repoInfo, c.commits, c.options, c.hotFiles, c.authors,
        { template: c.template, sections: c.selectedSections, baseBranchForDiff: c.baseBranchForDiff },
        c.diffSummary
      );

      const tplLabel = ({ handoff: 'handoff', defect: 'defect', release: 'release' } as Record<ReportTemplate, string>)[c.template];
      const defaultPath = path.join(
        this.workspaceRoot,
        `git-report-${tplLabel}-${c.options.branch}-${new Date().toISOString().substring(0, 10)}.md`
      );

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultPath),
        filters: { 'Markdown': ['md'] }
      });

      if (!uri) return;

      fs.writeFileSync(uri.fsPath, reportMd, 'utf-8');
      vscode.window.showInformationMessage(`报告已导出 (${c.template} · ${c.options.branch}): ${uri.fsPath}`);

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      vscode.window.showErrorMessage(`导出失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async exportJson(webviewView: vscode.WebviewView): Promise<void> {
    try {
      if (!this._cached) {
        await this.refreshPreview(webviewView);
      }
      if (!this._cached) return;

      const c = this._cached;
      const json = this.reportService.generateJsonReport(
        c.repoInfo, c.commits, c.options, c.hotFiles, c.authors,
        { template: c.template, sections: c.selectedSections, baseBranchForDiff: c.baseBranchForDiff },
        c.diffSummary
      );

      const tplLabel = ({ handoff: 'handoff', defect: 'defect', release: 'release' } as Record<ReportTemplate, string>)[c.template];
      const defaultPath = path.join(
        this.workspaceRoot,
        `git-report-data-${tplLabel}-${c.options.branch}-${new Date().toISOString().substring(0, 10)}.json`
      );

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultPath),
        filters: { 'JSON': ['json'] }
      });

      if (!uri) return;

      fs.writeFileSync(uri.fsPath, JSON.stringify(json, null, 2), 'utf-8');
      vscode.window.showInformationMessage(`数据已导出 (${c.template} · ${c.options.branch}): ${uri.fsPath}`);
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
    padding: 14px;
    font-size: 13px;
    color: var(--vscode-editor-foreground, #d4d4d4);
    background: var(--vscode-editor-background, #1e1e1e);
    line-height: 1.5;
  }
  h1 { font-size: 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  h2 { font-size: 13px; margin-bottom: 8px; color: var(--vscode-descriptionForeground, #888); text-transform: uppercase; letter-spacing: 0.5px; }
  .card {
    background: var(--vscode-editor-inactiveSelectionBackground, #2b2b2b);
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 12px;
  }
  .template-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .tpl-btn {
    padding: 7px 12px;
    border: 1px solid var(--vscode-panel-border, #555);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ddd);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s;
    flex: 1;
    min-width: 100px;
  }
  .tpl-btn.active {
    background: var(--vscode-button-background, #0078d4);
    color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-background, #0078d4);
    box-shadow: 0 2px 6px rgba(0, 120, 212, 0.4);
  }
  .tpl-btn .tpl-title { display: block; font-size: 13px; font-weight: 600; margin-bottom: 2px; }
  .tpl-btn .tpl-desc { display: block; font-size: 10px; opacity: 0.8; line-height: 1.3; }
  .diff-row {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 10px;
    background: var(--vscode-editorWidget-background, #252526);
    border-radius: 4px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .diff-label { font-size: 11px; color: var(--vscode-descriptionForeground, #888); }
  .diff-branch {
    padding: 2px 8px;
    background: var(--vscode-button-background, #0078d4);
    color: var(--vscode-button-foreground, #fff);
    border-radius: 10px;
    font-size: 11px;
    font-weight: 500;
  }
  .diff-arrow { color: var(--vscode-descriptionForeground, #888); font-weight: 700; }
  .action-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn {
    padding: 7px 12px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.88; }
  .btn-primary { background: var(--vscode-button-background, #0078d4); color: var(--vscode-button-foreground, white); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ddd); }
  .btn-danger { background: var(--vscode-errorForeground, #f48771); color: #fff; }
  .btn-small { padding: 4px 10px; font-size: 11px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 6px; margin-bottom: 10px; }
  .stat-item {
    text-align: center;
    padding: 8px 4px;
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px;
  }
  .stat-num { font-size: 18px; font-weight: 700; color: var(--vscode-textLink-activeForeground, #3794ff); }
  .stat-label { font-size: 9px; color: var(--vscode-descriptionForeground, #888); text-transform: uppercase; margin-top: 2px; letter-spacing: 0.5px; }
  .category-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
  .cat-item {
    padding: 5px 4px;
    background: var(--vscode-editor-background, #1e1e1e);
    border-radius: 4px;
    text-align: center;
    font-size: 10px;
    border: 1px solid var(--vscode-panel-border, #333);
  }
  .cat-num { font-weight: 700; font-size: 14px; }
  .section-list { display: flex; flex-direction: column; gap: 4px; }
  .section-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--vscode-editor-background, #1e1e1e);
    border-radius: 4px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 0.15s;
  }
  .section-item:hover { border-color: var(--vscode-textBlockQuote-border, #555); }
  .section-item input[type="checkbox"] { cursor: pointer; }
  .section-item .sec-label { flex: 1; font-size: 12px; }
  .section-item .sec-desc { font-size: 10px; color: var(--vscode-descriptionForeground, #888); }
  .section-item .sec-count {
    padding: 1px 7px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
  }
  .diff-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 6px;
    margin-bottom: 10px;
  }
  .diff-stat {
    padding: 8px;
    background: var(--vscode-editor-background, #1e1e1e);
    border-radius: 4px;
    text-align: center;
    border: 1px solid var(--vscode-panel-border, #333);
  }
  .diff-stat-num { font-size: 16px; font-weight: 700; }
  .diff-stat-num.green { color: #2ea043; }
  .diff-stat-num.red { color: #f48771; }
  .diff-stat-num.orange { color: #d29922; }
  .diff-stat-num.purple { color: #a371f7; }
  .diff-stat-label { font-size: 10px; color: var(--vscode-descriptionForeground, #888); margin-top: 2px; }
  .diff-list {
    max-height: 180px;
    overflow-y: auto;
    background: var(--vscode-editor-background, #1e1e1e);
    border-radius: 4px;
    padding: 6px;
    margin-bottom: 6px;
  }
  .diff-list-title { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground, #999); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .clickable-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 7px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    transition: background 0.12s;
  }
  .clickable-row:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .clickable-row .hash {
    font-family: 'Cascadia Code', Consolas, monospace;
    color: var(--vscode-textLink-foreground, #3794ff);
    font-size: 10px;
    font-weight: 600;
  }
  .clickable-row .path {
    font-family: 'Cascadia Code', Consolas, monospace;
    color: var(--vscode-terminal-foreground, #cccccc);
    font-size: 10px;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-right: 8px;
  }
  .clickable-row .meta {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 10px;
    white-space: nowrap;
  }
  .risky-row { border-left: 3px solid var(--vscode-errorForeground, #f48771); }
  .preview-section { max-height: 380px; overflow-y: auto; }
  .preview-section pre {
    background: var(--vscode-editor-background, #1e1e1e);
    padding: 10px;
    border-radius: 4px;
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 340px;
    overflow-y: auto;
    color: var(--vscode-editor-foreground, #d4d4d4);
    border: 1px solid var(--vscode-panel-border, #333);
  }
  .preview-trunc-note {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #888);
    margin-top: 4px;
    font-style: italic;
  }
  .loading { padding: 26px; text-align: center; color: #888; display: none; }
  .loading.show { display: block; }
  .spinner { font-size: 28px; animation: spin 1s linear infinite; display: inline-block; margin-bottom: 8px; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .empty-tip {
    padding: 10px;
    text-align: center;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 11px;
    background: var(--vscode-editor-background, #1e1e1e);
    border-radius: 4px;
  }
  .storyline-list { max-height: 220px; overflow-y: auto; }
  .storyline-item {
    padding: 6px 8px;
    margin: 3px 0;
    background: var(--vscode-editor-background, #1e1e1e);
    border-left: 3px solid var(--vscode-textLink-activeForeground, #3794ff);
    border-radius: 0 4px 4px 0;
    font-size: 11px;
  }
  .storyline-meta { font-size: 10px; color: #888; margin-bottom: 2px; }
</style>
</head>
<body>
  <h1>📤 报告工作台</h1>

  <div class="card">
    <h2>📋 报告模板</h2>
    <div class="template-row" id="templateRow">
      <button class="tpl-btn active" data-tpl="handoff" onclick="selectTemplate('handoff')">
        <span class="tpl-title">🤝 交接概览</span>
        <span class="tpl-desc">项目全貌/作者/热点</span>
      </button>
      <button class="tpl-btn" data-tpl="defect" onclick="selectTemplate('defect')">
        <span class="tpl-title">🔍 缺陷排查</span>
        <span class="tpl-desc">可疑提交/风险/缺陷统计</span>
      </button>
      <button class="tpl-btn" data-tpl="release" onclick="selectTemplate('release')">
        <span class="tpl-title">🚀 发布回顾</span>
        <span class="tpl-desc">分支对比/故事线/明细</span>
      </button>
    </div>
  </div>

  <div class="card">
    <h2>🔀 分支对比（可选）</h2>
    <div class="diff-row" id="diffRow">
      <span class="diff-label">基准分支：</span>
      <span class="diff-branch" id="baseBranchLabel" style="background:#555">未选择</span>
      <span class="diff-arrow">→</span>
      <span class="diff-label">当前分支：</span>
      <span class="diff-branch" id="targetBranchLabel">-</span>
      <div class="action-row" style="margin-left:auto">
        <button class="btn btn-small btn-secondary" onclick="pickBaseBranch()">选择基准分支</button>
        <button class="btn btn-small btn-danger" onclick="clearBaseBranch()">清除</button>
      </div>
    </div>
    <div id="diffContent" style="display:none">
      <div class="diff-stats" id="diffStats"></div>
      <div class="diff-list-title">新增提交</div>
      <div class="diff-list" id="addedCommitsList"></div>
      <div class="diff-list-title">⚠️ 风险提交</div>
      <div class="diff-list" id="riskyCommitsList"></div>
      <div class="diff-list-title">最频繁变更文件</div>
      <div class="diff-list" id="changedFilesList"></div>
      <div class="diff-list-title">目标分支独有作者</div>
      <div class="diff-list" id="authorsOnlyInTargetList"></div>
    </div>
  </div>

  <div class="card">
    <h2>📊 数据概览</h2>
    <div class="loading show" id="loading">
      <div class="spinner">⏳</div>
      <div>正在加载数据...</div>
    </div>
    <div id="overviewData" style="display:none">
      <div class="stats-grid" id="statsGrid"></div>
      <div style="margin-top:10px">
        <div style="font-size:10px;color:#888;margin-bottom:5px;text-transform:uppercase">按分类统计</div>
        <div class="category-grid" id="categoryGrid"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>🧩 章节勾选（导出时仅包含勾选）</h2>
    <div class="section-list" id="sectionList"></div>
  </div>

  <div class="card">
    <h2>📖 改动故事线</h2>
    <div class="action-row" style="margin-bottom:8px">
      <button class="btn btn-secondary btn-small" onclick="generateStoryline()">📖 完整故事线</button>
      <button class="btn btn-secondary btn-small" onclick="copyStoryline()">📋 复制</button>
    </div>
    <div class="storyline-list" id="storylineList"></div>
  </div>

  <div class="card">
    <h2>💾 导出</h2>
    <div class="action-row">
      <button class="btn btn-primary" onclick="exportMarkdown()">📄 导出 Markdown</button>
      <button class="btn btn-secondary" onclick="exportJson()">📦 导出 JSON</button>
      <button class="btn btn-secondary btn-small" onclick="openDiff()">🔀 版本对比</button>
    </div>
    <p style="font-size:10px;color:#888;margin-top:6px">
      报告基于：<span id="currentBranchTip">-</span> · 模板：<span id="currentTemplateTip">-</span> · 共 <span id="sectionsCountTip">0</span> 个章节
    </p>
  </div>

  <div class="card">
    <h2>📝 报告预览</h2>
    <div class="preview-section">
      <pre id="reportPreview">等待生成预览...</pre>
    </div>
    <div class="preview-trunc-note" id="previewTruncNote" style="display:none"></div>
  </div>

<script>
  const vs = acquireVsCodeApi();
  function selectTemplate(tpl) { vs.postMessage({ command: 'selectTemplate', template: tpl }); }
  function toggleSection(sec) { vs.postMessage({ command: 'toggleSection', section: sec }); }
  function pickBaseBranch() { vs.postMessage({ command: 'pickBaseBranch' }); }
  function clearBaseBranch() { vs.postMessage({ command: 'clearBaseBranch' }); }
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
  setTimeout(doRefresh, 200);

  function esc(s) { return (s || '').toString().replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  document.addEventListener('click', function(e) {
    var commitRow = e.target.closest('[data-commit-hash]');
    if (commitRow) {
      vs.postMessage({ command: 'openCommitFromDiff', commitHash: commitRow.getAttribute('data-commit-hash') });
      return;
    }
    var fileRow = e.target.closest('[data-file-path]');
    if (fileRow) {
      vs.postMessage({ command: 'showFileHistoryFromDiff', filePath: fileRow.getAttribute('data-file-path') });
      return;
    }
  });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'showLoading') {
      document.getElementById('loading').classList.add('show');
      document.getElementById('overviewData').style.display = 'none';
      return;
    }
    if (msg.command === 'showError') {
      document.getElementById('loading').classList.remove('show');
      alert('错误: ' + msg.message);
      return;
    }
    if (msg.command !== 'updatePreview') return;
    const d = msg.data;
    document.getElementById('loading').classList.remove('show');
    document.getElementById('overviewData').style.display = '';

    document.querySelectorAll('.tpl-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tpl === d.currentTemplate);
    });

    const baseLbl = document.getElementById('baseBranchLabel');
    baseLbl.textContent = d.baseBranchForDiff || '未选择';
    baseLbl.style.background = d.baseBranchForDiff ? undefined : '#555';
    document.getElementById('targetBranchLabel').textContent = d.options.branch;

    const diffContent = document.getElementById('diffContent');
    if (d.diffSummary && d.baseBranchForDiff) {
      diffContent.style.display = '';
      const ds = d.diffSummary;
      document.getElementById('diffStats').innerHTML = \`
        <div class="diff-stat"><div class="diff-stat-num green">+\${ds.addedCommits.length}</div><div class="diff-stat-label">新增提交</div></div>
        <div class="diff-stat"><div class="diff-stat-num red">-\${ds.removedCommits.length}</div><div class="diff-stat-label">缺失提交</div></div>
        <div class="diff-stat"><div class="diff-stat-num orange">\${ds.authorsOnlyInTarget.length}</div><div class="diff-stat-label">独有作者</div></div>
        <div class="diff-stat"><div class="diff-stat-num purple">\${ds.riskyCommits.length}</div><div class="diff-stat-label">风险提交</div></div>
        <div class="diff-stat"><div class="diff-stat-num" style="color:#3794ff">\${ds.changedFiles.length}</div><div class="diff-stat-label">变更文件</div></div>
      \`;
      document.getElementById('addedCommitsList').innerHTML = ds.addedCommits.length === 0
        ? '<div class="empty-tip">无新增提交</div>'
        : ds.addedCommits.slice(0, 20).map(function(c) {
            return '<div class="clickable-row" data-commit-hash="' + c.hash + '">'
              + '<span class="hash">' + c.shortHash + '</span>'
              + '<span class="meta">' + esc(c.authorName) + ' · ' + new Date(c.date).toLocaleDateString('zh-CN') + '</span>'
              + '</div>'
              + '<div style="padding:0 7px 5px 32px;font-size:10px;color:#aaa">' + esc(c.message.substring(0, 80)) + '</div>';
          }).join('');
      document.getElementById('riskyCommitsList').innerHTML = ds.riskyCommits.length === 0
        ? '<div class="empty-tip">未识别到风险提交 ✅</div>'
        : ds.riskyCommits.map(function(c) {
            var files = c.stats && c.stats.totalFiles || 0;
            var adds = c.stats && c.stats.totalAdditions || 0;
            var dels = c.stats && c.stats.totalDeletions || 0;
            return '<div class="clickable-row risky-row" data-commit-hash="' + c.hash + '">'
              + '<span class="hash">⚠️ ' + c.shortHash + '</span>'
              + '<span class="meta">' + files + '文件 +' + adds + ' -' + dels + '</span>'
              + '</div>'
              + '<div style="padding:0 7px 5px 32px;font-size:10px;color:#aaa">' + esc(c.message.substring(0, 80)) + '</div>';
          }).join('');
      document.getElementById('changedFilesList').innerHTML = ds.changedFiles.length === 0
        ? '<div class="empty-tip">无变更文件</div>'
        : ds.changedFiles.slice(0, 30).map(function(f) {
            return '<div class="clickable-row" data-file-path="' + esc(f.filePath).replace(/"/g, '&quot;') + '">'
              + '<span class="path">' + esc(f.filePath) + '</span>'
              + '<span class="meta" style="color:#2ea043">+' + f.additions + '</span>'
              + '<span class="meta" style="color:#f48771">-' + f.deletions + '</span>'
              + '</div>';
          }).join('');
      document.getElementById('authorsOnlyInTargetList').innerHTML = ds.authorsOnlyInTarget.length === 0
        ? '<div class="empty-tip">两分支作者相同</div>'
        : ds.authorsOnlyInTarget.map(function(a) {
            return '<div class="clickable-row">'
              + '<span style="color:#3794ff;font-weight:600">' + esc(a.name) + '</span>'
              + '<span class="meta">' + a.commitCount + ' 提交</span>'
              + '</div>';
          }).join('');
    } else {
      diffContent.style.display = 'none';
    }

    document.getElementById('statsGrid').innerHTML = \`
      <div class="stat-item"><div class="stat-num">\${d.totalCommits}</div><div class="stat-label">提交</div></div>
      <div class="stat-item"><div class="stat-num">\${d.totalAuthors}</div><div class="stat-label">作者</div></div>
      <div class="stat-item"><div class="stat-num">\${d.hotFilesCount}</div><div class="stat-label">热文件</div></div>
      <div class="stat-item"><div class="stat-num">\${d.favoritesCount}</div><div class="stat-label">收藏</div></div>
      <div class="stat-item"><div class="stat-num">\${d.defectsCount}</div><div class="stat-label">缺陷</div></div>
      <div class="stat-item"><div class="stat-num" style="color:#f48771">\${d.highImpactCount}</div><div class="stat-label" style="color:#c07050">🔥大规模</div></div>
      <div class="stat-item"><div class="stat-num" style="color:#d4a72c">\${d.mediumImpactCount}</div><div class="stat-label" style="color:#b09020">⚡中等</div></div>
      <div class="stat-item"><div class="stat-num" style="color:#2ea043">\${d.lowImpactCount}</div><div class="stat-label" style="color:#30a060">✨小范围</div></div>
    \`;
    document.getElementById('categoryGrid').innerHTML = \`
      <div class="cat-item"><div class="cat-num" style="color:#2ea043">\${d.featureCount}</div>新功能</div>
      <div class="cat-item"><div class="cat-num" style="color:#f48771">\${d.fixCount}</div>缺陷修复</div>
      <div class="cat-item"><div class="cat-num" style="color:#a371f7">\${d.refactorCount}</div>重构</div>
      <div class="cat-item"><div class="cat-num" style="color:#3794ff">\${d.docsCount}</div>文档</div>
      <div class="cat-item"><div class="cat-num" style="color:#9e9e9e">\${d.choreCount}</div>维护</div>
      <div class="cat-item"><div class="cat-num" style="color:#757575">\${d.otherCount}</div>其他</div>
    \`;

    const countsBySection = {
      overview: d.totalCommits,
      branchDiff: d.diffSummary ? d.diffSummary.addedCommits.length : 0,
      authors: d.totalAuthors,
      hotFiles: d.hotFilesCount,
      storylines: d.storylinesCount,
      favorites: d.favoritesCount,
      defects: d.defectsCount,
      commitList: d.totalCommits
    };
    document.getElementById('sectionList').innerHTML = d.sectionsMeta.map(function(s) {
      var checked = d.selectedSections.indexOf(s.key) >= 0;
      var cnt = countsBySection[s.key] != null ? countsBySection[s.key] : 0;
      return '<label class="section-item">'
        + '<input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="toggleSection(\\'' + s.key + '\\')">'
        + '<div style="flex:1">'
        + '<div class="sec-label">' + esc(s.label) + '</div>'
        + '<div class="sec-desc">' + esc(s.description) + '</div>'
        + '</div>'
        + '<span class="sec-count">' + cnt + '</span>'
        + '</label>';
    }).join('');

    const catClr = { feature:'#2ea043', fix:'#f48771', refactor:'#a371f7', docs:'#3794ff', chore:'#9e9e9e', other:'#757575' };
    const catLabels = { feature:'新功能', fix:'缺陷修复', refactor:'重构', docs:'文档', chore:'维护', other:'其他' };
    document.getElementById('storylineList').innerHTML = d.storylines.length === 0
      ? '<div class="empty-tip">暂无故事线数据</div>'
      : d.storylines.map(function(s) {
          var impactClr = s.impact === 'high' ? '#f48771' : s.impact === 'medium' ? '#d29922' : '#2ea043';
          var impactIcon = s.impact === 'high' ? '🔥' : s.impact === 'medium' ? '⚡' : '✨';
          return '<div class="storyline-item" style="border-left-color:' + catClr[s.category] + '">'
            + '<div class="storyline-meta">'
            + new Date(s.commit.date).toLocaleDateString('zh-CN') + ' · ' + esc(s.commit.authorName) + ' · <span style="color:#3794ff">' + s.commit.shortHash + '</span>'
            + ' · <span style="color:' + impactClr + '">' + impactIcon + '</span>'
            + ' · <span style="color:' + catClr[s.category] + '">' + catLabels[s.category] + '</span>'
            + '</div>'
            + '<div>' + esc(s.narrative.substring(0, 240)) + (s.narrative.length > 240 ? '...' : '') + '</div>'
            + '</div>';
        }).join('');

    const pvn = document.getElementById('reportPreview');
    pvn.textContent = d.reportPreview + (d.reportIsTruncated ? '\\n\\n... (预览已截断，完整 ' + d.fullReportLength + ' 字符请通过导出 Markdown 查看)' : '');
    const tr = document.getElementById('previewTruncNote');
    if (d.reportIsTruncated) {
      tr.style.display = 'block';
      tr.textContent = '⚠️ 预览长度 ' + d.reportPreview.length + ' 字符（共 ' + d.fullReportLength + '），完整内容请导出 Markdown';
    } else {
      tr.style.display = 'none';
    }

    document.getElementById('currentBranchTip').textContent = d.options.branch;
    const tpl = d.templates.find(function(t) { return t.id === d.currentTemplate; });
    document.getElementById('currentTemplateTip').textContent = (tpl && tpl.label) || d.currentTemplate;
    document.getElementById('sectionsCountTip').textContent = d.selectedSections.length;
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
