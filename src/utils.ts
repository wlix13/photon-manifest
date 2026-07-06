export function errorString(err: unknown): string {
  if (err instanceof Error) {
    return `error ${err.name}: ${err.message}: ${err.cause}: ${err.stack}`;
  }

  return "unknown error: " + JSON.stringify(err);
}
