export const EXIT_ERROR = 1;

export class CliError extends Error {
  readonly exitCode: number;
  readonly exposeAsJson: boolean;

  constructor(message: string, options?: { exitCode?: number; exposeAsJson?: boolean }) {
    super(message);
    this.name = "CliError";
    this.exitCode = options?.exitCode ?? EXIT_ERROR;
    this.exposeAsJson = options?.exposeAsJson ?? true;
  }
}
