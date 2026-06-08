import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { GitService } from './services/GitService';
import { StateService } from './services/StateService';
import { ReportService } from './services/ReportService';

import { CommitTimelineProvider, CommitItem, DateGroupItem, FileChangeItem } from './views/CommitTimelineView';
import { FileEvolutionProvider, HotFileItem, DeletedFileItem } from './views/FileEvolutionView';
import { AuthorProfileProvider, AuthorProfileItem } from './views/AuthorProfileView';
import { OverviewWebView } from './views/OverviewWebView';
import { LineBlameWebView } from './views/LineBlameWebView';
import { KeywordTrackingWebView } from './views/KeywordTrackingWebView';
import { ReportExportWebView } from './views/ReportExportWebView';

import { FilterOptions, DateRange, GitCommit } from './models/types';

let gitService: GitService;
let stateService: StateService;
let reportService: ReportService;

let timelineProvider: CommitTimelineProvider;
let fileEvolutionProvider: FileEvolutionProvider;
let authorProfileProvider: AuthorProfileProvider;

let overviewView: OverviewWebView;
let lineBlameView: LineBlameWebView;
let keywordTrackingView: KeywordTrackingWebView;
let reportExportView: ReportExportWebView;

let workspaceRoot: string;

export function activate(context: vscode.ExtensionContext): void {
  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders || wsFolders.length === 0) {
    vscode.window.showWarningMessage('Git 考古面板: 请先打开一个工作区');
    return;
  }

  workspaceRoot = wsFolders[0].uri.fsPath;
  const gitDir = path.join(workspaceRoot, '.git');
  if (!fs.existsSync(gitDir)) {
    vscode.window.showWarningMessage('Git 考古面板: 当前工作区不是 Git 仓库');
    return;
  }

  gitService = new GitService(workspaceRoot);
  stateService = new StateService(context, workspaceRoot);
  reportService = new ReportService(stateService);

  timelineProvider = new CommitTimelineProvider(gitService, stateService, reportService);
  fileEvolutionProvider = new FileEvolutionProvider(gitService, stateService);
  authorProfileProvider = new AuthorProfileProvider(gitService, stateService);

  overviewView = new OverviewWebView(context, gitService, stateService, reportService, workspaceRoot);
  lineBlameView = new LineBlameWebView(context, gitService, stateService, reportService, workspaceRoot);
  keywordTrackingView = new KeywordTrackingWebView(context, gitService, stateService, reportService, workspaceRoot);
  reportExportView = new ReportExportWebView(context, gitService, stateService, reportService, workspaceRoot);

  registerViews(context);
  registerCommands(context);

  loadInitialData().catch(err => {
    console.error('初始化数据加载失败:', err);
  });
}

function registerViews(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.createTreeView('gitArchaeologist.timeline', {
      treeDataProvider: timelineProvider,
      showCollapseAll: true
    })
  );

  context.subscriptions.push(
    vscode.window.createTreeView('gitArchaeologist.fileEvolution', {
      treeDataProvider: fileEvolutionProvider,
      showCollapseAll: true
    })
  );

  context.subscriptions.push(
    vscode.window.createTreeView('gitArchaeologist.authorProfile', {
      treeDataProvider: authorProfileProvider,
      showCollapseAll: true
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('gitArchaeologist.overview', overviewView)
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('gitArchaeologist.lineBlame', lineBlameView)
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('gitArchaeologist.keywordTracking', keywordTrackingView)
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('gitArchaeologist.reportExport', reportExportView)
  );
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitArchaeologist.refresh', async () => {
      await Promise.all([
        timelineProvider.loadCommits(),
        fileEvolutionProvider.loadData(),
        authorProfileProvider.loadData()
      ]);
      vscode.window.showInformationMessage('Git 考古数据已刷新');
    }),

    vscode.commands.registerCommand('gitArchaeologist.selectBranch', async () => {
      try {
        const branches = await gitService.getBranches();
        const localBranches = branches.filter(b => !b.isRemote);
        const items = localBranches.map(b => ({
          label: `${b.isCurrent ? '✓ ' : ''}🌿 ${b.name}`,
          description: b.lastCommitDate ? `更新于 ${formatShortDate(b.lastCommitDate)}` : '',
          branch: b.name
        }));

        const selected = await vscode.window.showQuickPick(items, {
          title: '选择分支',
          placeHolder: '输入搜索或选择一个分支'
        });

        if (selected) {
          stateService.setCurrentBranch(selected.branch);
          await Promise.all([
            timelineProvider.loadCommits(),
            fileEvolutionProvider.loadData(),
            authorProfileProvider.loadData()
          ]);
          vscode.window.showInformationMessage(`已切换到分支: ${selected.branch}`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`获取分支失败: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.setDateRange', async () => {
      const current = stateService.getDateRange();
      const startVal = current?.start || '';
      const endVal = current?.end || '';

      const startInput = await vscode.window.showInputBox({
        prompt: '开始日期 (YYYY-MM-DD)，留空表示不限制',
        value: startVal,
        validateInput: val => val && !/^\d{4}-\d{2}-\d{2}$/.test(val) ? '日期格式必须为 YYYY-MM-DD' : null
      });
      if (startInput === undefined) return;

      const endInput = await vscode.window.showInputBox({
        prompt: '结束日期 (YYYY-MM-DD)，留空表示到今天',
        value: endVal,
        validateInput: val => val && !/^\d{4}-\d{2}-\d{2}$/.test(val) ? '日期格式必须为 YYYY-MM-DD' : null
      });
      if (endInput === undefined) return;

      const range: DateRange = {};
      if (startInput) range.start = startInput;
      if (endInput) range.end = endInput;

      stateService.setDateRange(range);
      await timelineProvider.loadCommits();
      vscode.window.showInformationMessage(`日期范围: ${range.start || '不限'} ~ ${range.end || '不限'}`);
    }),

    vscode.commands.registerCommand('gitArchaeologist.filterByAuthor', async () => {
      try {
        const branchArg = stateService.getCurrentBranch() || undefined;
        const authors = await gitService.getAllAuthors(branchArg);
        const current = stateService.getAuthors();
        const items = authors.map(a => ({
          label: `${current.includes(a.name) ? '✓ ' : ''}👤 ${a.name}`,
          description: `${a.commitCount} 提交 · ${a.email}`,
          picked: current.includes(a.name),
          name: a.name
        }));

        const selected = await vscode.window.showQuickPick(items, {
          title: '筛选作者 (可多选，先取消已选)',
          canPickMany: true,
          placeHolder: '选择要筛选的作者，不选则显示全部'
        });

        if (selected) {
          const names = selected.map(s => s.name);
          stateService.setAuthors(names);
          await timelineProvider.loadCommits();
          vscode.window.showInformationMessage(names.length > 0 ? `已筛选 ${names.length} 位作者` : '已清除作者筛选');
        }
      } catch (err) {
        vscode.window.showErrorMessage(`获取作者列表失败: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.searchCommits', async () => {
      const current = stateService.getSearchTerm() || '';
      const input = await vscode.window.showInputBox({
        prompt: '输入关键词搜索提交说明，支持正则表达式',
        value: current,
        placeHolder: '例如: fix bug、feature、重构'
      });

      if (input !== undefined) {
        stateService.setSearchTerm(input);
        await timelineProvider.loadCommits();
        vscode.window.showInformationMessage(input ? `搜索: "${input}"` : '已清除搜索');
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.openCommit', async (hashOrItem?: string | CommitItem) => {
      let commitHash: string;
      if (hashOrItem instanceof CommitItem) {
        commitHash = hashOrItem.commit.hash;
      } else if (typeof hashOrItem === 'string') {
        commitHash = hashOrItem;
      } else {
        return;
      }

      try {
        let commit = timelineProvider.getCommitByHash(commitHash);
        if (!commit) {
          commit = await gitService.getSingleCommit(commitHash);
        }
        if (!commit) {
          commit = {
            hash: commitHash,
            shortHash: commitHash.substring(0, 7),
            message: '提交信息加载失败',
            authorName: '未知',
            authorEmail: '',
            date: '',
            body: '',
            timestamp: 0,
            parentHashes: [],
            files: [],
            stats: { totalFiles: 0, totalAdditions: 0, totalDeletions: 0 }
          };
        }

        const diff = await gitService.getDiff(commitHash);
        const fav = stateService.isFavorite(commitHash) ? '⭐' : '';
        const note = stateService.getNote(commitHash);
        const defects = stateService.getDefectIds(commitHash);

        const md = generateCommitMarkdown(commit || {
          hash: commitHash,
          shortHash: commitHash.substring(0, 7),
          message: '加载中...',
          authorName: '', authorEmail: '', date: '', body: '', timestamp: 0,
          parentHashes: [], files: [], stats: { totalFiles: 0, totalAdditions: 0, totalDeletions: 0 }
        }, diff, fav, note, defects);

        const panel = vscode.window.createWebviewPanel(
          'gitCommitDetail',
          `${fav}${commit?.shortHash || commitHash.substring(0, 7)} - 提交详情`,
          vscode.ViewColumn.One,
          { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.html = getCommitDetailHtml(md, commitHash);

        panel.webview.onDidReceiveMessage(async (msg) => {
          switch (msg.command) {
            case 'toggleFavorite':
              const isFav = stateService.toggleFavorite(commitHash);
              panel.title = `${isFav ? '⭐' : ''}${commit?.shortHash || commitHash.substring(0, 7)} - 提交详情`;
              panel.webview.postMessage({ command: 'favUpdated', isFav });
              timelineProvider.refresh();
              break;
            case 'addNote':
              const newNote = await vscode.window.showInputBox({
                prompt: '为此提交添加备注',
                value: stateService.getNote(commitHash) || ''
              });
              if (newNote !== undefined) {
                if (newNote) stateService.setNote(commitHash, newNote);
                else stateService.clearNote(commitHash);
                vscode.window.showInformationMessage('备注已更新');
                timelineProvider.refresh();
              }
              break;
            case 'linkDefect':
              const defInput = await vscode.window.showInputBox({
                prompt: '关联缺陷编号 (如 #1234、BUG-567)',
                placeHolder: '缺陷编号'
              });
              if (defInput) {
                stateService.addDefectId(commitHash, defInput);
                vscode.window.showInformationMessage(`已关联缺陷: ${defInput}`);
                timelineProvider.refresh();
              }
              break;
            case 'copyLink':
              const link = reportService.generateLocationLink(workspaceRoot, commitHash);
              await vscode.env.clipboard.writeText(link);
              vscode.window.showInformationMessage('定位链接已复制');
              break;
            case 'compareSelect':
              stateService.toggleSelected(commitHash);
              timelineProvider.refresh();
              vscode.window.showInformationMessage(
                stateService.isSelected(commitHash) ? '已加入比较，再选一个提交进行对比' : '已从比较中移除'
              );
              break;
            case 'copySha':
              await vscode.env.clipboard.writeText(commitHash);
              vscode.window.showInformationMessage('Commit SHA 已复制');
              break;
          }
        });
      } catch (err) {
        vscode.window.showErrorMessage(`打开提交失败: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.diffCommits', async () => {
      const selected = stateService.getSelectedCommits();
      let commit1: string | undefined;
      let commit2: string | undefined;

      if (selected.length === 2) {
        commit1 = selected[0];
        commit2 = selected[1];
      } else if (selected.length === 1) {
        const second = await promptForCommit('选择第二个提交进行比较', selected[0]);
        if (second) {
          commit1 = selected[0];
          commit2 = second;
        }
      } else {
        commit1 = await promptForCommit('选择第一个提交');
        if (commit1) {
          commit2 = await promptForCommit('选择第二个提交进行比较', commit1);
        }
      }

      if (!commit1 || !commit2) return;

      try {
        const diff = await gitService.getDiffBetweenCommits(commit1, commit2);
        showDiffPanel(commit1, commit2, diff);
      } catch (err) {
        vscode.window.showErrorMessage(`比较差异失败: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.showFileHistory', async (filePathOrItem?: string | HotFileItem, commitHash?: string) => {
      let filePath: string;
      if (filePathOrItem instanceof HotFileItem) {
        filePath = filePathOrItem.hotFile.filePath;
      } else if (typeof filePathOrItem === 'string') {
        filePath = filePathOrItem;
      } else {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('请先打开一个文件，或在文件演化视图中选择文件');
          return;
        }
        filePath = path.relative(workspaceRoot, editor.document.fileName);
      }

      try {
        const history = await gitService.getFileHistory(filePath, {
          branch: stateService.getCurrentBranch(),
          maxCommits: 100
        });

        if (history.length === 0) {
          vscode.window.showInformationMessage(`文件 "${filePath}" 没有历史记录`);
          return;
        }

        const items = history.map(h => ({
          label: `${h.status === 'A' ? '➕' : h.status === 'D' ? '🗑️' : h.status === 'M' ? '✏️' : h.status === 'R' ? '🔄' : '📝'} ${formatShortDate(h.date)} ${h.author}`,
          description: `+${h.additions}/-${h.deletions} | ${h.filePath}`,
          detail: h.message,
          hash: h.commitHash,
          filePath: h.filePath
        }));

        const picked = await vscode.window.showQuickPick(items, {
          title: `文件历史: ${filePath}`,
          matchOnDetail: true,
          placeHolder: '选择一个版本查看该时的内容'
        });

        if (picked) {
          try {
            const content = await gitService.getFileContentAtRevision(picked.filePath, picked.hash);
            const tempPath = path.join(workspaceRoot, '.git-archaeologist-tmp', `${picked.hash.substring(0, 8)}_${path.basename(picked.filePath)}`);
            const dir = path.dirname(tempPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(tempPath, content, 'utf-8');

            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tempPath));
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, true);
          } catch (err2) {
            vscode.commands.executeCommand('gitArchaeologist.openCommit', picked.hash);
          }
        }
      } catch (err) {
        vscode.window.showErrorMessage(`加载文件历史失败: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.showBlame', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('请先打开一个文件');
        return;
      }
      const filePath = path.relative(workspaceRoot, editor.document.fileName);
      await vscode.commands.executeCommand('gitArchaeologist.lineBlame.focus');
      await lineBlameView.setAndLoadFile(filePath);
    }),

    vscode.commands.registerCommand('gitArchaeologist.favoriteCommit', async (hashOrItem?: string | CommitItem) => {
      let commitHash: string;
      if (hashOrItem instanceof CommitItem) {
        commitHash = hashOrItem.commit.hash;
      } else if (typeof hashOrItem === 'string') {
        commitHash = hashOrItem;
      } else {
        return;
      }

      const isFav = stateService.toggleFavorite(commitHash);
      timelineProvider.refresh();
      vscode.window.showInformationMessage(isFav ? '⭐ 已收藏此提交' : '已取消收藏');
    }),

    vscode.commands.registerCommand('gitArchaeologist.addCommitNote', async (hashOrItem?: string | CommitItem) => {
      let commitHash: string;
      if (hashOrItem instanceof CommitItem) {
        commitHash = hashOrItem.commit.hash;
      } else if (typeof hashOrItem === 'string') {
        commitHash = hashOrItem;
      } else {
        return;
      }

      const currentNote = stateService.getNote(commitHash) || '';
      const input = await vscode.window.showInputBox({
        prompt: '添加/编辑备注 (提交信息备注)',
        value: currentNote,
        placeHolder: '输入备注内容...',
        ignoreFocusOut: true
      });

      if (input !== undefined) {
        if (input.trim()) {
          stateService.setNote(commitHash, input.trim());
        } else {
          stateService.clearNote(commitHash);
        }
        timelineProvider.refresh();
        vscode.window.showInformationMessage(input ? '备注已添加' : '备注已清除');
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.linkDefect', async (hashOrItem?: string | CommitItem) => {
      let commitHash: string;
      if (hashOrItem instanceof CommitItem) {
        commitHash = hashOrItem.commit.hash;
      } else if (typeof hashOrItem === 'string') {
        commitHash = hashOrItem;
      } else {
        return;
      }

      const currentDefects = stateService.getDefectIds(commitHash);
      const existing = currentDefects.length > 0
        ? `当前关联: ${currentDefects.join(', ')} | ` : '';

      const action = await vscode.window.showQuickPick([
        { label: '➕ 添加新缺陷编号', action: 'add' },
        ...currentDefects.map(d => ({ label: `❌ 移除: ${d}`, action: 'remove', defect: d }))
      ], {
        title: `${existing}管理缺陷关联`,
        placeHolder: '选择操作'
      });

      if (!action) return;

      if (action.action === 'add') {
        const input = await vscode.window.showInputBox({
          prompt: '输入缺陷编号 (如 #1234、BUG-567)',
          placeHolder: '缺陷编号'
        });
        if (input) {
          stateService.addDefectId(commitHash, input.trim());
          timelineProvider.refresh();
          vscode.window.showInformationMessage(`已关联缺陷: ${input.trim()}`);
        }
      } else if (action.action === 'remove' && action.defect) {
        stateService.removeDefectId(commitHash, action.defect);
        timelineProvider.refresh();
        vscode.window.showInformationMessage(`已取消关联: ${action.defect}`);
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.generateStoryline', async () => {
      try {
        const options = stateService.getFilterOptions();
        const commits = await gitService.getCommits(options);
        const storylines = reportService.generateStorylines(commits);

        let text = '# Git 仓库改动故事线\n\n';
        text += `> 生成时间: ${new Date().toLocaleString('zh-CN')}\n`;
        text += `> 分支: ${options.branch}\n`;
        if (options.dateRange) {
          text += `> 日期范围: ${options.dateRange.start || '不限'} ~ ${options.dateRange.end || '不限'}\n`;
        }
        if (options.authors.length > 0) {
          text += `> 作者: ${options.authors.join(', ')}\n`;
        }
        text += '\n';

        const high = storylines.filter(s => s.impact === 'high');
        const medium = storylines.filter(s => s.impact === 'medium');
        const low = storylines.filter(s => s.impact === 'low');

        for (const [label, list] of [
          ['🔥 大规模变更', high],
          ['⚡ 中等规模变更', medium],
          ['✨ 小范围变更', low]
        ] as [string, typeof storylines][]) {
          if (list.length > 0) {
            text += `## ${label} (${list.length})\n\n`;
            for (const s of list) {
              text += `- ${formatDate(s.commit.date)} ${s.narrative}\n`;
            }
            text += '\n';
          }
        }

        const doc = await vscode.workspace.openTextDocument({
          language: 'markdown',
          content: text
        });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

      } catch (err) {
        vscode.window.showErrorMessage(`生成故事线失败: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.exportReport', async () => {
      try {
        const options = stateService.getFilterOptions();
        const branchArg = options.branch || undefined;
        const [repoInfo, commits, hotFiles, authors] = await Promise.all([
          gitService.getRepositoryInfo(branchArg),
          gitService.getCommits(options),
          gitService.getHotFiles(20, branchArg),
          gitService.getAllAuthors(branchArg)
        ]);

        const md = reportService.generateMarkdownReport(repoInfo, commits, options, hotFiles, authors);

        const defaultPath = path.join(
          workspaceRoot,
          `git-archaeologist-report-${new Date().toISOString().substring(0, 10)}.md`
        );

        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(defaultPath),
          filters: { 'Markdown': ['md'] }
        });

        if (!uri) return;

        fs.writeFileSync(uri.fsPath, md, 'utf-8');
        vscode.window.showInformationMessage(`报告已导出: ${uri.fsPath}`);

        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        vscode.window.showErrorMessage(`导出报告失败: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.copyLocationLink', async (hashOrItem?: string | CommitItem) => {
      let commitHash: string;
      if (hashOrItem instanceof CommitItem) {
        commitHash = hashOrItem.commit.hash;
      } else if (typeof hashOrItem === 'string') {
        commitHash = hashOrItem;
      } else {
        return;
      }

      const link = reportService.generateLocationLink(workspaceRoot, commitHash);
      await vscode.env.clipboard.writeText(link);
      vscode.window.showInformationMessage('定位链接已复制到剪贴板');
    }),

    vscode.commands.registerCommand('gitArchaeologist.viewDeletedFile', async (fileOrItem?: string | DeletedFileItem) => {
      let filePath: string;
      let deletedInCommit: string | undefined;

      if (fileOrItem instanceof DeletedFileItem) {
        filePath = fileOrItem.deletedFile.filePath;
        deletedInCommit = fileOrItem.deletedFile.deletedInCommit;
      } else if (typeof fileOrItem === 'string') {
        filePath = fileOrItem;
      } else {
        const branchArg = stateService.getCurrentBranch() || undefined;
        const deleted = await gitService.getDeletedFiles(branchArg);
        const pick = await vscode.window.showQuickPick(
          deleted.map(d => ({
            label: `🗑️ ${d.filePath}`,
            description: `${formatShortDate(d.deletedDate)} by ${d.deletedBy}`,
            filePath: d.filePath,
            commit: d.deletedInCommit
          })),
          { title: '选择要查看的已删除文件', matchOnDescription: true }
        );
        if (!pick) return;
        filePath = pick.filePath;
        deletedInCommit = pick.commit;
      }

      try {
        const { content, foundRevision } = await gitService.restoreDeletedFileContent(filePath, deletedInCommit);

        if (!content || content.trim().length === 0) {
          vscode.window.showWarningMessage(
            `未能找到 "${filePath}" 在 ${foundRevision ? '版本 ' + foundRevision.substring(0, 7) : '任何历史版本'} 中的有效内容`
          );
        }

        const tag = foundRevision ? foundRevision.replace(/[~^]/g, '-').substring(0, 12) : 'unknown';
        const tempPath = path.join(workspaceRoot, '.git-archaeologist-tmp', `DELETED_${tag}_${path.basename(filePath)}`);
        const dir = path.dirname(tempPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tempPath, content, 'utf-8');

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tempPath));
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, true);
      } catch (err) {
        vscode.window.showErrorMessage(`无法恢复文件内容: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('gitArchaeologist.showHotFiles', async () => {
      try {
        const branchArg = stateService.getCurrentBranch() || undefined;
        const hotFiles = await gitService.getHotFiles(50, branchArg);
        const threshold = stateService.getConfigHotFileThreshold();
        const hot = hotFiles.filter(f => f.changeCount >= threshold);

        const items = hot.map((hf, idx) => {
          const icon = hf.changeCount >= 50 ? '🔥🔥🔥' : hf.changeCount >= 20 ? '🔥🔥' : hf.changeCount >= 10 ? '🔥' : '';
          return {
            label: `${idx + 1}. ${icon} ${path.basename(hf.filePath)}`,
            description: `${hf.changeCount} 次 · ${hf.authors.length} 作者`,
            detail: hf.filePath,
            filePath: hf.filePath,
            changeCount: hf.changeCount
          };
        });

        if (items.length === 0) {
          vscode.window.showInformationMessage(`暂无修改次数 ≥ ${threshold} 的高频文件`);
          return;
        }

        const picked = await vscode.window.showQuickPick(items, {
          title: `🔥 高频修改文件 (≥${threshold}次, 共${hot.length}个)`,
          matchOnDetail: true
        });

        if (picked) {
          vscode.commands.executeCommand('gitArchaeologist.showFileHistory', picked.filePath);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`加载高频文件失败: ${err instanceof Error ? err.message : err}`);
      }
    })
  );
}

async function loadInitialData(): Promise<void> {
  try {
    const currentBranch = await gitService.getCurrentBranch();
    stateService.setCurrentBranch(currentBranch);

    await Promise.all([
      timelineProvider.loadCommits(),
      fileEvolutionProvider.loadData(),
      authorProfileProvider.loadData()
    ]);
  } catch (err) {
    console.error('Initial data load error:', err);
  }
}

async function promptForCommit(title: string, exclude?: string): Promise<string | undefined> {
  const options = stateService.getFilterOptions();
  const commits = await gitService.getCommits(options);

  const items = commits
    .filter(c => !exclude || c.hash !== exclude)
    .map(c => ({
      label: `${c.shortHash} ${formatShortDate(c.date)} ${c.authorName}: ${c.message}`,
      description: `+${c.stats?.totalAdditions || 0} -${c.stats?.totalDeletions || 0} · ${c.stats?.totalFiles || 0} 文件`,
      hash: c.hash
    }));

  const picked = await vscode.window.showQuickPick(items, {
    title,
    matchOnDescription: true
  });

  return picked?.hash;
}

function showDiffPanel(commit1: string, commit2: string, diff: string): void {
  const panel = vscode.window.createWebviewPanel(
    'gitDiffView',
    `差异对比: ${commit1.substring(0, 7)} ↔ ${commit2.substring(0, 7)}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  const diffHtml = formatDiffToHtml(diff);
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px; padding: 16px; background: var(--vscode-editor-background, #fff); color: var(--vscode-editor-foreground, #333); }
    h1 { font-size: 14px; margin-bottom: 12px; font-family: sans-serif; }
    .diff-meta { margin-bottom: 16px; padding: 10px; background: var(--vscode-editor-inactiveSelectionBackground, #f5f5f5); border-radius: 6px; font-family: sans-serif; font-size: 12px; }
    .file-block { margin-bottom: 20px; border: 1px solid var(--vscode-panel-border, #ddd); border-radius: 6px; overflow: hidden; }
    .file-header {
      padding: 8px 12px; background: var(--vscode-editor-inactiveSelectionBackground, #f5f5f5);
      border-bottom: 1px solid var(--vscode-panel-border, #ddd);
      font-family: sans-serif; font-weight: 600; font-size: 12px;
    }
    .diff-content { white-space: pre; overflow-x: auto; }
    .diff-line { padding: 0 8px 0 60px; position: relative; min-height: 18px; }
    .diff-line::before {
      content: attr(data-line);
      position: absolute; left: 8px; top: 0;
      width: 40px; text-align: right;
      color: var(--vscode-editorLineNumber-foreground, #999);
      font-size: 11px;
    }
    .diff-line.add { background: rgba(46, 160, 67, 0.15); color: #2ea043; border-left: 3px solid #2ea043; }
    .diff-line.del { background: rgba(218, 54, 51, 0.15); color: #da3633; border-left: 3px solid #da3633; }
    .diff-line.hunk { background: var(--vscode-textBlockQuote-background, #f0f8ff); color: #1f6feb; border-left: 3px solid #1f6feb; font-weight: 600; }
    .diff-line.info { color: #888; }
    .empty-note { padding: 40px; text-align: center; color: #888; font-family: sans-serif; }
  </style></head><body>
    <h1>🔀 版本差异对比</h1>
    <div class="diff-meta">
      <div><strong>提交 A:</strong> <code>${commit1.substring(0, 12)}</code> ... <strong>提交 B:</strong> <code>${commit2.substring(0, 12)}</code></div>
      <div style="margin-top:4px;font-size:11px;color:#888">绿色 = B 中新增, 红色 = B 中删除</div>
    </div>
    ${diffHtml || '<div class="empty-note">两个提交之间没有差异</div>'}
  </body></html>`;
}

function formatDiffToHtml(diff: string): string {
  if (!diff.trim()) return '';
  const lines = diff.split('\n');
  let html = '';
  let inFile = false;
  let fileHeader = '';
  let fileContent = '';

  const flushFile = () => {
    if (inFile) {
      html += `<div class="file-block"><div class="file-header">${fileHeader}</div><div class="diff-content">${fileContent}</div></div>`;
    }
    inFile = false;
    fileHeader = '';
    fileContent = '';
  };

  let lineNum = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      flushFile();
      inFile = true;
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      fileHeader = match ? `📄 ${match[1]}${match[1] !== match[2] ? ' → ' + match[2] : ''}` : line;
      lineNum = 0;
      continue;
    }

    if (!inFile) continue;

    if (line.startsWith('@@')) {
      lineNum++;
      fileContent += `<div class="diff-line hunk" data-line="...">${escapeHtml(line)}</div>`;
      continue;
    }

    if (line.startsWith('+')) {
      lineNum++;
      fileContent += `<div class="diff-line add" data-line="+">${escapeHtml(line.substring(1)) || ' '}</div>`;
    } else if (line.startsWith('-')) {
      fileContent += `<div class="diff-line del" data-line="-">${escapeHtml(line.substring(1)) || ' '}</div>`;
    } else if (line.startsWith(' ') || line === '') {
      lineNum++;
      fileContent += `<div class="diff-line" data-line=" ">${escapeHtml(line.substring(1)) || ' '}</div>`;
    } else {
      fileContent += `<div class="diff-line info" data-line="">${escapeHtml(line)}</div>`;
    }
  }

  flushFile();
  return html;
}

function generateCommitMarkdown(commit: any, diff: string, fav: string, note: string | undefined, defects: string[]): string {
  const { shortHash, authorName, authorEmail, date, message, body, stats } = commit;
  let md = `# ${fav}${shortHash} - ${message}\n\n`;

  md += `| 属性 | 值 |\n| --- | --- |\n`;
  md += `| 完整哈希 | \`${commit.hash}\` |\n`;
  md += `| 作者 | **${authorName}** \`<${authorEmail}>\` |\n`;
  md += `| 时间 | ${formatDate(date)} |\n`;

  if (stats) {
    md += `| 变更统计 | ${stats.totalFiles} 文件 · **+${stats.totalAdditions}** 行 · **-${stats.totalDeletions}** 行 |\n`;
  }
  if (commit.parentHashes?.length > 0) {
    md += `| 父提交 | ${commit.parentHashes.map((h: string) => `\`${h.substring(0, 12)}\``).join(', ')} |\n`;
  }
  md += '\n';

  if (body && body.trim()) {
    md += `## 📝 提交说明\n\n${body}\n\n`;
  }

  if (note) {
    md += `## 📌 备注\n\n${note}\n\n`;
  }

  if (defects.length > 0) {
    md += `## 🐞 关联缺陷\n\n`;
    for (const d of defects) {
      const url = reportService.getDefectUrl(d);
      md += url ? `- [${d}](${url})\n` : `- ${d}\n`;
    }
    md += '\n';
  }

  if (commit.files && commit.files.length > 0) {
    md += `## 📁 变更文件 (${commit.files.length})\n\n`;
    md += `| 状态 | 文件 | +/- |\n| --- | --- | --- |\n`;
    for (const f of commit.files) {
      const status = f.status === 'A' ? '➕新增' : f.status === 'D' ? '🗑️删除' : f.status === 'M' ? '✏️修改' : f.status === 'R' ? '🔄重命名' : f.status;
      const pathText = f.oldFilePath ? `~~${f.oldFilePath}~~ → ${f.filePath}` : f.filePath;
      md += `| ${status} | \`${pathText}\` | +${f.additions} / -${f.deletions} |\n`;
    }
    md += '\n';
  }

  md += `## 🔀 代码差异\n\n`;
  md += '```diff\n' + diff.substring(0, 20000) + '\n```\n';
  if (diff.length > 20000) {
    md += `\n> 差异内容过长已截断，完整内容请使用 Git 命令查看。\n`;
  }

  return md;
}

function getCommitDetailHtml(md: string, commitHash: string): string {
  const converter = `
    function mdToHtml(md) {
      let html = md
        .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
        .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
        .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
        .replace(/^### (.*)$/gm, '<h3>$1</h3>')
        .replace(/^## (.*)$/gm, '<h2>$1</h2>')
        .replace(/^# (.*)$/gm, '<h1>$1</h1>')
        .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*(.*?)\\*/g, '<em>$1</em>')
        .replace(/\`\`\`diff\\n([\\s\\S]*?)\\n\`\`\`/g, function(m, code) {
          return '<pre class="diff-block" style="background:#f8f8f8;padding:12px;border-radius:6px;overflow-x:auto;font-family:Consolas,monospace;font-size:11px;white-space:pre">' + highlightDiff(code) + '</pre>';
        })
        .replace(/\`([^\`]+)\`/g, '<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-family:Consolas,monospace">$1</code>')
        .replace(/^> (.*)$/gm, '<blockquote style="border-left:3px solid #ccc;margin:10px 0;padding:6px 12px;color:#666;background:#f9f9f9">$1</blockquote>')
        .replace(/^\\|(.*)\\|\\s*$/gm, function(line) { return line; })
        .replace(/^- (.*)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\\/li>)(\\n|$)/g, '<ul>$1</ul>')
        .replace(/\\n\\n/g, '</p><p style="margin:8px 0">')
        .replace(/\\n/g, '<br>');
      return '<p style="margin:8px 0">' + html + '</p>';
    }
    function highlightDiff(code) {
      return code.split('\\n').map(l => {
        if (l.startsWith('+')) return '<span style="color:#2ea043">' + escapeHtml(l) + '</span>';
        if (l.startsWith('-')) return '<span style="color:#da3633">' + escapeHtml(l) + '</span>';
        if (l.startsWith('@@')) return '<span style="color:#1f6feb;font-weight:bold">' + escapeHtml(l) + '</span>';
        return escapeHtml(l);
      }).join('\\n');
    }
    function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    const html = mdToHtml(rawMd);
    document.getElementById('content').innerHTML = html;
  `;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      padding: 20px;
      font-size: 13px;
      color: var(--vscode-editor-foreground, #333);
      background: var(--vscode-editor-background, #fff);
      line-height: 1.6;
      max-width: 1000px;
      margin: 0 auto;
    }
    .toolbar {
      position: sticky; top: 0; z-index: 100;
      background: var(--vscode-editor-background, #fff);
      padding: 10px 0 14px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--vscode-panel-border, #ddd);
      display: flex; gap: 6px; flex-wrap: wrap;
    }
    .btn {
      padding: 6px 12px; border: 1px solid var(--vscode-panel-border, #ccc);
      background: var(--vscode-button-secondaryBackground, #f0f0f0);
      color: var(--vscode-button-secondaryForeground, #333);
      border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    .btn:hover { background: var(--vscode-list-hoverBackground, #e8e8e8); }
    .btn.primary { background: var(--vscode-button-background, #0078d4); color: white; border-color: #0078d4; }
    h1 { font-size: 18px; margin: 14px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--vscode-panel-border, #ddd); }
    h2 { font-size: 14px; margin: 16px 0 10px; color: var(--vscode-descriptionForeground, #666); text-transform: uppercase; }
    h3, h4, h5, h6 { font-size: 13px; margin: 12px 0 8px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th, td { border: 1px solid var(--vscode-panel-border, #ddd); padding: 6px 10px; text-align: left; font-size: 12px; }
    th { background: var(--vscode-editor-inactiveSelectionBackground, #f5f5f5); font-weight: 600; }
    ul { margin: 6px 0 6px 22px; }
    li { margin: 3px 0; }
    a { color: var(--vscode-textLink-activeForeground, #0078d4); }
    h2 + table { margin-top: 4px; }
    #content { padding-top: 8px; }
  </style></head><body>
    <div class="toolbar">
      <button class="btn" id="favBtn" onclick="toggleFav()">⭐ 收藏</button>
      <button class="btn" onclick="addNote()">📝 备注</button>
      <button class="btn" onclick="linkDef()">🐞 关联缺陷</button>
      <button class="btn" onclick="copyLink()">🔗 复制链接</button>
      <button class="btn" onclick="copySha()">📋 复制 SHA</button>
      <button class="btn primary" onclick="toggleCompare()">🔀 加入对比</button>
    </div>
    <div id="content"></div>
    <script>
      const vs = acquireVsCodeApi();
      const rawMd = \`${md.replace(/`/g, '\\`').replace(/\\/g, '\\\\').replace(/\$/g, '\\$')}\`;
      const hash = '${commitHash}';
      ${converter}
      function toggleFav() { vs.postMessage({ command: 'toggleFavorite' }); }
      function addNote() { vs.postMessage({ command: 'addNote' }); }
      function linkDef() { vs.postMessage({ command: 'linkDefect' }); }
      function copyLink() { vs.postMessage({ command: 'copyLocationLink' }); }
      function copySha() { vs.postMessage({ command: 'copySha' }); }
      function toggleCompare() { vs.postMessage({ command: 'compareSelect' }); }
      window.addEventListener('message', e => {
        if (e.data.command === 'favUpdated') {
          document.getElementById('favBtn').textContent = e.data.isFav ? '⭐ 已收藏' : '⭐ 收藏';
        }
      });
    </script>
  </body></html>`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch {
    return dateStr;
  }
}

function formatShortDate(dateStr: string): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return dateStr.substring(0, 16);
  }
}

function escapeHtml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function deactivate(): void {
  // No cleanup needed
}
