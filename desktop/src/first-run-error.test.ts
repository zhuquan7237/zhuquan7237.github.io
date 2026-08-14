import { describe, expect, it } from "vitest";
import {
  buildToolsHint,
  commandExistsArgs,
  explainFirstRunError,
  looksLikeFuseMissing,
  looksLikeNativeBuildError,
  looksLikeNetworkError,
  looksLikeXzMissing,
} from "./first-run-error";

describe("first-run error copy", () => {
  it("maps xz, network, node-gyp, and fuse failures to Chinese next steps", () => {
    expect(looksLikeXzMissing("xz: Cannot exec: No such file or directory")).toBe(true);
    expect(looksLikeNetworkError("TypeError: fetch failed")).toBe(true);
    expect(looksLikeNativeBuildError("gyp ERR! stack Error: `make` failed with exit code: 2")).toBe(true);
    expect(looksLikeNativeBuildError("not recovariable")).toBe(true);
    expect(looksLikeFuseMissing("dlopen(): error loading libfuse.so.2")).toBe(true);

    expect(explainFirstRunError(new Error("xz: Cannot exec: No such file or directory"), "node", "linux")).toContain(
      "不依赖系统 xz",
    );
    expect(explainFirstRunError(new Error("fetch failed"), "node", "linux")).toContain("需要联网");
    expect(explainFirstRunError(new Error("node-gyp not recovariable / make: not found"), "engine", "linux")).toContain(
      "build-essential",
    );
    expect(explainFirstRunError(new Error("xcode-select: error"), "engine", "darwin")).toContain("xcode-select --install");
    expect(explainFirstRunError(new Error("libfuse.so.2"), "start", "linux")).toContain("libfuse2");
    expect(explainFirstRunError(new Error("weird not recovariable dump"), "unknown", "linux")).toContain(
      "build-essential",
    );
  });

  it("builds the which/where probe without interpolating into a shell eval", () => {
    expect(commandExistsArgs("make", "linux")).toEqual({ command: "sh", args: ["-c", "command -v 'make'"] });
    expect(commandExistsArgs("g++", "win32").command).toBe("where.exe");
    expect(buildToolsHint("win32")).toContain("Visual Studio");
  });
});
