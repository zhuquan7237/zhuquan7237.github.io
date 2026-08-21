export {};

declare global {
  interface Window {
    desktop: {
      onStatus: (handler: (payload: { phase: string; text: string }) => void) => void;
      onLog: (handler: (line: string) => void) => void;
      getVersion: () => Promise<string>;
      getSettings: () => Promise<import("./util").DesktopSettings>;
      saveSettings: (settings: import("./util").DesktopSettings) => Promise<import("./util").DesktopSettings>;
      pickDir: () => Promise<string>;
      apply: () => void;
      quit: () => void;
      retry: () => void;
      listSkins: () => Promise<import("./skins").SkinCard[]>;
      selectSkin: (id: string) => Promise<void>;
      setSkinsEnabled: (enabled: boolean) => Promise<void>;
      importSkinDir: () => Promise<void>;
      importSkinUrl: (url: string) => Promise<void>;
    };
  }
}
