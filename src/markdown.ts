/**
 * markdown.ts — конвертация markdown → plain text для XMPP.
 * Порт _strip_markdown() из Hermes xmpp-adapter.
 */

/** Убирает markdown-разметку, не ломая текст. */
export function stripMarkdown(text: string): string {
  return (
    text
      // ```fenced code``` → содержимое с отступом
      .replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_m, code: string) => code.trim())
      // `inline code` → содержимое
      .replace(/`([^`]+)`/g, "$1")
      // **bold**, __bold__ → текст
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      // *italic*, _italic_ → текст
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/_([^_\n]+)_/g, "$1")
      // ~~strike~~ → текст
      .replace(/~~([^~]+)~~/g, "$1")
      // headers → plain
      .replace(/^#{1,6}\s+(.+)$/gm, "$1")
      // [link](url) → link
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      // images → alt
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
      // horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, "")
      // bullet lists
      .replace(/^\s*[-*+]\s+/gm, "• ")
      // numbered lists
      .replace(/^\s*\d+\.\s+/gm, "")
      // blockquotes
      .replace(/^\s*>\s?/gm, "")
      .trim()
  );
}

/** Разбивает длинный текст на куски ≤ maxLen, по границам абзацев/строк. */
export function chunkText(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    // Ищем точку разрыва: перевод строки ближе к концу лимита.
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = rest.lastIndexOf(" ", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
