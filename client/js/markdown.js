/**
 * Simple Markdown renderer with security filtering.
 *
 * Converts a subset of Markdown to HTML, with XSS prevention:
 * - HTML entities are escaped
 * - Only safe URL schemes (https, http, mailto, #) are allowed in links
 * - Quote characters in URLs are escaped to prevent attribute injection
 */

export function renderMarkdown(text) {
  // Escape HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks: ```lang\n...\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trimEnd()}</code></pre>`;
  });

  // Inline code (must come after fenced blocks)
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic: *text*
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  // Links: [text](url) — only allow safe URL schemes
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    if (/^(https?:|mailto:|#)/i.test(url)) {
      const safeUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `<a href="${safeUrl}" target="_blank" rel="noopener">${text}</a>`;
    }
    return text; // Strip link for unsafe schemes (javascript:, data:, etc.)
  });

  // Process lines for lists and paragraphs
  const lines = html.split('\n');
  let result = '';
  let inUl = false;
  let inOl = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip lines inside <pre> blocks
    if (line.includes('<pre>')) {
      // Find the closing </pre> and pass through
      let block = line;
      let j = i;
      while (!block.includes('</pre>') && j < lines.length - 1) {
        j++;
        block += '\n' + lines[j];
      }
      result += block + '\n';
      i = j;
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^[\s]*[-*]\s+(.+)/);
    if (ulMatch) {
      if (inOl) { result += '</ol>'; inOl = false; }
      if (!inUl) { result += '<ul>'; inUl = true; }
      result += `<li>${ulMatch[1]}</li>`;
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^[\s]*\d+\.\s+(.+)/);
    if (olMatch) {
      if (inUl) { result += '</ul>'; inUl = false; }
      if (!inOl) { result += '<ol>'; inOl = true; }
      result += `<li>${olMatch[1]}</li>`;
      continue;
    }

    // Close open lists
    if (inUl) { result += '</ul>'; inUl = false; }
    if (inOl) { result += '</ol>'; inOl = false; }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length + 2; // h3-h5 inside messages
      result += `<h${level}>${headingMatch[2]}</h${level}>`;
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === '') {
      result += '<br>';
      continue;
    }

    result += line + '\n';
  }

  // Close any open lists
  if (inUl) result += '</ul>';
  if (inOl) result += '</ol>';

  // Replace double <br> with paragraph breaks
  result = result.replace(/(<br>\s*){2,}/g, '</p><p>');

  // Trim trailing newlines
  result = result.replace(/\n+$/, '');

  return result;
}
