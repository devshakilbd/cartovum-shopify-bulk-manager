/**
 * Structured, one-line JSON logs. Callers pass facts, never credentials: any field whose name looks
 * like a secret is dropped before writing, as a second line of defence.
 */
const SECRET = /token|secret|password|authorization|cookie|session/i;

export function log(event: string, fields: Record<string, unknown> = {}) {
  const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => !SECRET.test(k)));
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...safe }) + "\n");
}
