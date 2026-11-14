export function normalizeLang(raw) {
  const value = String(raw || '').replace(/_/g, '-');
  const match = /^([a-zA-Z]{2,3})(?:-([a-zA-Z]{2,4}))?$/.exec(value);
  if (!match) return 'en';
  const base = match[1].toLowerCase();
  return match[2] ? `${base}-${match[2].toUpperCase()}` : base;
}

export function buildUploadUrl(lang) {
  const url = new URL('/v3/upload', 'https://lens.google.com');
  url.searchParams.set('hl', normalizeLang(lang));
  return url.toString();
}
