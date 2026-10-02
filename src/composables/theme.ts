import { ref } from 'vue';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'actl-theme';
export const theme = ref<ThemeMode>('light');

export function setTheme(mode: ThemeMode): void {
  theme.value = mode;
  document.documentElement.dataset.theme = mode;
  localStorage.setItem(STORAGE_KEY, mode);
}

export function initializeTheme(): void {
  const saved = localStorage.getItem(STORAGE_KEY);
  theme.value = saved === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme.value;
}
