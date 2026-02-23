import { getPreferenceValues } from "@raycast/api";

type LanguageMap = {
    [key: string]: {
        [key: string]: string;
    };
};

const cn: Record<string, string> = {
    // Common
    "Mole Clean": "Mole Clean",
    "Search cleanup categories...": "Search cleanup categories...",
    "Loading...": "載入中...",
    "Scanning...": "掃描中...",

    // UI Elements
    "Clean All": "執行全部清理",
    "Rescan": "重新掃描",
    "Summary": "Summary",
    "System is clean!": "系統已經很乾淨！",
    "No items to clean": "沒有可清理的項目",
    "Scanning": "掃描中",
    "Clean": "清理",
    "Scan Failed": "掃描失敗",
    "Retry": "重試",

    // Status Strings
    "Nothing to clean": "Nothing to clean",
    "No large items detected in common locations": "No large items detected",
    "reclaimable": "可釋放: {size}",
    "items": "{items} 個項目",
    "categories": "{categories} 個分類",
    "cleaned_summary": "已釋放 {size}",
    "confirm_clean_title": "確認清理？",
    "confirm_clean_message": "將清理約 {size} 的快取、日誌和暫存檔案。此操作無法復原。",

    // Dynamic
    "scanning_category": "正在掃描 {name}...",
    "clean_category_title": "清理 {name}？",
    "clean_category_message": "將使用 Mole 引擎清理 {size}。此操作無法復原。",
    "cleaned_category": "已清理 {name}"
};

const en: Record<string, string> = {
    // Common
    "Mole Clean": "Mole Clean",
    "Search cleanup categories...": "Search cleanup categories...",
    "Loading...": "Loading...",
    "Scanning...": "Scanning...",

    // UI Elements
    "Clean All": "Clean All",
    "Rescan": "Rescan",
    "Summary": "Summary",
    "System is clean!": "System is already clean!",
    "No items to clean": "No items to clean",
    "Scanning": "Scanning",
    "Clean": "Clean",
    "Scan Failed": "Scan Failed",
    "Retry": "Retry",

    // Status Strings
    "Nothing to clean": "Nothing to clean",
    "No large items detected in common locations": "No large items detected",
    "reclaimable": "Reclaimable: {size}",
    "items": "{items} items",
    "categories": "{categories} categories",
    "cleaned_summary": "Freed {size}",
    "confirm_clean_title": "Confirm Cleanup?",
    "confirm_clean_message": "This will clean approximately {size} of caches, logs, and temp files. This action cannot be undone.",

    // Dynamic
    "scanning_category": "Scanning {name}...",
    "clean_category_title": "Clean {name}?",
    "clean_category_message": "Mole engine will clean {size}. This operation cannot be undone.",
    "cleaned_category": "Cleaned {name}"
};

const dictionaries: LanguageMap = {
    en,
    "zh-TW": cn,
    "system": cn // default fallback if Intl logic isn't complex enough initially
};

function getCurrentLanguage(): string {
    try {
        const prefs = getPreferenceValues<{ language?: string }>();
        if (prefs.language && prefs.language !== "system") {
            return prefs.language;
        }

        // Auto detect from system
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        if (locale.toLowerCase().startsWith("zh")) {
            return "zh-TW";
        }
        return "en";
    } catch {
        return "en"; // Safe fallback
    }
}

/**
 * Super lightweight translation hook mapping strings.
 */
export function t(key: string, replacements?: Record<string, string | number>): string {
    const lang = getCurrentLanguage();
    const dictionary = dictionaries[lang] || dictionaries["en"];
    let phrase = dictionary[key] || en[key] || key;

    if (replacements) {
        for (const [k, v] of Object.entries(replacements)) {
            phrase = phrase.replace(`{${k}}`, String(v));
        }
    }

    return phrase;
}
