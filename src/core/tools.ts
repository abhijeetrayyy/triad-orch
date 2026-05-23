import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

export interface ToolCall {
  action: 'write_file' | 'run_command' | 'read_file' | 'create_custom_tool' | 'use_custom_tool';
  path?: string;
  content?: string;
  command?: string;
  tool_name?: string;
  args?: string;
}

export class ToolExecutor {
  private baseDir: string;
  private toolsDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.toolsDir = path.join(baseDir, '.triad_tools');
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    if (!fs.existsSync(this.toolsDir)) {
      fs.mkdirSync(this.toolsDir, { recursive: true });
    }
  }

  async execute(toolCall: ToolCall): Promise<string> {
    console.log(`[Tool] Executing ${toolCall.action}...`);
    
    switch (toolCall.action) {
      case 'write_file':
        if (!toolCall.path || toolCall.content === undefined) throw new Error("Missing path or content for write_file");
        const fullPath = path.join(this.baseDir, toolCall.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, toolCall.content);
        return `Successfully wrote to ${toolCall.path}`;

      case 'read_file':
        if (!toolCall.path) throw new Error("Missing path for read_file");
        const readPath = path.join(this.baseDir, toolCall.path);
        if (!fs.existsSync(readPath)) return `File not found: ${toolCall.path}`;
        return fs.readFileSync(readPath, 'utf-8');

      case 'run_command':
        if (!toolCall.command) throw new Error("Missing command for run_command");
        try {
          const { stdout, stderr } = await execPromise(toolCall.command, { cwd: this.baseDir });
          const output = [stdout, stderr].filter(Boolean).join('\n');
          return output || "Command executed with no output.";
        } catch (error: any) {
          return `Command failed: ${error.message}`;
        }

      case 'create_custom_tool':
        if (!toolCall.tool_name || !toolCall.content) throw new Error("Missing tool_name or content");
        const toolScriptPath = path.join(this.toolsDir, toolCall.tool_name);
        fs.writeFileSync(toolScriptPath, toolCall.content);
        return `Custom tool '${toolCall.tool_name}' created and saved to .triad_tools/`;

      case 'use_custom_tool':
        if (!toolCall.tool_name) throw new Error("Missing tool_name");
        const scriptPath = path.join(this.toolsDir, toolCall.tool_name);
        if (!fs.existsSync(scriptPath)) return `Tool '${toolCall.tool_name}' not found.`;
        
        const interpreter = scriptPath.endsWith('.py') ? 'python' : 'node';
        try {
          const { stdout, stderr } = await execPromise(`${interpreter} ${scriptPath} ${toolCall.args || ""}`, { cwd: this.baseDir });
          return stdout || stderr || "Tool executed with no output.";
        } catch (error: any) {
          return `Tool execution failed: ${error.message}`;
        }

      default:
        throw new Error(`Unknown action: ${toolCall.action}`);
    }
  }

  getAvailableCustomTools(): string[] {
    if (!fs.existsSync(this.toolsDir)) return [];
    return fs.readdirSync(this.toolsDir);
  }
}

