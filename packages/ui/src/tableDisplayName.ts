import S from 'string';
import { Table } from '@proteinjs/db';

/**
 * Human title for a table's record collection: the humanized table name with its last word
 * pluralized — 'user' → 'Users', 'access_grant' → 'Access grants'. `Table` carries no display
 * metadata, so the name is derived; the pluralization is deliberately boring (s/es/ies) and
 * predictable rather than a full inflection library.
 */
export function tableDisplayName(table: Table<any>): string {
  const humanized = S(table.name).humanize().s;
  const words = humanized.split(' ');
  words[words.length - 1] = pluralize(words[words.length - 1]);
  return words.join(' ');
}

function pluralize(word: string): string {
  const lower = word.toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(lower)) {
    return `${word}es`;
  }

  if (/[^aeiou]y$/.test(lower)) {
    return `${word.slice(0, -1)}ies`;
  }

  return `${word}s`;
}
