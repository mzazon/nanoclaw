/**
 * Tests for token rotation helpers: updateEnvSecret and redactEnvKeys.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { updateEnvSecret, redactEnvKeys, ENV_PLAINTEXT_KEYS } from './token-rotate-helpers.js';

let tmpDir: string;
let envPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  envPath = path.join(tmpDir, '.env');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── updateEnvSecret ──

describe('updateEnvSecret', () => {
  it('replaces an existing DASHBOARD_SECRET= line in-place', () => {
    fs.writeFileSync(envPath, 'ASSISTANT_NAME=Andy\nDASHBOARD_SECRET=old\nDASHBOARD_PORT=3100\n');
    updateEnvSecret(envPath, 'DASHBOARD_SECRET', 'newtoken');
    const result = fs.readFileSync(envPath, 'utf-8');
    expect(result).toContain('DASHBOARD_SECRET=newtoken');
    expect(result).not.toContain('DASHBOARD_SECRET=old');
    // Other keys untouched
    expect(result).toContain('ASSISTANT_NAME=Andy');
    expect(result).toContain('DASHBOARD_PORT=3100');
  });

  it('appends key when absent', () => {
    fs.writeFileSync(envPath, 'ASSISTANT_NAME=Andy\n');
    updateEnvSecret(envPath, 'DASHBOARD_SECRET', 'newtoken');
    const result = fs.readFileSync(envPath, 'utf-8');
    expect(result).toContain('DASHBOARD_SECRET=newtoken');
    expect(result).toContain('ASSISTANT_NAME=Andy');
  });

  it('appends with a newline separator when file has no trailing newline', () => {
    fs.writeFileSync(envPath, 'ASSISTANT_NAME=Andy');
    updateEnvSecret(envPath, 'DASHBOARD_SECRET', 'newtoken');
    const result = fs.readFileSync(envPath, 'utf-8');
    expect(result).toMatch(/Andy\nDASHBOARD_SECRET=newtoken/);
  });

  it('creates the file with just the key when .env does not exist', () => {
    // envPath does not exist yet
    updateEnvSecret(envPath, 'DASHBOARD_SECRET', 'brandnew');
    const result = fs.readFileSync(envPath, 'utf-8');
    expect(result.trim()).toBe('DASHBOARD_SECRET=brandnew');
  });

  it('does not touch a commented #DASHBOARD_SECRET= line — appends instead', () => {
    fs.writeFileSync(envPath, '#DASHBOARD_SECRET=commented\nASSISTANT_NAME=Andy\n');
    updateEnvSecret(envPath, 'DASHBOARD_SECRET', 'newtoken');
    const result = fs.readFileSync(envPath, 'utf-8');
    // Commented line is preserved unchanged
    expect(result).toContain('#DASHBOARD_SECRET=commented');
    // New active entry appended
    expect(result).toContain('DASHBOARD_SECRET=newtoken');
  });

  it('writes atomically (.env.tmp does not remain after success)', () => {
    fs.writeFileSync(envPath, 'DASHBOARD_SECRET=old\n');
    updateEnvSecret(envPath, 'DASHBOARD_SECRET', 'newtoken');
    const tmpExists = fs.existsSync(envPath + '.tmp');
    expect(tmpExists).toBe(false);
  });
});

// ── redactEnvKeys ──

describe('redactEnvKeys', () => {
  it('returns plaintext for allowlisted keys', () => {
    const entries = { ASSISTANT_NAME: 'Andy', DASHBOARD_PORT: '3100' };
    const redacted = redactEnvKeys(entries);
    expect(redacted['ASSISTANT_NAME']).toBe('Andy');
    expect(redacted['DASHBOARD_PORT']).toBe('3100');
  });

  it('redacts non-allowlisted keys to ****', () => {
    const entries = { DASHBOARD_SECRET: 'supersecret', DISCORD_TOKEN: 'abc123' };
    const redacted = redactEnvKeys(entries);
    expect(redacted['DASHBOARD_SECRET']).toBe('****');
    expect(redacted['DISCORD_TOKEN']).toBe('****');
  });

  it('handles a mix of allowed and redacted keys', () => {
    const entries = {
      ASSISTANT_NAME: 'Andy',
      DATA_DIR: '/data',
      DASHBOARD_SECRET: 'secret',
      SOME_API_KEY: 'key123',
    };
    const redacted = redactEnvKeys(entries);
    expect(redacted['ASSISTANT_NAME']).toBe('Andy');
    expect(redacted['DATA_DIR']).toBe('/data');
    expect(redacted['DASHBOARD_SECRET']).toBe('****');
    expect(redacted['SOME_API_KEY']).toBe('****');
  });

  it('includes all six expected plaintext keys in ENV_PLAINTEXT_KEYS', () => {
    const expected = ['ASSISTANT_NAME', 'DASHBOARD_PORT', 'DATA_DIR', 'CONTAINER_INSTALL_LABEL', 'INSTALL_CJK_FONTS', 'TZ'];
    for (const k of expected) {
      expect(ENV_PLAINTEXT_KEYS).toContain(k);
    }
  });
});
