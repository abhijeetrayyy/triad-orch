import * as fs from 'fs';
import * as path from 'path';

export interface MemoryEntry {
  project: string;
  task: string;
  lesson: string;
  timestamp: string;
}

export class SharedMemory {
  private memoryPath: string;
  private cache: MemoryEntry[] | null = null;

  constructor() {
    this.memoryPath = path.join(process.cwd(), 'global_memory.json');
    if (!fs.existsSync(this.memoryPath)) {
      fs.writeFileSync(this.memoryPath, JSON.stringify([], null, 2));
    }
  }

  private load(): MemoryEntry[] {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.memoryPath, 'utf-8'));
    } catch (e) {
      this.cache = [];
    }
    return this.cache!;
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.memoryPath, JSON.stringify(this.cache || [], null, 2));
    } catch (e) {}
  }

  addLesson(project: string, task: string, lesson: string) {
    const memory = this.load();
    memory.push({
      project,
      task,
      lesson,
      timestamp: new Date().toISOString()
    });
    this.persist();
  }

  getRelevantLessons(query: string): string {
    const memory = this.load();
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (queryWords.length === 0) return '';
    const relevant = memory.filter(m => {
      const taskLower = (m.task || '').toLowerCase();
      return queryWords.some(word => taskLower.includes(word));
    });
    return relevant.map(m => `[Lesson from ${m.project}]: ${m.lesson}`).join('\n');
  }
}
