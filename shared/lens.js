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

export function submitImageForm({ dataUrl, actionUrl, target = '_self' }) {
  if (typeof dataUrl !== 'string' || typeof actionUrl !== 'string') {
    throw new Error('Invalid image upload data');
  }
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Invalid image upload data');

  const mime = (dataUrl.slice(5, comma).split(';')[0] || 'image/png').trim();
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const form = document.createElement('form');
  form.method = 'POST';
  form.enctype = 'multipart/form-data';
  form.action = actionUrl;
  form.target = target;
  form.acceptCharset = 'UTF-8';
  form.hidden = true;

  const input = document.createElement('input');
  input.type = 'file';
  input.name = 'encoded_image';
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], 'crop.png', { type: mime }));
  input.files = transfer.files;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  setTimeout(() => form.remove(), 0);
}
