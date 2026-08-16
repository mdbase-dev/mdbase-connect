type OutputStream = Pick<NodeJS.WriteStream, "on">;

/**
 * A desktop application's lifetime must not depend on the terminal or launcher
 * that happened to start it. Linux desktop launchers can leave stdout and
 * stderr attached to pipes whose readers later exit. Any subsequent console
 * write then emits a stream error (usually EPIPE), which would otherwise crash
 * Electron's main process while it is reporting an unrelated IPC failure.
 */
export function guardDesktopProcessOutput(
  stdout: OutputStream = process.stdout,
  stderr: OutputStream = process.stderr
): void {
  ignoreOutputErrors(stdout);
  ignoreOutputErrors(stderr);
}

function ignoreOutputErrors(stream: OutputStream): void {
  stream.on("error", () => {
    // Diagnostic output is best-effort for a GUI process. There is nowhere
    // safer to report a failed output stream, so keep the application alive.
  });
}
