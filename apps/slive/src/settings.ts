export function mountSettings(hasDrafts: () => boolean): { open: () => boolean } {
  const invoke = window.__TAURI__.core.invoke;
  const dialog = document.getElementById('settings-dialog') as HTMLDialogElement;
  const status = document.getElementById('settings-status')!;
  const form = document.getElementById('connection-form') as HTMLFormElement;
  const url = document.getElementById('connection-url') as HTMLInputElement;
  const apply = document.getElementById('connection-apply') as HTMLButtonElement;
  const themes = [...document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')];
  const radios = [...form.querySelectorAll<HTMLInputElement>('[name=connection]')];
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  let theme: NativeTheme = 'light';
  let busy = false;
  const appearance = (value: NativeTheme): void => {
    theme = value;
    document.documentElement.dataset.theme =
      value === 'system' ? (systemTheme.matches ? 'dark' : 'light') : value;
    themes.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === value)),
    );
  };
  systemTheme.addEventListener('change', () => appearance(theme));
  void window.__TAURI__.event.listen('appearance', (event) => appearance(event.payload));
  const connection = (): 'local' | 'web' =>
    radios.find((radio) => radio.checked)?.value === 'local' ? 'local' : 'web';
  const drawConnection = (): void => {
    const web = connection() === 'web';
    url.disabled = !web;
    url.required = web;
    for (const id of ['connection-url-label', 'connection-url', 'connection-hint'])
      document.getElementById(id)!.hidden = !web;
  };
  const populate = (settings: NativePreferences): void => {
    appearance(settings.theme);
    url.value = settings.url;
    radios.forEach((radio) => {
      radio.checked = radio.value === settings.connection;
      radio.disabled = radio.value === 'local' && !settings.localAvailable;
    });
    document.getElementById('local-unavailable')!.hidden = settings.localAvailable;
    drawConnection();
  };
  const load = async (): Promise<void> => {
    try {
      populate(await invoke('settings_get'));
    } catch {
      status.textContent = '設定を読み込めませんでした';
    }
  };
  void load();
  document.querySelectorAll<HTMLButtonElement>('[data-open-settings]').forEach((button) => {
    button.onclick = async () => {
      status.textContent = '';
      await load();
      dialog.showModal();
    };
  });
  document.getElementById('settings-close')!.onclick = () => {
    if (!busy) dialog.close();
  };
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  radios.forEach((radio) => {
    radio.onchange = drawConnection;
  });
  themes.forEach((button) => {
    button.onclick = async () => {
      const choice = button.dataset.themeChoice as NativeTheme;
      themes.forEach((item) => {
        item.disabled = true;
      });
      status.textContent = '';
      try {
        await invoke('settings_theme', { theme: choice });
        appearance(choice);
      } catch {
        status.textContent = '外観を保存できませんでした';
      } finally {
        themes.forEach((item) => {
          item.disabled = false;
        });
      }
    };
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (hasDrafts()) {
      status.textContent = '未保存のノートがあります。保存してから接続先を変更してください。';
      return;
    }
    busy = true;
    apply.disabled = true;
    radios.forEach((radio) => {
      radio.disabled = true;
    });
    url.readOnly = true;
    status.textContent = '接続先を確認中…';
    try {
      await invoke('settings_connect', { connection: connection(), url: url.value.trim() });
      status.textContent = '再起動しています…';
      await invoke('settings_restart');
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busy = false;
      apply.disabled = false;
      url.readOnly = false;
      // Keep the entered URL after a failed request.
      try {
        const current = await invoke('settings_get');
        radios.forEach((radio) => {
          radio.disabled = radio.value === 'local' && !current.localAvailable;
        });
      } catch {
        /* The error above remains visible. */
      }
    }
  };
  return { open: () => dialog.open };
}
