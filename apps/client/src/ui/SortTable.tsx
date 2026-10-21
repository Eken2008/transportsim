import { useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  label: string;
  /** What the column sorts by; columns without one don't sort. */
  sort?: (row: T) => number | string;
  render: (row: T) => ReactNode;
  /** Text columns (left-aligned, sorted A–Z first); numbers are right-aligned and sorted largest first. */
  text?: boolean;
  /** Fixed width in pixels. */
  width?: number;
}

/** Rows shown at most; the rest are reached by searching or filtering. */
export const MAX_ROWS = 200;

/** A table whose headers sort it (click again to reverse), showing at most MAX_ROWS rows. */
export function SortTable<T>({ rows, columns, rowKey, initial, rowClass, empty }: {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string | number;
  /** The column sorted by at first. */
  initial: string;
  rowClass?: (row: T) => string | undefined;
  empty: ReactNode;
}) {
  const [sort, setSort] = useState<{ key: string; desc: boolean }>(() => ({ key: initial, desc: !columns.find((c) => c.key === initial)?.text }));
  const col = columns.find((c) => c.key === sort.key && c.sort);
  const sorted = col
    ? [...rows].sort((a, b) => {
        const x = col.sort!(a);
        const y = col.sort!(b);
        const d = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) : (x as number) - (y as number);
        return sort.desc ? -d : d;
      })
    : rows;
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
    <>
      <div className="table-scroll">
        <table className="vlist">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={c.text ? 'left' : ''}
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined}
                >
                  {c.sort ? (
                    <button className="ghost sort" title={`Sort by ${c.label.toLowerCase()}`} onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: !c.text }))}>
                      {c.label}
                      {sort.key === c.key && (sort.desc ? ' ▾' : ' ▴')}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, MAX_ROWS).map((r) => (
              <tr key={rowKey(r)} className={rowClass?.(r)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.text ? 'left' : ''}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_ROWS && (
        <p className="muted small">
          Showing {MAX_ROWS} of {rows.length.toLocaleString('en-GB')}. Search or filter to find the rest.
        </p>
      )}
    </>
  );
}
