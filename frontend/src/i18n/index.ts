import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './zh.json'
import en from './en.json'

const saved = localStorage.getItem('prismx_lang') || 'zh'

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: saved,
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
})

export function setLanguage(lang: 'zh' | 'en') {
  i18n.changeLanguage(lang)
  localStorage.setItem('prismx_lang', lang)
}

export default i18n
