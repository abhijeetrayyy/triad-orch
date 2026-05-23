import simpleGit, { SimpleGit, CommitResult } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';

export interface CommitEntry {
  hash: string;
  date: string;
  message: string;
  refs: string;
}

export class GitManager {
  private git: SimpleGit;
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.git = simpleGit(workspacePath);
  }

  async init(): Promise<void> {
    const gitDir = path.join(this.workspacePath, '.git');
    if (fs.existsSync(gitDir)) return;

    await this.git.init();
    await this.git.addConfig('user.name', 'Triad Engine');
    await this.git.addConfig('user.email', 'triad@local');

    const gitignorePath = path.join(this.workspacePath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, '# Triad Engine workspace\n# No exclusions by default — all files tracked\n');
    }

    const indexExists = await this.git.status();
    if (indexExists.files.length > 0 || indexExists.not_added.length > 0) {
      await this.git.add('.gitignore');
      const statusAfter = await this.git.status();
      if (statusAfter.staged.length > 0) {
        await this.git.commit('chore: init workspace');
      }
    }
  }

  async createSessionBranch(sessionId: string): Promise<string> {
    const branches = await this.git.branchLocal();
    if (branches.all.includes(sessionId)) {
      await this.git.checkout(sessionId);
    } else {
      await this.git.checkoutLocalBranch(sessionId);
    }
    return sessionId;
  }

  async commit(message: string): Promise<CommitResult> {
    await this.git.add('.');
    const result = await this.git.commit(message);
    return result;
  }

  async getLog(branch?: string): Promise<CommitEntry[]> {
    const log = await this.git.log({
      ...(branch ? [branch as any] : [])
    });
    return log.all.map(c => ({
      hash: c.hash,
      date: c.date,
      message: c.message,
      refs: c.refs
    }));
  }

  async getDiff(fromHash: string, toHash: string): Promise<string> {
    return await this.git.diff([fromHash, toHash]);
  }

  async getBranches(): Promise<string[]> {
    const branches = await this.git.branch();
    return Object.keys(branches.branches);
  }

  async checkoutBranch(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  async restore(commitHash: string): Promise<void> {
    await this.git.raw(['checkout', commitHash, '--', '.']);
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.git.branch();
    return result.current;
  }

  async stageAll(): Promise<void> {
    await this.git.add('.');
  }

  async status() {
    return await this.git.status();
  }
}
