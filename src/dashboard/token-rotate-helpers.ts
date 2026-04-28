/**
 * Pure helpers for token rotation and .env redaction.
 * Kept separate so tests can import without bringing in heavy DB / config deps.
 */
import fs from 'fs';

/** Keys whose values are shown in plaintext in the settings env viewer. */
export const ENV_PLAINTEXT_KEYS: readonly string[] = [
  'ASSISTANT_NAME',
  'DASHBOARD_PORT',
  'DATA_DIR',
  'CONTAINER_INSTALL_LABEL',
  'INSTALL_CJK_FONTS',
  'TZ',
];

/**
 * Update (or append) a single `key=value` line in an env file.
 * Only replaces lines whose key matches exactly and are NOT commented out.
 * Writes atomically via a .tmp sibling file then renames.
 */
export function updateEnvSecret(envPath: string, key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    // File doesn't exist yet — start empty
  }

  const lines = content.split('\n');
  let replaced = false;

  const updatedLines = lines.map((line) => {
    // Only match uncommented lines whose key is exactly `key`
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return line;
    const lineKey = trimmed.slice(0, eqIdx).trim();
    if (lineKey === key) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });

  let newContent: string;
  if (replaced) {
    newContent = updatedLines.join('\n');
  } else {
    // Append — ensure we're on a new line
    const needsNewline = content.length > 0 && !content.endsWith('\n');
    newContent = (needsNewline ? content + '\n' : content) + `${key}=${value}\n`;
  }

  const tmpPath = envPath + '.tmp';
  fs.writeFileSync(tmpPath, newContent, 'utf-8');
  fs.renameSync(tmpPath, envPath);
}

/**
 * Given a map of key→value pairs (e.g. from parsing .env),
 * return a copy where non-allowlisted keys have their value replaced with '****'.
 */
export function redactEnvKeys(entries: Record<string, string>): Record<string, string> {
  const allowed = new Set(ENV_PLAINTEXT_KEYS);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) {
    result[k] = allowed.has(k) ? v : '****';
  }
  return result;
}

/**
 * Parse all key=value pairs from an .env file content string.
 * Skips blank lines and comments. Does NOT strip quotes.
 */
export function parseAllEnvKeys(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes if present
    let value = raw;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
