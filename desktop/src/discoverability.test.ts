import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..", "..");

describe("public discoverability copy", () => {
  it("keeps Chinese search phrases and the thin-shell positioning", async () => {
    const readme = await readFile(path.join(root, "README.md"), "utf8");
    const index = await readFile(path.join(root, "index.html"), "utf8");
    const compare = await readFile(path.join(root, "compare.html"), "utf8");

    for (const text of [readme, index, compare]) {
      expect(text).toContain("DeepSeek Harness Desktop");
      expect(text).toContain("Electron 桌面端");
      expect(text).toContain("不整仓拷贝");
      expect(text).toContain("Linux");
      expect(text).toContain("@deepseek-ai/dsh");
    }

    expect(index).toContain("compare.html");
    expect(compare).toContain("zhuquan7237/deepseek-harness-desktop");
    expect(readme).toContain("zhuquan7237/deepseek-harness-desktop");
    expect(readme).toContain("dsh.zhuquan.xyz");
    expect(index).toContain("dsh.zhuquan.xyz");
    expect(index).toContain("深海女仆工坊");
    expect(index).toContain("Small-tailqwq/dsh-deep-whale");
    expect(index).toContain("CC BY-NC-SA");
    expect(index).toContain("上善");
    expect(index).toContain("assets/desktop-preview.png");
    const cname = await readFile(path.join(root, "CNAME"), "utf8");
    expect(cname.trim()).toBe("dsh.zhuquan.xyz");
  });
});
