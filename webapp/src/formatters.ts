export function formatPropertyTypeLabel(value: string | null | undefined): string {
  if (!value?.trim()) return 'Property';
  return value
    .trim()
    .replace(/(^|[\s/(-])([\p{L}])/gu, (_match, separator: string, letter: string) =>
      `${separator}${letter.toLocaleUpperCase()}`,
    );
}
