// Shared by the server and the browser: keep this module free of Node imports.
// `prompt` names the language for the model; `label` is shown in the picker.
export const languages = [
  { code: 'zh-CN', label: '简体中文', prompt: '简体中文' },
  { code: 'zh-TW', label: '繁體中文', prompt: '繁體中文（台灣常用字詞）' },
  { code: 'en', label: 'English', prompt: 'English' },
  { code: 'ja', label: '日本語', prompt: '日本語' },
  { code: 'ko', label: '한국어', prompt: '한국어' },
  { code: 'fr', label: 'Français', prompt: 'Français' },
  { code: 'de', label: 'Deutsch', prompt: 'Deutsch' },
  { code: 'es', label: 'Español', prompt: 'Español' },
  { code: 'pt-BR', label: 'Português', prompt: 'Português (Brasil)' },
  { code: 'ru', label: 'Русский', prompt: 'Русский' },
];
export const defaultLanguage = 'zh-CN';

export function findLanguage(code) {
  return languages.find(language => language.code === code) || null;
}

export function languageOf(article) {
  return findLanguage(article?.targetLanguage) || findLanguage(defaultLanguage);
}

// Map a BCP 47 locale such as `en-US`, `zh-Hant-HK` or `pt` to a supported code.
export function languageFromLocale(locale) {
  if (typeof locale !== 'string' || !locale.trim()) return null;
  const value = locale.trim().toLowerCase().replace(/_/g, '-');
  const exact = languages.find(language => language.code.toLowerCase() === value);
  if (exact) return exact.code;
  const [base] = value.split('-');
  if (base === 'zh') return /-(?:hant|tw|hk|mo)\b/.test(value) ? 'zh-TW' : 'zh-CN';
  if (base === 'pt') return 'pt-BR';
  return languages.find(language => language.code === base)?.code || null;
}
