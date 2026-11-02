// The site's languages, read by the page (i18n.js) and the server (the page head for ?lang=). Turkish is
// the source; each other language is a dictionary lang-<code>.mjs keyed by the Turkish text. `name` is the
// language in itself, `tag` goes into <html lang> (it also picks the browser's fonts for the script),
// `numbers` overrides the locale for numbers, `dir` marks right-to-left.
export const LANGS = {
  tr: { name: 'Türkçe', tag: 'tr' },
  en: { name: 'English', tag: 'en' },
  es: { name: 'Español', tag: 'es' },
  de: { name: 'Deutsch', tag: 'de' },
  fr: { name: 'Français', tag: 'fr' },
  pt: { name: 'Português', tag: 'pt-BR' },
  ja: { name: '日本語', tag: 'ja' },
  ko: { name: '한국어', tag: 'ko' },
  zh: { name: '中文', tag: 'zh-CN' },
  ru: { name: 'Русский', tag: 'ru' },
  ar: { name: 'العربية', tag: 'ar', numbers: 'ar-u-nu-latn', dir: 'rtl' },
};
