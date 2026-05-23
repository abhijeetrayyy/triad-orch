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

  constructor() {
    this.memoryPath = path.join(process.cwd(), 'global_memory.json');
    if (!fs.existsSync(this.memoryPath)) {
      fs.writeFileSync(this.memoryPath, JSON.stringify([], null, 2));
    }
  }

  addLesson(project: string, task: string, lesson: string) {
    const memory: MemoryEntry[] = JSON.parse(fs.readFileSync(this.memoryPath, 'utf-8'));
    memory.push({
      project,
      task,
      lesson,
      timestamp: new Date().toISOString()
    });
    fs.writeFileSync(this.memoryPath, JSON.stringify(memory, null, 2));
  }

  getRelevantLessons(query: string): string {
    const memory: MemoryEntry[] = JSON.parse(fs.readFileSync(this.memoryPath, 'utf-8'));
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (queryWords.length === 0) return '';
    const relevant = memory.filter(m => {
      const taskLower = m.task.toLowerCase();
      return queryWords.some(word => taskLower.includes(word));
    });
    return relevant.map(m => `[Lesson from ${m.project}]: ${m.lesson}`).join('\n');
  }
}
