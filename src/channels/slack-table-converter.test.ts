import { describe, it, expect } from 'vitest';
import { hasMarkdownTable, markdownToCardWithTables } from './slack-table-converter.js';

describe('hasMarkdownTable', () => {
  it('detects GFM table', () => {
    const md = 'text\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nmore';
    expect(hasMarkdownTable(md)).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(hasMarkdownTable('no tables here')).toBe(false);
  });

  it('returns false for pipe chars without separator row', () => {
    expect(hasMarkdownTable('| not | a | table |')).toBe(false);
  });
});

describe('markdownToCardWithTables', () => {
  it('converts markdown with table to card element', () => {
    const md = 'Before\n\n| Name | Value |\n|------|-------|\n| a    | 1     |\n| b    | 2     |\n\nAfter';
    const card = markdownToCardWithTables(md);
    expect(card.type).toBe('card');
    expect(card.children.length).toBe(3);

    expect(card.children[0]).toMatchObject({ type: 'text', style: 'plain' });
    expect((card.children[0] as { content: string }).content).toContain('Before');

    expect(card.children[1]).toMatchObject({
      type: 'table',
      headers: ['Name', 'Value'],
      rows: [
        ['a', '1'],
        ['b', '2'],
      ],
    });

    expect(card.children[2]).toMatchObject({ type: 'text', style: 'plain' });
    expect((card.children[2] as { content: string }).content).toContain('After');
  });

  it('handles table-only markdown', () => {
    const md = '| X |\n|---|\n| 1 |';
    const card = markdownToCardWithTables(md);
    expect(card.children.length).toBe(1);
    expect(card.children[0]).toMatchObject({
      type: 'table',
      headers: ['X'],
      rows: [['1']],
    });
  });

  it('handles multiple tables', () => {
    const md = '| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 2 |';
    const card = markdownToCardWithTables(md);
    const tables = card.children.filter((c) => c.type === 'table');
    expect(tables.length).toBe(2);
  });
});
