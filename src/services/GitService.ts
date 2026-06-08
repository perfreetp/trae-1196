import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { GitCommit, GitBranch, GitFileChange, FileHistoryEntry, BlameLine, HotFile, DeletedFile, FilterOptions, DateRange } from '../models/types';

export class GitService {
  private workspaceRoot: string;
  private config: vscode.WorkspaceConfiguration;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.config = vscode.workspace.getConfiguration('gitArchaeologist');
  }

  private executeGitCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const cmd = `git ${args.join(' ')}`;
      child_process.exec(cmd, {
        cwd: this.workspaceRoot,
        maxBuffer: 1024 * 1024 * 50,
        timeout: 120000
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Git command failed: ${stderr || error.message}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async getBranches(): Promise<GitBranch[]> {
    const output = await this.executeGitCommand([
      'for-each-ref',
      '--format=%(refname)|%(refname:short)|%(objectname)|%(committerdate:iso8601)|%(HEAD)',
      'refs/heads/', 'refs/remotes/'
    ]);

    const branches: GitBranch[] = [];
    const lines = output.trim().split('\n').filter(l => l);
    const currentBranch = await this.getCurrentBranch();

    for (const line of lines) {
      const parts = line.split('|');
      const refname = parts[0] || '';
      const shortName = parts[1] || '';
      const hash = parts[2] || '';
      const date = parts[3] || '';
      const head = parts[4] || '';

      if (!refname) continue;

      const isRemote = refname.startsWith('refs/remotes/');
      if (isRemote && shortName.endsWith('/HEAD')) continue;

      let displayName = shortName;
      if (isRemote && shortName.startsWith('remotes/')) {
        displayName = shortName.substring(8);
      }

      branches.push({
        name: displayName,
        isRemote,
        isCurrent: !isRemote && (displayName === currentBranch || head === '*'),
        lastCommitHash: hash,
        lastCommitDate: date
      });
    }

    return branches;
  }

  async getCurrentBranch(): Promise<string> {
    try {
      const output = await this.executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
      return output.trim();
    } catch {
      return this.config.get('defaultBranch', 'main');
    }
  }

  async getCommits(options: Partial<FilterOptions> = {}): Promise<GitCommit[]> {
    const branch = options.branch || this.config.get('defaultBranch', 'main');
    const maxCommits = options.maxCommits || this.config.get('maxCommits', 500);

    const args = ['log', branch, `--max-count=${maxCommits}`, '--pretty=format:---COMMIT---%n%H|%h|%an|%ae|%aI|%s|%b|%P%n---DIFF---', '--numstat', '-M', '-C'];

    if (options.dateRange?.start) {
      args.push(`--since="${options.dateRange.start}"`);
    }
    if (options.dateRange?.end) {
      args.push(`--until="${options.dateRange.end}"`);
    }
    if (options.authors && options.authors.length > 0) {
      options.authors.forEach(author => {
        args.push(`--author="${author}"`);
      });
    }
    if (options.searchTerm) {
      args.push(`--grep="${options.searchTerm}"`, '--all-match');
    }

    const output = await this.executeGitCommand(args);
    return this.parseCommits(output);
  }

  private parseCommits(raw: string): GitCommit[] {
    const commits: GitCommit[] = [];
    const sections = raw.split('---COMMIT---').filter(s => s.trim());

    for (const section of sections) {
      const [headerPart, diffPart] = section.split('---DIFF---');
      const headerLines = headerPart.trim().split('\n');
      const header = headerLines[0];

      if (!header) continue;

      const parts = header.split('|');
      if (parts.length < 8) continue;

      const [hash, shortHash, authorName, authorEmail, date, message, body, parentsStr] = parts;
      const parentHashes = parentsStr ? parentsStr.split(' ') : [];

      const files = this.parseDiffStats(diffPart || '');
      const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
      const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

      let bodyText = body;
      for (let i = 1; i < headerLines.length; i++) {
        bodyText += '\n' + headerLines[i];
      }

      commits.push({
        hash: hash.trim(),
        shortHash: shortHash.trim(),
        authorName: authorName.trim(),
        authorEmail: authorEmail.trim(),
        date: date.trim(),
        timestamp: new Date(date.trim()).getTime(),
        message: message.trim(),
        body: bodyText,
        parentHashes: parentHashes.filter(p => p),
        files,
        stats: {
          totalFiles: files.length,
          totalAdditions,
          totalDeletions
        }
      });
    }

    return commits;
  }

  private parseDiffStats(raw: string): GitFileChange[] {
    const files: GitFileChange[] = [];
    const lines = raw.trim().split('\n').filter(l => l.trim());

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const [additionsStr, deletionsStr, ...pathParts] = parts;
      const filePath = pathParts.join('\t');

      const additions = additionsStr === '-' ? 0 : parseInt(additionsStr, 10) || 0;
      const deletions = deletionsStr === '-' ? 0 : parseInt(deletionsStr, 10) || 0;

      let status: GitFileChange['status'] = 'M';
      let actualFilePath = filePath;
      let oldFilePath: string | undefined;

      if (filePath.includes('{')) {
        const match = filePath.match(/\{(.*)\s*=>\s*(.*)\}/);
        if (match) {
          const [full, before, after] = match;
          const prefix = filePath.substring(0, filePath.indexOf('{'));
          const suffix = filePath.substring(filePath.indexOf('}') + 1);
          oldFilePath = prefix + before + suffix;
          actualFilePath = prefix + after + suffix;
          status = 'R';
        }
      } else if (filePath.includes('=>')) {
        const [oldPath, newPath] = filePath.split('=>');
        oldFilePath = oldPath.trim();
        actualFilePath = newPath.trim();
        status = 'R';
      } else {
        const fileStatus = this.detectFileStatus(additionsStr, deletionsStr);
        status = fileStatus;
      }

      files.push({
        status,
        filePath: actualFilePath,
        oldFilePath,
        additions,
        deletions
      });
    }

    return files;
  }

  private detectFileStatus(addStr: string, delStr: string): GitFileChange['status'] {
    if (addStr !== '-' && delStr === '-' && parseInt(addStr, 10) > 0) {
      return 'A';
    }
    if (delStr !== '-' && addStr === '-' && parseInt(delStr, 10) > 0) {
      return 'D';
    }
    return 'M';
  }

  async getFileHistory(filePath: string, options: Partial<FilterOptions> = {}): Promise<FileHistoryEntry[]> {
    const branch = options.branch || this.config.get('defaultBranch', 'main');
    const maxCommits = options.maxCommits || this.config.get('maxCommits', 500);

    const args = ['log', branch, `--max-count=${maxCommits}`, '--follow', '--pretty=format:%H|%aI|%an|%s', '--numstat', '--', filePath];

    if (options.dateRange?.start) {
      args.push(`--since="${options.dateRange.start}"`);
    }
    if (options.dateRange?.end) {
      args.push(`--until="${options.dateRange.end}"`);
    }

    const output = await this.executeGitCommand(args);
    const lines = output.trim().split('\n').filter(l => l.trim());
    const entries: FileHistoryEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('|') && !line.startsWith('\t') && line.split('|').length >= 4) {
        const [hash, date, author, ...msgParts] = line.split('|');
        const message = msgParts.join('|');

        let additions = 0;
        let deletions = 0;
        let status = 'M';
        let file = filePath;

        if (i + 1 < lines.length) {
          const statLine = lines[i + 1];
          const statParts = statLine.split('\t').filter(p => p);
          if (statParts.length >= 3) {
            additions = statParts[0] === '-' ? 0 : parseInt(statParts[0], 10) || 0;
            deletions = statParts[1] === '-' ? 0 : parseInt(statParts[1], 10) || 0;
            file = statParts.slice(2).join('\t');
            status = this.detectFileStatus(statParts[0], statParts[1]);
          }
          i++;
        }

        entries.push({
          commitHash: hash,
          date,
          author,
          message,
          status,
          additions,
          deletions,
          filePath: file
        });
      }
    }

    return entries;
  }

  async getBlame(filePath: string, revision?: string): Promise<BlameLine[]> {
    const args = ['blame', '--porcelain', '-w'];
    if (revision) {
      args.push(revision);
    }
    args.push('--', filePath);

    const output = await this.executeGitCommand(args);
    return this.parseBlameOutput(output, filePath);
  }

  private parseBlameOutput(raw: string, filePath: string): BlameLine[] {
    const lines: BlameLine[] = [];
    const chunks = raw.split(/^(?=[0-9a-f]{40})/m);

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;

      const chunkLines = chunk.split('\n');
      const headerMatch = chunkLines[0].match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/);
      if (!headerMatch) continue;

      const commitHash = headerMatch[1];
      const originalLine = parseInt(headerMatch[2], 10);
      const finalLine = parseInt(headerMatch[3], 10);

      let authorName = '';
      let authorEmail = '';
      let date = '';
      let previousHash: string | undefined;
      let previousFileName: string | undefined;
      let isBoundary = false;
      let content = '';

      for (let i = 1; i < chunkLines.length; i++) {
        const line = chunkLines[i];
        if (line.startsWith('author ')) {
          authorName = line.substring(7);
        } else if (line.startsWith('author-mail ')) {
          authorEmail = line.substring(13).replace(/^<|>$/g, '');
        } else if (line.startsWith('author-time ')) {
          const timestamp = parseInt(line.substring(12), 10);
          date = new Date(timestamp * 1000).toISOString();
        } else if (line.startsWith('previous ')) {
          const prevParts = line.substring(9).split(' ');
          if (prevParts.length >= 1) {
            previousHash = prevParts[0];
          }
          if (prevParts.length >= 2) {
            previousFileName = prevParts.slice(1).join(' ');
          }
        } else if (line === 'boundary') {
          isBoundary = true;
        } else if (line.startsWith('\t')) {
          content = line.substring(1);
          break;
        }
      }

      lines.push({
        lineNumber: finalLine,
        content,
        commitHash,
        shortHash: commitHash.substring(0, 7),
        authorName,
        authorEmail,
        date,
        previousHash,
        previousFileName,
        isBoundary
      });
    }

    return lines.sort((a, b) => a.lineNumber - b.lineNumber);
  }

  async getHotFiles(limit: number = 20, branch?: string): Promise<HotFile[]> {
    const args = ['log', branch || 'HEAD', '--pretty=format:', '--name-only'];
    const output = await this.executeGitCommand(args);

    const fileCounts = new Map<string, { count: number; authors: Set<string>; lastModified: string }>();

    const lines = output.trim().split('\n').filter(l => l.trim());

    for (const filePath of lines) {
      let info = fileCounts.get(filePath);
      if (!info) {
        info = { count: 0, authors: new Set(), lastModified: '' };
        fileCounts.set(filePath, info);
      }
      info.count++;
    }

    const commits = await this.getCommits({ branch: branch || undefined, maxCommits: 1000 });
    for (const commit of commits) {
      for (const file of commit.files) {
        const info = fileCounts.get(file.filePath);
        if (info) {
          info.authors.add(commit.authorName);
          if (!info.lastModified || new Date(commit.date) > new Date(info.lastModified)) {
            info.lastModified = commit.date;
          }
        }
      }
    }

    const sorted = Array.from(fileCounts.entries())
      .map(([filePath, info]) => ({
        filePath,
        changeCount: info.count,
        authors: Array.from(info.authors),
        lastModified: info.lastModified
      }))
      .sort((a, b) => b.changeCount - a.changeCount)
      .slice(0, limit);

    return sorted;
  }

  async getDeletedFiles(branch?: string): Promise<DeletedFile[]> {
    const args = ['log', branch || 'HEAD', '--diff-filter=D', '--summary',
      '--pretty=format:commit %H|%aI|%an'];
    const output = await this.executeGitCommand(args);

    const deletedFiles: DeletedFile[] = [];
    const lines = output.trim().split('\n');

    let currentCommit = '';
    let currentDate = '';
    let currentAuthor = '';

    for (const line of lines) {
      if (line.startsWith('commit ')) {
        const parts = line.substring(7).split('|');
        currentCommit = parts[0];
        currentDate = parts[1] || '';
        currentAuthor = parts[2] || '';
      } else if (line.startsWith(' delete mode ')) {
        const tokens = line.split(/\s+/).filter(t => t);
        const filePath = tokens.slice(3).join(' ');
        deletedFiles.push({
          filePath,
          deletedInCommit: currentCommit,
          deletedDate: currentDate,
          deletedBy: currentAuthor
        });
      }
    }

    return deletedFiles;
  }

  async getFileContentAtRevision(filePath: string, revision: string): Promise<string> {
    try {
      return await this.executeGitCommand(['show', `${revision}:${filePath}`]);
    } catch {
      return '';
    }
  }

  async fileExistsAtBranch(filePath: string, branch?: string): Promise<boolean> {
    try {
      await this.executeGitCommand(['cat-file', '-e', `${branch || 'HEAD'}:${filePath}`]);
      return true;
    } catch {
      return false;
    }
  }

  async restoreDeletedFileContent(filePath: string, deletedInCommit?: string): Promise<{ content: string; foundRevision: string }> {
    const revisionsToTry: string[] = [];

    if (deletedInCommit) {
      revisionsToTry.push(`${deletedInCommit}^1`);
      revisionsToTry.push(`${deletedInCommit}^`);
    }

    if (revisionsToTry.length === 0 || revisionsToTry.every(r => !r)) {
      try {
        const findResult = await this.executeGitCommand([
          'log', '--all', '--diff-filter=D', '--follow',
          '--pretty=format:%H', '--max-count=5', '--', filePath
        ]);
        const commits = findResult.trim().split('\n').filter(h => h.trim());
        for (const c of commits) {
          revisionsToTry.push(`${c}^1`, `${c}^`);
        }
      } catch {}
    }

    revisionsToTry.push('HEAD~1', 'HEAD~5', 'HEAD~10');

    let lastContent = '';
    let lastRev = '';

    for (const rev of revisionsToTry) {
      if (!rev) continue;
      try {
        const content = await this.getFileContentAtRevision(filePath, rev);
        if (content && content.trim().length > 0) {
          return { content, foundRevision: rev };
        }
        if (!lastContent && content) {
          lastContent = content;
          lastRev = rev;
        }
      } catch {}
    }

    try {
      const allRevs = await this.executeGitCommand([
        'log', '--all', '--follow', '--pretty=format:%H', '--', filePath
      ]);
      const allCommitHashes = allRevs.trim().split('\n').filter(h => h.trim());
      for (const hash of allCommitHashes.slice(0, 30)) {
        try {
          const content = await this.getFileContentAtRevision(filePath, hash);
          if (content && content.trim().length > 0) {
            return { content, foundRevision: hash };
          }
        } catch {}
      }
    } catch {}

    return { content: lastContent, foundRevision: lastRev };
  }

  async getDiff(commitHash: string): Promise<string> {
    return await this.executeGitCommand(['show', commitHash, '--patch', '--format=']);
  }

  async getDiffBetweenCommits(commit1: string, commit2: string): Promise<string> {
    return await this.executeGitCommand(['diff', commit1, commit2]);
  }

  async getAllAuthors(branch?: string): Promise<{ name: string; email: string; commitCount: number }[]> {
    const args = ['log', branch || 'HEAD', '--format=%an|%ae'];
    const output = await this.executeGitCommand(args);

    const authorMap = new Map<string, { name: string; email: string; commitCount: number }>();

    for (const line of output.trim().split('\n').filter(l => l)) {
      const [name, email] = line.split('|');
      const key = email.toLowerCase();
      if (!authorMap.has(key)) {
        authorMap.set(key, { name, email, commitCount: 0 });
      }
      authorMap.get(key)!.commitCount++;
    }

    return Array.from(authorMap.values()).sort((a, b) => b.commitCount - a.commitCount);
  }

  async getAuthorStats(authorName: string, branch?: string): Promise<{
    filesTouched: string[];
    linesAdded: number;
    linesDeleted: number;
    firstCommitDate: string;
    lastCommitDate: string;
  }> {
    const commits = await this.getCommits({
      branch: branch || undefined,
      authors: [authorName],
      maxCommits: 10000
    });

    const filesSet = new Set<string>();
    let linesAdded = 0;
    let linesDeleted = 0;
    let firstDate = '';
    let lastDate = '';

    for (const commit of commits) {
      for (const file of commit.files) {
        filesSet.add(file.filePath);
        linesAdded += file.additions;
        linesDeleted += file.deletions;
      }
      if (!firstDate || new Date(commit.date) < new Date(firstDate)) {
        firstDate = commit.date;
      }
      if (!lastDate || new Date(commit.date) > new Date(lastDate)) {
        lastDate = commit.date;
      }
    }

    return {
      filesTouched: Array.from(filesSet),
      linesAdded,
      linesDeleted,
      firstCommitDate: firstDate,
      lastCommitDate: lastDate
    };
  }

  async getRepositoryInfo(branch?: string): Promise<{
    name: string;
    rootPath: string;
    totalCommits: number;
    firstCommitDate: string;
    lastCommitDate: string;
    defaultBranch: string;
    remoteUrl?: string;
  }> {
    const targetBranch = branch || (await this.getCurrentBranch());
    const totalCommitsOutput = await this.executeGitCommand(['rev-list', '--count', targetBranch]);
    const totalCommits = parseInt(totalCommitsOutput.trim(), 10) || 0;

    let firstCommitDate = '';
    try {
      const firstOutput = await this.executeGitCommand([
        'log', targetBranch, '--reverse', '--pretty=format:%aI', '--max-count=1'
      ]);
      firstCommitDate = firstOutput.trim();
    } catch {}

    let lastCommitDate = '';
    try {
      const lastOutput = await this.executeGitCommand([
        'log', targetBranch, '--pretty=format:%aI', '--max-count=1'
      ]);
      lastCommitDate = lastOutput.trim();
    } catch {}

    let remoteUrl: string | undefined;
    try {
      const remoteOutput = await this.executeGitCommand(['remote', 'get-url', 'origin']);
      remoteUrl = remoteOutput.trim();
    } catch {}

    const pathParts = this.workspaceRoot.split(/[\\/]/);
    const name = pathParts[pathParts.length - 1] || 'Unknown';

    return {
      name,
      rootPath: this.workspaceRoot,
      totalCommits,
      firstCommitDate,
      lastCommitDate,
      defaultBranch: targetBranch,
      remoteUrl
    };
  }

  async getSingleCommit(commitHash: string): Promise<GitCommit | null> {
    try {
      const args = [
        'show', commitHash,
        '--pretty=format:---COMMIT---%n%H|%h|%an|%ae|%aI|%s|%b|%P%n---DIFF---',
        '--numstat', '-M', '-C'
      ];
      const raw = await this.executeGitCommand(args);
      const parsed = this.parseCommits('---COMMIT---\n' + raw);
      if (parsed.length > 0) {
        return parsed[0];
      }
    } catch {}
    try {
      const args = ['show', '--no-patch', '--pretty=format:%H|%h|%an|%ae|%aI|%s|%b|%P', commitHash];
      const info = await this.executeGitCommand(args);
      const parts = info.split('|');
      if (parts.length >= 6) {
        return {
          hash: parts[0],
          shortHash: parts[1],
          authorName: parts[2],
          authorEmail: parts[3],
          date: parts[4],
          timestamp: new Date(parts[4]).getTime(),
          message: parts[5],
          body: parts[6] || '',
          parentHashes: parts[7]?.split(' ').filter(p => p) || [],
          files: [],
          stats: { totalFiles: 0, totalAdditions: 0, totalDeletions: 0 }
        };
      }
    } catch {}
    return null;
  }

  async searchCommitsByKeyword(keyword: string, filePath?: string, branch?: string): Promise<GitCommit[]> {
    const args = ['log', branch || 'HEAD', '-S', keyword, '--pretty=format:%H'];

    if (filePath) {
      args.push('--', filePath);
    }

    const output = await this.executeGitCommand(args);
    const hashes = output.trim().split('\n').filter(h => h.trim());

    const commits: GitCommit[] = [];
    for (const hash of hashes) {
      const args = ['show', '--no-patch', '--pretty=format:%H|%h|%an|%ae|%aI|%s|%b|%P', hash];
      try {
        const info = await this.executeGitCommand(args);
        const parts = info.split('|');
        if (parts.length >= 6) {
          commits.push({
            hash: parts[0],
            shortHash: parts[1],
            authorName: parts[2],
            authorEmail: parts[3],
            date: parts[4],
            timestamp: new Date(parts[4]).getTime(),
            message: parts[5],
            body: parts[6] || '',
            parentHashes: parts[7]?.split(' ').filter(p => p) || [],
            files: []
          });
        }
      } catch {}
    }

    return commits;
  }

  async searchInHistory(keyword: string, filePath?: string, branch?: string): Promise<{
    commitHash: string;
    filePath: string;
    line: number;
    content: string;
  }[]> {
    const args = ['log', '-p', branch || 'HEAD', '-S', keyword, '--pretty=format:@@@COMMIT:%H@@@'];
    if (filePath) {
      args.push('--', filePath);
    }

    const output = await this.executeGitCommand(args);
    const results: { commitHash: string; filePath: string; line: number; content: string }[] = [];

    const commitBlocks = output.split('@@@COMMIT:').filter(b => b.trim());

    for (const block of commitBlocks) {
      const hashMatch = block.match(/^([0-9a-f]+)@@@/);
      if (!hashMatch) continue;
      const commitHash = hashMatch[1];
      const rest = block.substring(hashMatch[0].length);

      let currentFilePath = '';
      const fileBlocks = rest.split(/^diff --git /m).slice(1);

      for (const fileBlock of fileBlocks) {
        const pathMatch = fileBlock.match(/a\/(.*?) b\/(.*?)\n/);
        if (pathMatch) {
          currentFilePath = pathMatch[2];
        }

        let newLineNumber = 0;
        const lines = fileBlock.split('\n');

        for (const line of lines) {
          if (line.startsWith('@@')) {
            const newLineMatch = line.match(/\+(\d+)/);
            if (newLineMatch) {
              newLineNumber = parseInt(newLineMatch[1], 10) - 1;
            }
          } else if (line.startsWith('+') && !line.startsWith('+++')) {
            newLineNumber++;
            if (line.toLowerCase().includes(keyword.toLowerCase())) {
              results.push({
                commitHash,
                filePath: currentFilePath,
                line: newLineNumber,
                content: line.substring(1)
              });
            }
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            if (line.toLowerCase().includes(keyword.toLowerCase())) {
              results.push({
                commitHash,
                filePath: currentFilePath,
                line: newLineNumber,
                content: line.substring(1)
              });
            }
          } else if (!line.startsWith('\\')) {
            newLineNumber++;
          }
        }
      }
    }

    return results;
  }
}
