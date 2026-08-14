export {};

declare global {
  interface Window {
    desktop: {
      onStatus: (handler: (payload: { phase: string; text: string }) => void) => void;
      onLog: (handler: (line: string) => void) => void;
      getSettings: () => Promise<import("./util").DesktopSettings>;
      saveSettings: (settings: import("./util").DesktopSettings) => Promise<import("./util").DesktopSettings>;
      pickDir: () => Promise<string>;
      apply: () => void;
      quit: () => void;
    };
  }
}
