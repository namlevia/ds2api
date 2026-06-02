import { useI18n } from '../i18n'

export default function LanguageToggle({ className = '' }) {
    const { lang, setLang, t } = useI18n()

    return (
        <select
            value={lang}
            onChange={(event) => setLang(event.target.value)}
            className={`text-xs font-semibold px-2 py-1 rounded-md border border-border bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors ${className}`}
            title={t('language.label')}
            aria-label={t('language.label')}
        >
            <option value="zh">{t('language.chinese')}</option>
            <option value="en">{t('language.english')}</option>
            <option value="vi">{t('language.vietnamese')}</option>
        </select>
    )
}
