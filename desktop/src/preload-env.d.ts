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
      mobilePairing: (options?: { ensure?: boolean }) => Promise<import("./mobile-pairing").PairingSnapshot>;
      mobileRotate: () => Promise<{ ok: boolean; error?: string }>;
      mobileCopy: (text: string) => Promise<{ ok: boolean }>;
      mobileRevoke: (id: string) => Promise<{ ok: boolean; error?: string }>;
      mobileOpenSearchSettings: () => Promise<{ ok: boolean; error?: string; url?: string }>;
      mobileOpenPairingSettings: () => Promise<{ ok: boolean; error?: string; url?: string }>;
      transferList: () => Promise<{ ok: boolean; error?: string; dir?: string; items?: unknown[] }>;
      transferAdd: () => Promise<{ ok: boolean; error?: string; added?: unknown[]; refused?: unknown[]; canceled?: boolean }>;
      transferDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
      transferOpenFolder: (dir: string) => Promise<{ ok: boolean; error?: string }>;
      desktopAction: (action: string) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}
