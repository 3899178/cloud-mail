import { fail } from './index.mjs';

export function parseMailSearch(search = '', searchField = 'all') {
  if (typeof search !== 'string' || search.length > 200 || /[\u0000-\u001f\u007f]/u.test(search) ||
      !['all', 'subject', 'sender', 'body'].includes(searchField)) fail('INVALID_INPUT');
  return { text: search.trim(), field: searchField };
}

// Callers supply fixed, source-specific column maps, never request values.
// Escape LIKE metacharacters so a search always means a literal substring.
export function mailSearchPredicate(search, columns) {
  if (!search.text) return { sql: '', args: [] };
  const names = search.field === 'all' ? Object.values(columns).flat() : columns[search.field];
  if (!Array.isArray(names) || !names.length || names.some(name => !/^[a-z_][a-z_0-9]*(\.[a-z_][a-z_0-9]*)?$/i.test(name))) fail('INVALID_INPUT');
  const pattern = '%' + search.text.replace(/[!%_]/g, '!$&') + '%';
  return { sql: '(' + names.map(name => `${name} LIKE ? ESCAPE '!'`).join(' OR ') + ')', args: names.map(() => pattern) };
}
