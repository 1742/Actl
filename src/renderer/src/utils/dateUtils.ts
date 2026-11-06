import { currentLocale, tr } from '../i18n';
export function toDate(value?: string): Date {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function formatDateEn(date: string): string {
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateCn(date: string): string {
  return new Date(date).toLocaleDateString('zh-CN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatRelativeTime(dateStr: string | Date): string {
  const now = new Date();
  const postDate = new Date(dateStr);
  const diffInSeconds = Math.floor((now.getTime() - postDate.getTime()) / 1000);

  if (!Number.isFinite(diffInSeconds)) return '';
  if (diffInSeconds < 60) return tr('ui.justNow');
  const relative = new Intl.RelativeTimeFormat(currentLocale.value, { numeric: 'always' });
  if (diffInSeconds < 3600) return relative.format(-Math.floor(diffInSeconds / 60), 'minute');
  if (diffInSeconds < 86400) return relative.format(-Math.floor(diffInSeconds / 3600), 'hour');

  return postDate.toLocaleDateString(currentLocale.value, {
    month: 'short',
    day: 'numeric',
  });
}
