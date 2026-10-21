export function formatPropertyTypeLabel(value: string | null | undefined): string {
  if (!value?.trim()) return 'Property';
  return value
    .trim()
    .replace(/(^|[\s/(-])([\p{L}])/gu, (_match, separator: string, letter: string) =>
      `${separator}${letter.toLocaleUpperCase()}`,
    );
}

export function formatLocationLabel(value: string | null | undefined): string {
  if (!value?.trim()) return 'Location unknown';
  return value.trim().replace(/_/g, ' ').replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

export function formatUsd(value: number): string {
  return `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)}`;
}
