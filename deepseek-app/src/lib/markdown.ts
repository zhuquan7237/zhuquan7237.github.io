const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"]/g, (char) => ESCAPE[char] ?? char);
}

export function renderMarkdown(source: string): string {
  const fences: string[] = [];
  const withFences = source.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const index = fences.length;
    fences.push(
      `<pre class="md-code" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
    );
    return `\u0000FENCE${index}\u0000`;
  });

  const html = withFences
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("\u0000FENCE")) return trimmed;
      if (/^#{1,3} /.test(trimmed)) {
        const level = trimmed.match(/^#+/)?.[0].length ?? 1;
        return `<h${level}>${inline(trimmed.replace(/^#{1,3} /, ""))}</h${level}>`;
      }
      if (/^[-*] /.test(trimmed) || /^\d+\. /.test(trimmed)) {
        const items = trimmed.split("\n").map((line) => `<li>${inline(line.replace(/^([-*] |\d+\. )/, ""))}</li>`);
        const ordered = /^\d+\. /.test(trimmed);
        return `<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`;
      }
      if (trimmed.startsWith("> ")) {
        return `<blockquote>${inline(trimmed.replace(/^> /gm, ""))}</blockquote>`;
      }
      return `<p>${inline(trimmed.replaceAll("\n", "<br />"))}</p>`;
    })
    .join("");

  return html.replace(/\u0000FENCE(\d+)\u0000/g, (_match, index) => fences[Number(index)] ?? "");
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}
