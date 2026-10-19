export type NativeTheme = 'light' | 'dark' | 'system';
export interface NativePreferences {
  theme: NativeTheme;
  connection: 'local' | 'web';
  url: string;
  localAvailable: boolean;
}
