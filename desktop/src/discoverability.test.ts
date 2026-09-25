import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..", "..");
const read = (name: string) => readFile(path.join(root, name), "utf8");

/**
 * 官网改版（手机优先的统一入口）之后，桌面端的文案落在「深入页」上：
 * compare / mac / me / dl 承载桌面定位与下载，README 是文案基石。
 * 这个守卫盯的是**同一批短语不要丢**——每个短语至少在它该在的页面里存在。
 */
describe("public discoverability copy", () => {
  it("keeps Chinese search phrases and the thin-shell positioning", async () => {
    const readme = await read("README.md");
    const index = await read("index.html");
    const compare = await read("compare.html");
    const mac = await read("mac.html");
    const me = await read("me.html");
    const dl = await read("dl/index.html");

    // README：桌面端文案的基石，关键短语全量留在这一份里。
    for (const phrase of [
      "DeepSeek Harness Desktop",
      "Electron 桌面端",
      "不整仓拷贝",
      "Linux",
      "@deepseek-ai/dsh",
    ]) {
      expect(readme).toContain(phrase);
    }

    // 桌面深入页：产品名必须出现（下载页 / 对比页 / 关于我 / macOS 页）。
    for (const text of [compare, mac, me, dl]) {
      expect(text).toContain("DeepSeek Harness Desktop");
    }

    // 薄壳定位（不整仓拷贝 + Electron 桌面端）在对比页与关于页保留。
    for (const text of [compare, me]) {
      expect(text).toContain("不整仓拷贝");
      expect(text).toContain("Electron 桌面端");
    }

    // 新首页（统一入口）：品牌词、开源依赖与到桌面资料的链接。
    for (const phrase of ["DeepSeek Harness", "@deepseek-ai/dsh", "Linux"]) {
      expect(index).toContain(phrase);
    }
    expect(index).toContain("compare.html");
    expect(index).toContain("dsh.zhuquan.xyz");
    expect(index).toContain("dsh.zhuquan.xyz/dl/");

    // 皮肤作者与许可以及仓库指路。
    for (const text of [readme, compare, me]) {
      expect(text).toContain("深海女仆工坊");
    }
    for (const text of [readme, me]) {
      expect(text).toContain("上善");
    }
    for (const text of [readme, compare, me]) {
      expect(text).toContain("CC BY-NC-SA");
    }
    expect(readme).toContain("Small-tailqwq/dsh-deep-whale");
    expect(readme).toContain("assets/desktop-preview.png");
    expect(compare).toContain("zhuquan7237/deepseek-harness-desktop");
    expect(mac).toContain("compare.html");
    expect(dl).toContain("dsh.zhuquan.xyz");

    const cname = await read("CNAME");
    expect(cname.trim()).toBe("dsh.zhuquan.xyz");
  });
});
