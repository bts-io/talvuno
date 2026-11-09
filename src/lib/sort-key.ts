/**
 * The key contact names sort and search by: canonical decomposition (NFD), the combining diacritics U+0300 to
 * U+036F removed (the same set migration 0003 folds, so vowel signs in scripts like Devanagari stay), then
 * lowercased, so "Émile" sorts as "emile" and "Zoë" as "zoe". Stored in contacts.sort_key on every write.
 */
export function nameSortKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
