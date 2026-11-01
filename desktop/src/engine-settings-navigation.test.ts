import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/** Execute the exact browser script embedded in the desktop main process. */
function navigationScript(labels: string[]): string {
  const source = readFileSync(path.join(__dirname, "main.ts"), "utf8");
  const match = source.match(/const script = `([\s\S]*?)`;\s*try \{\s*const result = \(await mainWindow\.webContents\.executeJavaScript\(script, true\)/);
  if (!match) throw new Error("Desktop settings navigation script was not found");
  return match[1].replaceAll("${labelList}", JSON.stringify(labels));
}

/** Minimal interactive DOM with the same account-menu → settings-dialog contract as dsh. */
function fixture(options: {
  locale?: "zh" | "en"; legacy?: boolean; alreadyOpen?: boolean; missingSection?: boolean;
  chatDecoy?: boolean; settingsDecoy?: boolean; chatSettings?: "link" | "button";
  noAccount?: boolean; noMenuItem?: boolean; alreadyMenuOpen?: boolean; otherMenu?: boolean;
  fakeAccountInChat?: boolean; unrelatedDialog?: boolean; sectionOnlyInContent?: boolean;
  fakeSidebarInChat?: boolean; fakeDialogInChat?: boolean;
} = {}) {
  const en = options.locale === "en";
  const accountLabel = en ? "Account menu" : "账号菜单";
  const settingsLabel = en ? "Settings" : "设置";
  const section = en ? "Search engines" : "搜索引擎";
  let selected = "";
  let accountClicks = 0;
  let chatClicks = 0;
  let otherClicks = 0;
  type Handler = () => void;
  class Element {
    children: Element[] = [];
    parentElement: Element | null = null;
    constructor(public tagName: string, public textContent = "", public attrs: Record<string, string> = {}, public handler?: Handler) {}
    append(...children: Element[]) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
    getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
    getClientRects(): number[] { return [1]; }
    getBoundingClientRect() { return { x: 0, y: 0, width: 40, height: 20 }; }
    matches(selector: string): boolean {
      return selector.split(",").some((part) => {
        const token = part.trim();
        if (token === "*") return true;
        const match = token.match(/^(?:([a-z]+))?(?:\[([^=\]]+)="([^"]+)"\])?$/i);
        return Boolean(match && (match[1] || match[2]) && (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || this.attrs[match[2]] === match[3]));
      });
    }
    querySelectorAll(selector: string): Element[] {
      const result: Element[] = [];
      const visit = (parent: Element) => { for (const child of parent.children) { if (child.matches(selector)) result.push(child); visit(child); } };
      visit(this);
      return result;
    }
    querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector: string): Element | null {
      let el: Element | null = this;
      while (el) { if (el.matches(selector)) return el; el = el.parentElement; }
      return null;
    }
    contains(el: Element): boolean { return this === el || this.children.some((child) => child.contains(el)); }
    click() { let el: Element | null = this; while (el) { el.handler?.(); el = el.parentElement; } }
    dispatchEvent(event: { type: string }) { if (event.type === "click") this.click(); return true; }
  }
  const node = (tag: string, text: string, attrs: Record<string, string> = {}, onClick?: Handler) => {
    const parent = new Element(tag, text, attrs, onClick);
    parent.append(new Element("SPAN", text));
    return parent;
  };
  const body = new Element("BODY");
  const sidebarRoot = new Element("DIV", "", { "data-slot": "sidebar" });
  const sidebar = new Element("DIV", "", { "data-slot": "sidebar.settings" });
  const chat = new Element("DIV", "", { "data-slot": "conversation.chat.node" });
  sidebarRoot.append(sidebar);
  body.append(sidebarRoot, chat);
  const showDialog = () => {
    const dialog = new Element("DIV", "", { role: "dialog" });
    const nav = new Element("NAV");
    nav.append(new Element("DIV", settingsLabel, { "data-slot": "settings.header" }));
    if (!options.missingSection && !options.sectionOnlyInContent) nav.append(node("BUTTON", section, {}, () => { selected = section; }));
    dialog.append(nav);
    if (options.sectionOnlyInContent) dialog.append(node("BUTTON", section, {}, () => { otherClicks++; }));
    body.append(dialog);
  };
  let menu: Element | null = null;
  const showMenu = () => {
    menu = new Element("DIV", "", { role: "menu" });
    if (!options.noMenuItem) menu.append(node("BUTTON", settingsLabel, { role: "menuitem" }, () => { menu?.remove(); menu = null; showDialog(); }));
    body.append(menu);
  };
  if (options.legacy) sidebar.append(node("BUTTON", settingsLabel, { "aria-label": settingsLabel, "aria-haspopup": "dialog" }, showDialog));
  else if (!options.noAccount) {
    const account = node("BUTTON", en ? "More" : "更多", { "aria-label": accountLabel, "aria-haspopup": "menu", "aria-expanded": "false" }, () => {
      accountClicks++;
      if (menu) { menu.remove(); menu = null; account.attrs["aria-expanded"] = "false"; }
      else { showMenu(); account.attrs["aria-expanded"] = "true"; }
    });
    sidebar.append(account);
    if (options.alreadyMenuOpen) { showMenu(); account.attrs["aria-expanded"] = "true"; }
  }
  if (options.chatDecoy) chat.append(node("DIV", section, {}, () => { chatClicks++; }));
  if (options.settingsDecoy) chat.append(node("DIV", settingsLabel, {}, () => { chatClicks++; }));
  if (options.chatSettings) chat.append(node(options.chatSettings === "link" ? "A" : "BUTTON", settingsLabel, { "aria-label": settingsLabel }, () => { chatClicks++; }));
  if (options.fakeAccountInChat) chat.append(node("BUTTON", accountLabel, { "aria-label": accountLabel, "aria-haspopup": "menu" }, () => { chatClicks++; }));
  if (options.fakeSidebarInChat) {
    sidebar.remove();
    const fake = new Element("DIV", "", { "data-slot": "sidebar.settings" });
    fake.append(node("BUTTON", accountLabel, { "aria-label": accountLabel, "aria-haspopup": "menu" }, () => { chatClicks++; }));
    chat.append(fake);
  }
  if (options.fakeDialogInChat) {
    const fake = new Element("DIV", "", { role: "dialog" });
    const nav = new Element("NAV");
    nav.append(new Element("DIV", settingsLabel, { "data-slot": "settings.header" }), node("BUTTON", section, {}, () => { chatClicks++; }));
    fake.append(nav);
    chat.append(fake);
  }
  if (options.otherMenu) {
    const unrelated = new Element("DIV", "", { role: "menu" });
    unrelated.append(node("BUTTON", settingsLabel, { role: "menuitem" }, () => { otherClicks++; }));
    body.append(unrelated);
  }
  if (options.unrelatedDialog) {
    const unrelated = new Element("DIV", "", { role: "dialog" });
    unrelated.append(node("BUTTON", section, {}, () => { otherClicks++; }));
    body.append(unrelated);
  }
  if (options.alreadyOpen) showDialog();
  const document = {
    body,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    querySelector: (selector: string) => body.querySelector(selector),
  };
  const window = {};
  class MouseEvent { constructor(public type: string) {} }
  async function run() {
    return await runInNewContext(navigationScript([section]), { document, window, MouseEvent, setTimeout: (cb: () => void) => cb() }) as { ok: boolean; error?: string };
  }
  return { run, selected: () => selected, accountClicks: () => accountClicks, chatClicks: () => chatClicks, otherClicks: () => otherClicks, section };
}

describe("engine settings deep links", () => {
  for (const locale of ["zh", "en"] as const) {
    it(`opens the ${locale} settings section via the account menu`, async () => {
      const dom = fixture({ locale });
      expect(await dom.run()).toEqual({ ok: true });
      expect(dom.accountClicks()).toBe(1);
      expect(dom.selected()).toBe(dom.section);
    });
  }
  for (const locale of ["zh", "en"] as const) {
    it(`keeps the older ${locale} direct settings launcher safe with a chat decoy`, async () => {
      const dom = fixture({ locale, legacy: true, chatSettings: "link" });
      expect(await dom.run()).toEqual({ ok: true });
      expect(dom.chatClicks()).toBe(0);
      expect(dom.selected()).toBe(dom.section);
    });
  }
  it("selects an already-open section without reopening the account menu", async () => {
    const dom = fixture({ alreadyOpen: true });
    expect(await dom.run()).toEqual({ ok: true });
    expect(dom.selected()).toBe(dom.section);
    expect(dom.accountClicks()).toBe(0);
  });
  it("ignores a matching chat message and opens the real settings section", async () => {
    const dom = fixture({ chatDecoy: true });
    expect(await dom.run()).toEqual({ ok: true });
    expect(dom.accountClicks()).toBe(1);
    expect(dom.selected()).toBe(dom.section);
  });
  it("ignores a standalone settings word in chat and opens the account menu", async () => {
    const dom = fixture({ settingsDecoy: true });
    expect(await dom.run()).toEqual({ ok: true });
    expect(dom.accountClicks()).toBe(1);
    expect(dom.selected()).toBe(dom.section);
  });
  for (const locale of ["zh", "en"] as const) {
    for (const chatSettings of ["link", "button"] as const) {
      it(`never clicks a ${locale} chat ${chatSettings} named Settings`, async () => {
        const dom = fixture({ locale, chatSettings });
        const result = await dom.run();
        expect(dom.chatClicks()).toBe(0);
        expect(result).toEqual({ ok: true });
        expect(dom.accountClicks()).toBe(1);
        expect(dom.selected()).toBe(dom.section);
      });
    }
  }
  it("reopens an already-open account menu without touching an unrelated menu", async () => {
    const dom = fixture({ alreadyMenuOpen: true, otherMenu: true });
    expect(await dom.run()).toEqual({ ok: true });
    expect(dom.accountClicks()).toBe(2);
    expect(dom.otherClicks()).toBe(0);
    expect(dom.selected()).toBe(dom.section);
  });
  it("ignores an unrelated menu and dialog with matching labels", async () => {
    const dom = fixture({ otherMenu: true, unrelatedDialog: true });
    expect(await dom.run()).toEqual({ ok: true });
    expect(dom.otherClicks()).toBe(0);
    expect(dom.selected()).toBe(dom.section);
  });
  it("fails closed instead of clicking fake chat launchers when the account is absent", async () => {
    const dom = fixture({ noAccount: true, fakeAccountInChat: true, chatSettings: "button" });
    expect((await dom.run()).ok).toBe(false);
    expect(dom.chatClicks()).toBe(0);
  });
  it("ignores a forged sidebar settings slot inside chat", async () => {
    const dom = fixture({ fakeSidebarInChat: true });
    expect((await dom.run()).ok).toBe(false);
    expect(dom.chatClicks()).toBe(0);
  });
  it("ignores a forged settings dialog inside chat", async () => {
    const dom = fixture({ fakeDialogInChat: true });
    expect(await dom.run()).toEqual({ ok: true });
    expect(dom.chatClicks()).toBe(0);
    expect(dom.selected()).toBe(dom.section);
  });
  it("fails closed when the account menu has no settings entry", async () => {
    const dom = fixture({ noMenuItem: true, otherMenu: true, chatSettings: "link" });
    expect((await dom.run()).ok).toBe(false);
    expect(dom.chatClicks()).toBe(0);
    expect(dom.otherClicks()).toBe(0);
  });
  it("does not mistake content inside the settings dialog for a navigation item", async () => {
    const dom = fixture({ alreadyOpen: true, sectionOnlyInContent: true });
    expect((await dom.run()).ok).toBe(false);
    expect(dom.otherClicks()).toBe(0);
    expect(dom.accountClicks()).toBe(0);
  });
  it("reports when the requested plugin section is missing", async () => {
    const dom = fixture({ missingSection: true });
    expect((await dom.run()).ok).toBe(false);
    expect(dom.selected()).toBe("");
  });
});
