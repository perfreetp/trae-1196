export interface GitCommit {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  date: string;
  timestamp: number;
  message: string;
  body: string;
  parentHashes: string[];
  files: GitFileChange[];
  stats?: CommitStats;
  isFavorite?: boolean;
  note?: string;
  defectIds?: string[];
}

export interface GitFileChange {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'U';
  filePath: string;
  oldFilePath?: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CommitStats {
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
}

export interface GitBranch {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  lastCommitHash?: string;
  lastCommitDate?: string;
}

export interface GitAuthor {
  name: string;
  email: string;
  commitCount: number;
  firstCommitDate?: string;
  lastCommitDate?: string;
  filesTouched: string[];
  linesAdded: number;
  linesDeleted: number;
}

export interface FileHistoryEntry {
  commitHash: string;
  date: string;
  author: string;
  message: string;
  status: string;
  additions: number;
  deletions: number;
  filePath: string;
}

export interface BlameLine {
  lineNumber: number;
  content: string;
  commitHash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  date: string;
  previousHash?: string;
  previousFileName?: string;
  isBoundary?: boolean;
}

export interface HotFile {
  filePath: string;
  changeCount: number;
  authors: string[];
  lastModified: string;
}

export interface DeletedFile {
  filePath: string;
  deletedInCommit: string;
  deletedDate: string;
  deletedBy: string;
  lastContent?: string;
}

export interface DateRange {
  start?: string;
  end?: string;
}

export interface FilterOptions {
  branch: string;
  dateRange?: DateRange;
  authors: string[];
  searchTerm?: string;
  maxCommits: number;
}

export interface StorylineEntry {
  commit: GitCommit;
  narrative: string;
  impact: 'low' | 'medium' | 'high';
  category: 'feature' | 'fix' | 'refactor' | 'docs' | 'chore' | 'other';
}

export interface ReportData {
  generatedAt: string;
  repositoryName: string;
  branch: string;
  filterOptions: FilterOptions;
  totalCommits: number;
  totalAuthors: number;
  totalFiles: number;
  commitsByAuthor: { name: string; count: number }[];
  hotFiles: HotFile[];
  storylines: StorylineEntry[];
  favoriteCommits: GitCommit[];
  topDefects: { id: string; count: number }[];
}

export interface PluginState {
  currentBranch: string;
  filterOptions: FilterOptions;
  favorites: Map<string, boolean>;
  notes: Map<string, string>;
  defectLinks: Map<string, string[]>;
  selectedCommits: string[];
}
