'use client';

/**
 * Phase 2 — Scrollable preview of the first N parsed rows from an upload.
 * Sticky header, horizontal scroll, truncated cells (with full value on
 * hover via title attribute). Renders nothing when `rows` is empty.
 */

interface Props {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  total: number;
  limit?: number;
}

function formatCell(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function DataPreviewTable({ rows, columns, total, limit = 5 }: Props) {
  if (rows.length === 0 || columns.length === 0) return null;
  const shown = rows.slice(0, limit);

  return (
    <div
      className="border border-border-default rounded-md bg-surface-card max-w-3xl overflow-hidden"
      data-testid="data-preview-table"
    >
      <div className="overflow-x-auto max-h-72">
        <table className="w-full text-xs">
          <thead className="bg-surface-base sticky top-0">
            <tr>
              {columns.map((c) => (
                <th
                  key={c}
                  className="text-left px-3 py-1.5 font-medium text-text-secondary border-b border-border-subtle whitespace-nowrap"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i} className="border-b border-border-subtle hover:bg-surface-hover">
                {columns.map((c) => {
                  const txt = formatCell(row[c]);
                  return (
                    <td
                      key={c}
                      title={txt}
                      className="px-3 py-1.5 text-text-primary whitespace-nowrap max-w-xs truncate"
                    >
                      {txt}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 text-text-tertiary text-xs border-t border-border-subtle">
        Showing first {shown.length} of {total.toLocaleString()} row
        {total === 1 ? '' : 's'}
      </div>
    </div>
  );
}
