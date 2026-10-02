import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import zhCN from './locales/zh-CN';
import enUS from './locales/en-US';

function flatten(source: Record<string, unknown>, prefix = ''): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof value === 'string') entries[key] = value;
    else if (value && typeof value === 'object')
      Object.assign(entries, flatten(value as Record<string, unknown>, key));
  }
  return entries;
}

describe('language catalog', () => {
  const chinese = flatten(zhCN);
  const english = flatten(enUS);

  it('keeps keys and named parameters aligned', () => {
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort());
    for (const key of Object.keys(chinese)) {
      const parameters = (message: string) =>
        [...message.matchAll(/\{([a-zA-Z]\w*)\}/g)].map((match) => match[1]).sort();
      expect(parameters(english[key]), key).toEqual(parameters(chinese[key]));
    }
  });

  it('compiles every message in both languages', () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'zh-CN',
      messages: { 'zh-CN': zhCN, 'en-US': enUS },
    });
    for (const locale of ['zh-CN', 'en-US'] as const) {
      i18n.global.locale.value = locale;
      for (const [key, message] of Object.entries(locale === 'zh-CN' ? chinese : english)) {
        const named = Object.fromEntries(
          [...message.matchAll(/\{([a-zA-Z]\w*)\}/g)].map((match) => [match[1], 'example']),
        );
        expect(() => i18n.global.t(key, named), key).not.toThrow();
      }
    }
  });

  it('contains every literal key used by the frontend', () => {
    const files: string[] = [];
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'i18n') collect(file);
        } else if (/\.(ts|vue)$/.test(entry.name)) files.push(file);
      }
    };
    collect(resolve(__dirname, '..'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:\$t|\btr)\(\s*['"]([\w.]+)['"]/g)) {
        expect(Object.hasOwn(chinese, match[1]), `${file}: ${match[1]}`).toBe(true);
      }
    }
  });
});
