import path from 'node:path'

export function backendEnvironment({ dataDirectory, resourceDirectory, settings, token, source = process.env }) {
    // Do not inherit the developer's accounts, proxy, Node injection or CONFIG_*.
    const env = {}
    for (const key of [
        'PATH',
        'Path',
        'SystemRoot',
        'SYSTEMROOT',
        'WINDIR',
        'TEMP',
        'TMP',
        'TMPDIR',
        'HOME',
        'USERPROFILE',
        'LOCALAPPDATA',
        'APPDATA',
        'COMSPEC',
        'LANG',
        'DISPLAY',
        'WAYLAND_DISPLAY',
        'XDG_RUNTIME_DIR'
    ]) {
        if (source[key]) env[key] = source[key]
    }
    return {
        ...env,
        MRS_DATA_DIR: dataDirectory,
        MRS_RESOURCE_DIR: resourceDirectory,
        PLAYWRIGHT_BROWSERS_PATH: path.join(resourceDirectory, 'browsers'),
        API_HOST: '127.0.0.1',
        API_PORT: '0',
        API_TOKEN: token,
        API_CORS_ORIGIN: 'null',
        API_DIAGNOSTICS_DIR: path.join(dataDirectory, 'diagnostics'),
        API_ALLOW_CONFIG_WRITE: 'false',
        API_ALLOW_SCHEDULE_WRITE: 'false',
        API_ALLOW_CONFIG_REVEAL: 'false',
        API_ALLOW_ENV_OVERRIDES: 'false',
        ACCOUNT_1_EMAIL: settings.email,
        ACCOUNT_1_GEO_LOCALE: 'CN',
        ACCOUNT_1_LANG_CODE: 'zh-CN',
        ACCOUNT_1_SAVE_FINGERPRINT_MOBILE: 'true',
        ACCOUNT_1_SAVE_FINGERPRINT_DESKTOP: 'true',
        CONFIG_TASKS_ONLY: 'true',
        FORCE_HEADLESS: '1',
        CONFIG_WORKER_DESKTOP_SEARCH: 'false',
        CONFIG_WORKER_MOBILE_SEARCH: 'false',
        CONFIG_WORKER_BONUS_SEARCHES: 'false',
        CONFIG_AUTO_SYNC: 'false',
        TZ: 'Asia/Shanghai',
        NO_COLOR: '1'
    }
}
