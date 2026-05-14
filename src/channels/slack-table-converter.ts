/**
 * LOCAL-008: Convert markdown tables to Chat SDK Card elements with native
 * Slack Block Kit table blocks. When outgoing markdown contains GFM tables,
 * builds a CardElement with mixed Text + Table children so the Slack adapter
 * routes through cardToBlockKit (which produces native type:"table" blocks)
 * instead of markdown_text (which doesn't render tables).
 *
 * Limits: Slack supports 1 native table per message, 100 rows, 20 columns.
 * Second+ tables or oversized tables fall back to ASCII in code blocks
 * (handled by the Slack adapter's convertTableToBlocks).
 */
import { parseMarkdown, Table, stringifyMarkdown, type CardElement, type CardChild } from 'chat';
import type { Root, Content } from 'mdast';

const TABLE_REGEX = /\n?\|[^\n]+\|\s*\n\|[\s:|-]+\|\s*\n(?:\|[^\n]+\|\s*\n?)*/;

export function hasMarkdownTable(text: string): boolean {
  return TABLE_REGEX.test(text);
}

function cellText(cell: Content): string {
  if ('children' in cell && Array.isArray(cell.children)) {
    return (cell.children as Content[])
      .map((c) => {
        if ('value' in c && typeof c.value === 'string') return c.value;
        if ('children' in c) return cellText(c);
        return '';
      })
      .join('');
  }
  if ('value' in cell && typeof cell.value === 'string') return cell.value;
  return '';
}

function astNodeToCardChild(node: Content): CardChild | null {
  if (node.type === 'table') {
    const rows = 'children' in node ? (node.children as Content[]) : [];
    if (rows.length === 0) return null;
    const headerRow = rows[0];
    const headerCells = 'children' in headerRow ? (headerRow.children as Content[]) : [];
    const headers = headerCells.map(cellText);
    const dataRows = rows.slice(1).map((row) => {
      const cells = 'children' in row ? (row.children as Content[]) : [];
      return cells.map(cellText);
    });
    const align =
      'align' in node && Array.isArray(node.align)
        ? (node.align as Array<'left' | 'center' | 'right' | null>)
        : undefined;
    return Table({
      headers,
      rows: dataRows,
      ...(align ? { align: align.map((a) => a ?? undefined) as Array<'left' | 'center' | 'right' | undefined> } : {}),
    });
  }
  const md = stringifyMarkdown({ type: 'root', children: [node] } as Root);
  if (!md.trim()) return null;
  return { type: 'text' as const, content: md.trim(), style: 'markdown' as const };
}

export function markdownToCardWithTables(markdown: string): CardElement {
  const ast = parseMarkdown(markdown);
  const children: CardChild[] = [];
  for (const node of ast.children) {
    const child = astNodeToCardChild(node as Content);
    if (child) children.push(child);
  }
  return { type: 'card', children };
}
