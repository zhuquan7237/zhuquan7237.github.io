const INSTALLER = /^DeepSeek-(\d+\.\d+\.\d+)-.+\.(exe|dmg|deb|zip|AppImage|tar\.gz)$/;
const GITHUB_REPO = "zhuquan7237/zhuquan7237.github.io";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const name = decodeURIComponent(url.pathname.split("/").pop() || "");
    const match = name.match(INSTALLER);
    if (!match) {
      const file = name && name !== "dl" ? name : "index.html";
      const raw = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/dl/${file}`;
      const page = await fetch(raw, { headers: { "User-Agent": "DeepSeek-Desktop-Proxy" } });
      if (!page.ok) return new Response("Not found", { status: 404 });
      const type = file.endsWith(".json") ? "application/json; charset=utf-8" : "text/html; charset=utf-8";
      return new Response(page.body, {
        status: 200,
        headers: { "Content-Type": type, "Cache-Control": "public, max-age=300" },
      });
    }

    const version = match[1];
    const upstreamUrl = `https://github.com/${GITHUB_REPO}/releases/download/desktop-v${version}/${name}`;
    const headers = new Headers();
    headers.set("User-Agent", "DeepSeek-Desktop-Proxy");
    headers.set("Accept", "application/octet-stream");
    const range = request.headers.get("Range");
    if (range) headers.set("Range", range);

    const upstream = await fetch(upstreamUrl, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
    });

    const out = new Headers(upstream.headers);
    out.set("Cache-Control", "public, max-age=86400, immutable");
    out.set("Access-Control-Allow-Origin", "*");
    out.set("Content-Disposition", `attachment; filename="${name}"`);
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: out,
    });
  },
};
