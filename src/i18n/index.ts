import { computed, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import zhCN from './locales/zh-CN';
import enUS from './locales/en-US';

export type AppLocale = 'zh-CN' | 'en-US';
export type LanguageMode = 'system' | AppLocale;

const STORAGE_KEY = 'actl-language';
export const languageMode = ref<LanguageMode>('system');
export const currentLocale = ref<AppLocale>('zh-CN');
export const effectiveLocale = computed(() => currentLocale.value);

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: currentLocale.value,
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN, 'en-US': enUS },
});

function systemLocale(): AppLocale {
  const locale = navigator.languages?.[0] || navigator.language || 'zh-CN';
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

function applyLanguage(): void {
  currentLocale.value = languageMode.value === 'system' ? systemLocale() : languageMode.value;
  i18n.global.locale.value = currentLocale.value;
  document.documentElement.lang = currentLocale.value;
}

export function setLanguageMode(mode: LanguageMode): void {
  languageMode.value = mode;
  localStorage.setItem(STORAGE_KEY, mode);
  applyLanguage();
}

export function initializeLanguage(): void {
  const saved = localStorage.getItem(STORAGE_KEY);
  languageMode.value = saved === 'zh-CN' || saved === 'en-US' ? saved : 'system';
  applyLanguage();
  window.addEventListener('languagechange', () => {
    if (languageMode.value === 'system') applyLanguage();
  });
}

export function tr(key: string, named?: Record<string, string | number>): string {
  // Reading this ref also makes calls inside computed values update immediately on language changes.
  void currentLocale.value;
  return named ? i18n.global.t(key, named) : i18n.global.t(key);
}
