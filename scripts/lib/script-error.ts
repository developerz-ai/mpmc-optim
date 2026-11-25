/** A failure a script can explain: a stable code, what happened, and the command that fixes it. */
export class ScriptError extends Error {
  readonly code: string;
  readonly fix: string;

  constructor(code: string, message: string, fix: string) {
    super(message);
    this.name = 'ScriptError';
    this.code = code;
    this.fix = fix;
  }
}
