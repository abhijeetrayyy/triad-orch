export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

const INJECTION_PATTERNS = [
  /IGNORE/i,
  /SYSTEM:/i,
  /YOU ARE NOW/i,
  /NEW INSTRUCTION/i,
  /OVERRIDE/i,
  /FORGET/i,
  /DISREGARD/i,
  /You are a/i,
  /Act as/i,
  /Pretend you are/i,
];

const INJECTION_LINE_PATTERNS = [
  /^\s*(IGNORE|SYSTEM:|YOU ARE NOW|NEW INSTRUCTION|OVERRIDE|FORGET|DISREGARD)/i,
  /^\s*(You are a|Act as|Pretend you are)/i,
];

const ALLOWED_COMMANDS = [
  /^npm (install|run|test|build)/,
  /^npx /,
  /^node /,
  /^python3? /,
  /^tsc /,
  /^git (status|log|diff)/,
  /^ls /,
  /^cat /,
  /^mkdir /,
  /^cp /,
  /^mv /,
];

const BLOCKED_PATTERNS = [
  /rm\s+-rf/,
  /curl\s/,
  /wget\s/,
  /powershell/i,
  /cmd\.exe/i,
  /&&.*&&/,
  /\$\(/,
  />\s*\//,
];

export class PromptSanitizer {

  sanitizeFileContent(content: string): string {
    const lines = content.split('\n');
    const cleaned = lines.filter(line => {
      return !INJECTION_LINE_PATTERNS.some(pattern => pattern.test(line));
    });
    return cleaned.join('\n');
  }

  sanitizeTaskDescription(task: string): string {
    const patterns = [
      /\.\.\/|~\/|\/[A-Za-z]:\//,
      /https?:\/\/[^\s]+/,
      /[;&|`$]/,
    ];

    for (const pattern of patterns) {
      if (pattern.test(task)) {
        task = task.replace(pattern, '[REDACTED]');
      }
    }

    return task;
  }

  sanitizeAgentNotes(notes: string): string {
    return this.sanitizeFileContent(notes);
  }

  validateShellCommand(command: string): ValidationResult {
    for (const blocked of BLOCKED_PATTERNS) {
      if (blocked.test(command)) {
        return { allowed: false, reason: `Command matches blocked pattern: ${blocked}` };
      }
    }

    for (const allowed of ALLOWED_COMMANDS) {
      if (allowed.test(command)) {
        return { allowed: true };
      }
    }

    return { allowed: false, reason: 'Command not in allowed list' };
  }

  containsInjection(content: string): boolean {
    return INJECTION_PATTERNS.some(pattern => pattern.test(content));
  }
}
