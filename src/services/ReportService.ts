import { GitCommit, StorylineEntry, ReportData, FilterOptions, HotFile, ReportTemplate, ReportSectionKey, BranchDiffSummary, ReportGenerateOptions } from '../models/types';
import { StateService } from './StateService';

const REPORT_TEMPLATES: Record<ReportTemplate, {
  label: string;
  description: string;
  defaultSections: ReportSectionKey[];
  reportTitle: string;
}> = {
  handoff: {
    label: '交接概览',
    description: '适合项目交接，强调仓库全貌、作者贡献与代码热点，快速帮助接手人了解项目',
    defaultSections: ['overview', 'authors', 'hotFiles', 'storylines', 'commitList'],
    reportTitle: '项目交接 - Git 考古报告'
  },
  defect: {
    label: '缺陷排查',
    description: '追踪缺陷来源，突出可疑提交、风险变更、关联缺陷与关键代码改动',
    defaultSections: ['overview', 'branchDiff', 'favorites', 'defects', 'storylines', 'hotFiles'],
    reportTitle: '缺陷排查 - Git 考古报告'
  },
  release: {
    label: '发布回顾',
    description: '用于版本发布前复盘，突出新增提交、分支差异、作者参与与高频风险文件',
    defaultSections: ['overview', 'branchDiff', 'authors', 'storylines', 'hotFiles', 'commitList'],
    reportTitle: '发布回顾 - Git 考古报告'
  }
};

const ALL_SECTIONS: { key: ReportSectionKey; label: string; description: string }[] = [
  { key: 'overview', label: '仓库概览与筛选条件', description: '仓库元信息、提交总数、当前筛选条件' },
  { key: 'branchDiff', label: '分支对比摘要', description: '与基准分支的差异：新增提交、独有作者、变更文件、风险提交' },
  { key: 'authors', label: '作者贡献排行', description: '作者提交数排行、参与度与占比' },
  { key: 'hotFiles', label: '高频修改文件', description: '修改最频繁的文件 TOP N 与参与作者数' },
  { key: 'storylines', label: '改动故事线', description: '按影响规模分类的变更叙述，帮助理解演化脉络' },
  { key: 'favorites', label: '收藏的可疑提交', description: '手动标记的重点/可疑提交完整详情' },
  { key: 'defects', label: '缺陷统计', description: '从提交信息和手动关联中提取的缺陷编号 TOP' },
  { key: 'commitList', label: '完整提交列表', description: '按当前筛选条件的完整提交明细表' }
];

export class ReportService {
  private stateService: StateService;

  constructor(stateService: StateService) {
    this.stateService = stateService;
  }

  getAvailableTemplates(): { id: ReportTemplate; label: string; description: string }[] {
    return (Object.keys(REPORT_TEMPLATES) as ReportTemplate[]).map(id => ({
      id,
      label: REPORT_TEMPLATES[id].label,
      description: REPORT_TEMPLATES[id].description
    }));
  }

  getTemplateDefaultSections(template: ReportTemplate): ReportSectionKey[] {
    return [...REPORT_TEMPLATES[template].defaultSections];
  }

  getAllSectionsMeta(): { key: ReportSectionKey; label: string; description: string }[] {
    return ALL_SECTIONS;
  }

  generateStorylines(commits: GitCommit[]): StorylineEntry[] {
    const storylines: StorylineEntry[] = [];

    for (const commit of commits) {
      const category = this.categorizeCommit(commit);
      const impact = this.assessImpact(commit);
      const narrative = this.generateNarrative(commit, category, impact);

      storylines.push({
        commit,
        category,
        impact,
        narrative
      });
    }

    return storylines;
  }

  private categorizeCommit(commit: GitCommit): StorylineEntry['category'] {
    const msg = commit.message.toLowerCase();
    const body = (commit.body || '').toLowerCase();
    const combined = msg + ' ' + body;

    const testPatterns = [/\bfix\b/, /\bbug\b/, /\b错误\b/, /\b修复\b/, /\bissue\b/, /\b解决\b/];
    const featurePatterns = [/\bfeat\b/, /\bfeature\b/, /\b新增\b/, /\b添加\b/, /\badd\b/, /\b新功能\b/, /\b实现\b/, /\bintroduc\w*\b/];
    const refactorPatterns = [/\brefactor\b/, /\b重构\b/, /\brework\b/, /\bclean\s*up\b/, /\b清理\b/, /\b优化\b/, /\boptimiz\w*\b/];
    const docsPatterns = [/\bdocs\b/, /\bdoc\b/, /\b文档\b/, /\bcomment\b/, /\b注释\b/, /\breadme\b/];
    const chorePatterns = [/\bchore\b/, /\bbuild\b/, /\bci\b/, /\b升级\b/, /\bupgrade\b/, /\b依赖\b/, /\bdepend\w*\b/, /\bmerge\b/, /\b合并\b/];

    for (const p of testPatterns) {
      if (p.test(combined)) return 'fix';
    }
    for (const p of featurePatterns) {
      if (p.test(combined)) return 'feature';
    }
    for (const p of refactorPatterns) {
      if (p.test(combined)) return 'refactor';
    }
    for (const p of docsPatterns) {
      if (p.test(combined)) return 'docs';
    }
    for (const p of chorePatterns) {
      if (p.test(combined)) return 'chore';
    }

    return 'other';
  }

  private assessImpact(commit: GitCommit): StorylineEntry['impact'] {
    if (!commit.stats) return 'low';

    const totalChanges = commit.stats.totalAdditions + commit.stats.totalDeletions;
    const fileCount = commit.stats.totalFiles;

    if (fileCount > 20 || totalChanges > 500) return 'high';
    if (fileCount > 5 || totalChanges > 100) return 'medium';
    return 'low';
  }

  private generateNarrative(commit: GitCommit, category: StorylineEntry['category'], impact: StorylineEntry['impact']): string {
    const categoryLabels: Record<StorylineEntry['category'], string> = {
      feature: '新功能',
      fix: '缺陷修复',
      refactor: '代码重构',
      docs: '文档更新',
      chore: '日常维护',
      other: '代码变更'
    };

    const impactLabels: Record<StorylineEntry['impact'], string> = {
      high: '大规模',
      medium: '中等规模',
      low: '小范围'
    };

    let narrative = `${commit.authorName} 在 ${this.formatDate(commit.date)} 提交了一次${impactLabels[impact]}${categoryLabels[category]}`;

    if (commit.stats) {
      narrative += `。此次变更涉及 ${commit.stats.totalFiles} 个文件，新增 ${commit.stats.totalAdditions} 行，删除 ${commit.stats.totalDeletions} 行。`;
    }

    const defects = this.stateService.getDefectIds(commit.hash);
    if (defects.length > 0) {
      narrative += `关联缺陷：${defects.join('、')}。`;
    }

    const note = this.stateService.getNote(commit.hash);
    if (note) {
      narrative += `备注：${note}。`;
    }

    narrative += `提交说明：${commit.message}。`;

    return narrative;
  }

  extractDefectsFromMessage(message: string, body?: string): string[] {
    const pattern = this.stateService.getConfigDefectPattern();
    const combined = (message + ' ' + (body || '')).trim();
    const matches = combined.match(pattern);
    if (matches) {
      return Array.from(new Set(matches));
    }
    return [];
  }

  getDefectUrl(defectId: string): string | null {
    const template = this.stateService.getConfigDefectUrlTemplate();
    if (!template) return null;

    const numericMatch = defectId.match(/\d+/);
    const id = numericMatch ? numericMatch[0] : defectId;
    return template.replace('{id}', id);
  }

  computeTopDefects(commits: GitCommit[]): { id: string; count: number }[] {
    const allDefects = new Map<string, number>();
    for (const commit of commits) {
      const defects = this.extractDefectsFromMessage(commit.message, commit.body);
      const linked = this.stateService.getDefectIds(commit.hash);
      [...defects, ...linked].forEach(d => {
        allDefects.set(d, (allDefects.get(d) || 0) + 1);
      });
    }
    return Array.from(allDefects.entries())
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count);
  }

  computeCommitsByAuthor(
    authors: { name: string; email: string; commitCount: number }[]
  ): { name: string; count: number }[] {
    return authors
      .map(a => ({ name: a.name, count: a.commitCount }))
      .sort((a, b) => b.count - a.count);
  }

  generateMarkdownReport(
    repoInfo: { name: string; rootPath: string; totalCommits: number; firstCommitDate: string; lastCommitDate: string; defaultBranch: string; remoteUrl?: string },
    commits: GitCommit[],
    filterOptions: FilterOptions,
    hotFiles: HotFile[],
    authors: { name: string; email: string; commitCount: number }[],
    options: ReportGenerateOptions = { template: 'handoff', sections: ALL_SECTIONS.map(s => s.key) },
    diffSummary?: BranchDiffSummary
  ): string {
    const generatedAt = new Date().toISOString();
    const storylines = this.generateStorylines(commits);
    const favorites = commits.filter(c => this.stateService.isFavorite(c.hash));
    const defectsByCount = this.computeTopDefects(commits);
    const commitsByAuthor = this.computeCommitsByAuthor(authors);
    const templateMeta = REPORT_TEMPLATES[options.template];
    const sections = options.sections.length > 0 ? options.sections : templateMeta.defaultSections;

    const hasSection = (key: ReportSectionKey) => sections.includes(key);

    let md = `# ${templateMeta.reportTitle}\n\n`;
    md += `> 生成时间：${this.formatDate(generatedAt)}\n`;
    md += `> 模板类型：${templateMeta.label}（${templateMeta.description}）\n\n`;

    if (hasSection('overview')) {
      md += `## 仓库概览\n\n`;
      md += `| 项目 | 值 |\n`;
      md += `| --- | --- |\n`;
      md += `| 仓库名称 | ${repoInfo.name} |\n`;
      md += `| 本地路径 | \`${repoInfo.rootPath}\` |\n`;
      md += `| 当前分支 | ${filterOptions.branch} |\n`;
      if (repoInfo.remoteUrl) {
        md += `| 远程仓库 | ${repoInfo.remoteUrl} |\n`;
      }
      md += `| 总提交数 | ${repoInfo.totalCommits.toLocaleString()} |\n`;
      md += `| 首次提交 | ${this.formatDate(repoInfo.firstCommitDate)} |\n`;
      md += `| 最近提交 | ${this.formatDate(repoInfo.lastCommitDate)} |\n`;
      md += `| 筛选提交数 | ${commits.length} |\n\n`;

      md += `### 筛选条件\n\n`;
      md += `- 分支：${filterOptions.branch}\n`;
      md += `- 最大提交数：${filterOptions.maxCommits}\n`;
      if (filterOptions.dateRange?.start || filterOptions.dateRange?.end) {
        md += `- 日期范围：${filterOptions.dateRange.start || '不限'} ~ ${filterOptions.dateRange.end || '不限'}\n`;
      }
      if (filterOptions.authors && filterOptions.authors.length > 0) {
        md += `- 作者：${filterOptions.authors.join('、')}\n`;
      }
      if (filterOptions.searchTerm) {
        md += `- 搜索关键词：${filterOptions.searchTerm}\n`;
      }
      md += `\n`;
    }

    if (hasSection('branchDiff') && diffSummary) {
      md += `## 分支对比摘要 (${diffSummary.baseBranch} → ${diffSummary.targetBranch})\n\n`;
      md += `- **新增提交数**：${diffSummary.addedCommits.length}\n`;
      md += `- **回退/缺失提交数**：${diffSummary.removedCommits.length}\n`;
      md += `- **目标分支独有作者**：${diffSummary.authorsOnlyInTarget.length}\n`;
      md += `- **变更文件数**：${diffSummary.changedFiles.length}\n`;
      md += `- **风险提交数**：${diffSummary.riskyCommits.length}\n\n`;

      if (diffSummary.addedCommits.length > 0) {
        md += `### 新增提交 TOP 20\n\n`;
        md += `| 哈希 | 日期 | 作者 | 说明 |\n`;
        md += `| --- | --- | --- | --- |\n`;
        for (const commit of diffSummary.addedCommits.slice(0, 20)) {
          const msg = commit.message.replace(/\|/g, '\\|').replace(/\n/g, ' ');
          md += `| \`${commit.shortHash}\` | ${this.formatDate(commit.date)} | ${commit.authorName} | ${msg} |\n`;
        }
        md += `\n`;
      }

      if (diffSummary.authorsOnlyInTarget.length > 0) {
        md += `### 目标分支独有作者\n\n`;
        md += `| 作者 | 提交数 | 邮箱 |\n`;
        md += `| --- | --- | --- |\n`;
        for (const a of diffSummary.authorsOnlyInTarget.slice(0, 20)) {
          md += `| ${a.name} | ${a.commitCount} | ${a.email} |\n`;
        }
        md += `\n`;
      }

      if (diffSummary.changedFiles.length > 0) {
        md += `### 最频繁变更文件 TOP 20\n\n`;
        md += `| 文件 | 新增行 | 删除行 |\n`;
        md += `| --- | --- | --- |\n`;
        for (const f of diffSummary.changedFiles.slice(0, 20)) {
          md += `| \`${f.filePath}\` | +${f.additions} | -${f.deletions} |\n`;
        }
        md += `\n`;
      }

      if (diffSummary.riskyCommits.length > 0) {
        md += `### ⚠️ 风险提交\n\n`;
        for (const commit of diffSummary.riskyCommits) {
          md += `- **${commit.shortHash}** ${commit.authorName} · ${this.formatDate(commit.date)}\n`;
          md += `  - 说明：${commit.message}\n`;
          md += `  - 规模：${commit.stats?.totalFiles || 0} 文件，+${commit.stats?.totalAdditions || 0} -${commit.stats?.totalDeletions || 0}\n\n`;
        }
      }
    }

    if (hasSection('authors')) {
      md += `## 作者贡献排行\n\n`;
      md += `| 排名 | 作者 | 提交数 | 占比 |\n`;
      md += `| --- | --- | --- | --- |\n`;
      const totalCommitsVal = commitsByAuthor.reduce((s, a) => s + a.count, 0);
      commitsByAuthor.slice(0, 20).forEach((a, idx) => {
        const pct = totalCommitsVal > 0 ? ((a.count / totalCommitsVal) * 100).toFixed(1) : '0';
        md += `| ${idx + 1} | ${a.name} | ${a.count} | ${pct}% |\n`;
      });
      md += `\n`;
    }

    if (hasSection('hotFiles')) {
      md += `## 高频修改文件\n\n`;
      md += `| 文件 | 修改次数 | 参与作者数 | 最近修改 |\n`;
      md += `| --- | --- | --- | --- |\n`;
      hotFiles.slice(0, 20).forEach(hf => {
        md += `| \`${hf.filePath}\` | ${hf.changeCount} | ${hf.authors.length} | ${this.formatDate(hf.lastModified)} |\n`;
      });
      md += `\n`;
    }

    if (hasSection('storylines')) {
      md += `## 改动故事线\n\n`;
      const highImpact = storylines.filter(s => s.impact === 'high');
      const mediumImpact = storylines.filter(s => s.impact === 'medium');
      const lowImpact = storylines.filter(s => s.impact === 'low');

      md += `### 大规模变更 (${highImpact.length})\n\n`;
      for (const s of highImpact.slice(0, 30)) {
        md += `- **${this.formatDate(s.commit.date)}** ${s.narrative}\n`;
      }
      md += `\n`;

      md += `### 中等规模变更 (${mediumImpact.length})\n\n`;
      for (const s of mediumImpact.slice(0, 50)) {
        md += `- ${this.formatDate(s.commit.date)} ${s.narrative}\n`;
      }
      md += `\n`;

      md += `### 小范围变更 (${lowImpact.length})\n\n`;
      for (const s of lowImpact.slice(0, 100)) {
        md += `- ${this.formatDate(s.commit.date)} ${s.narrative}\n`;
      }
      md += `\n`;
    }

    if (hasSection('favorites') && favorites.length > 0) {
      md += `## 收藏的可疑提交\n\n`;
      for (const commit of favorites) {
        md += `### ${commit.shortHash} - ${commit.message}\n\n`;
        md += `- 提交者：${commit.authorName} (${commit.authorEmail})\n`;
        md += `- 时间：${this.formatDate(commit.date)}\n`;
        md += `- 变更统计：${commit.stats?.totalFiles} 文件，+${commit.stats?.totalAdditions} -${commit.stats?.totalDeletions}\n`;
        const note = this.stateService.getNote(commit.hash);
        if (note) {
          md += `- 备注：${note}\n`;
        }
        const defects = this.stateService.getDefectIds(commit.hash);
        if (defects.length > 0) {
          md += `- 关联缺陷：${defects.join('、')}\n`;
        }
        md += `\n`;
      }
    }

    if (hasSection('defects') && defectsByCount.length > 0) {
      md += `## 相关缺陷 TOP\n\n`;
      md += `| 缺陷编号 | 关联提交数 | 详情 |\n`;
      md += `| --- | --- | --- |\n`;
      for (const d of defectsByCount.slice(0, 20)) {
        const url = this.getDefectUrl(d.id);
        md += `| ${d.id} | ${d.count} | ${url ? `[查看](${url})` : '-'} |\n`;
      }
      md += `\n`;
    }

    if (hasSection('commitList')) {
      md += `## 完整提交列表\n\n`;
      md += `| 哈希 | 日期 | 作者 | 说明 | 文件 | +/- |\n`;
      md += `| --- | --- | --- | --- | --- | --- |\n`;
      for (const commit of commits.slice(0, 500)) {
        const msg = commit.message.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        md += `| \`${commit.shortHash}\` | ${this.formatDate(commit.date)} | ${commit.authorName} | ${msg} | ${commit.stats?.totalFiles || 0} | +${commit.stats?.totalAdditions || 0} -${commit.stats?.totalDeletions || 0} |\n`;
      }
      md += `\n`;

      if (commits.length > 500) {
        md += `> 后续 ${commits.length - 500} 条提交记录已省略\n\n`;
      }
    }

    md += `---\n\n`;
    md += `*本报告由 Git 考古面板自动生成 · 模板：${templateMeta.label} · 分支：${filterOptions.branch}*\n`;

    return md;
  }

  generateJsonReport(
    repoInfo: { name: string; rootPath: string; totalCommits: number; firstCommitDate: string; lastCommitDate: string; defaultBranch: string; remoteUrl?: string },
    commits: GitCommit[],
    filterOptions: FilterOptions,
    hotFiles: HotFile[],
    authors: { name: string; email: string; commitCount: number }[],
    options: ReportGenerateOptions = { template: 'handoff', sections: ALL_SECTIONS.map(s => s.key) },
    diffSummary?: BranchDiffSummary
  ): ReportData & {
    template: ReportTemplate;
    sections: ReportSectionKey[];
    diffSummary?: BranchDiffSummary;
    allCommits: GitCommit[];
    allAuthors: { name: string; email: string; commitCount: number }[];
  } {
    const generatedAt = new Date().toISOString();
    const storylines = this.generateStorylines(commits);
    const favorites = commits.filter(c => this.stateService.isFavorite(c.hash));
    const topDefects = this.computeTopDefects(commits);
    const commitsByAuthor = this.computeCommitsByAuthor(authors);
    const totalFiles = new Set(commits.flatMap(c => c.files.map(f => f.filePath))).size;

    return {
      generatedAt,
      repositoryName: repoInfo.name,
      branch: filterOptions.branch,
      filterOptions,
      totalCommits: commits.length,
      totalAuthors: authors.length,
      totalFiles,
      commitsByAuthor,
      hotFiles,
      storylines,
      favoriteCommits: favorites,
      topDefects,
      template: options.template,
      sections: options.sections,
      diffSummary,
      allCommits: commits,
      allAuthors: authors
    };
  }

  generateLocationLink(
    workspacePath: string,
    commitHash: string,
    filePath?: string,
    line?: number
  ): string {
    const safePath = workspacePath.replace(/\\/g, '/');
    let link = `git-archaeologist://open?repo=${encodeURIComponent(safePath)}&commit=${commitHash}`;
    if (filePath) {
      link += `&file=${encodeURIComponent(filePath)}`;
    }
    if (line) {
      link += `&line=${line}`;
    }
    return link;
  }

  private formatDate(dateStr: string): string {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      return d.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateStr;
    }
  }
}
