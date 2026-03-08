import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../js/markdown.js';

describe('renderMarkdown', () => {
  describe('HTML escaping', () => {
    it('escapes < to prevent tag injection', () => {
      const result = renderMarkdown('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('escapes & character', () => {
      expect(renderMarkdown('a & b')).toContain('&amp;');
    });

    it('escapes > character', () => {
      expect(renderMarkdown('a > b')).toContain('&gt;');
    });
  });

  describe('code blocks', () => {
    it('renders fenced code blocks with language', () => {
      const input = '```js\nconsole.log("hi")\n```';
      const result = renderMarkdown(input);
      expect(result).toContain('<pre><code class="lang-js">');
      expect(result).toContain('console.log');
    });

    it('renders fenced code blocks without language', () => {
      const input = '```\nplain code\n```';
      const result = renderMarkdown(input);
      expect(result).toContain('<pre><code class="lang-">');
      expect(result).toContain('plain code');
    });

    it('renders inline code', () => {
      expect(renderMarkdown('use `npm install`')).toContain('<code>npm install</code>');
    });

    it('does not render inline code across lines', () => {
      const input = '`start\nend`';
      const result = renderMarkdown(input);
      // Should NOT match because the backtick regex excludes \n
      expect(result).toContain('`start');
    });
  });

  describe('text formatting', () => {
    it('renders bold text', () => {
      expect(renderMarkdown('**bold text**')).toContain('<strong>bold text</strong>');
    });

    it('renders italic text', () => {
      expect(renderMarkdown('*italic text*')).toContain('<em>italic text</em>');
    });

    it('does not confuse bold and italic', () => {
      const result = renderMarkdown('**bold** and *italic*');
      expect(result).toContain('<strong>bold</strong>');
      expect(result).toContain('<em>italic</em>');
    });
  });

  describe('links', () => {
    it('renders https links', () => {
      const result = renderMarkdown('[click here](https://example.com)');
      expect(result).toContain('href="https://example.com"');
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener"');
    });

    it('renders http links', () => {
      const result = renderMarkdown('[test](http://example.com)');
      expect(result).toContain('href="http://example.com"');
    });

    it('renders mailto links', () => {
      const result = renderMarkdown('[email](mailto:a@b.com)');
      expect(result).toContain('href="mailto:a@b.com"');
    });

    it('strips javascript: scheme links', () => {
      const result = renderMarkdown('[click](javascript:alert(1))');
      expect(result).not.toContain('href');
      expect(result).not.toContain('javascript');
      expect(result).toContain('click');
    });

    it('strips data: scheme links', () => {
      const result = renderMarkdown('[xss](data:text/html,<h1>hi</h1>)');
      expect(result).not.toContain('href');
      expect(result).toContain('xss');
    });

    it('escapes double quotes in URLs to prevent attribute injection', () => {
      const result = renderMarkdown('[test](https://e.com/a"onclick=alert(1))');
      expect(result).toContain('&quot;');
      expect(result).not.toContain('"onclick');
    });

    it('escapes ampersands in URLs', () => {
      const result = renderMarkdown('[test](https://e.com?a=1&b=2)');
      expect(result).toContain('&amp;');
    });
  });

  describe('lists', () => {
    it('renders unordered lists with -', () => {
      const result = renderMarkdown('- item 1\n- item 2');
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>item 1</li>');
      expect(result).toContain('<li>item 2</li>');
      expect(result).toContain('</ul>');
    });

    it('renders unordered lists with *', () => {
      const result = renderMarkdown('* alpha\n* beta');
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>alpha</li>');
    });

    it('renders ordered lists', () => {
      const result = renderMarkdown('1. first\n2. second');
      expect(result).toContain('<ol>');
      expect(result).toContain('<li>first</li>');
      expect(result).toContain('<li>second</li>');
      expect(result).toContain('</ol>');
    });

    it('closes list when switching types', () => {
      const result = renderMarkdown('- unordered\n1. ordered');
      expect(result).toContain('</ul>');
      expect(result).toContain('<ol>');
    });
  });

  describe('headings', () => {
    it('renders h1 as h3 (offset for message context)', () => {
      expect(renderMarkdown('# Heading')).toContain('<h3>Heading</h3>');
    });

    it('renders h2 as h4', () => {
      expect(renderMarkdown('## Sub heading')).toContain('<h4>Sub heading</h4>');
    });

    it('renders h3 as h5', () => {
      expect(renderMarkdown('### Small heading')).toContain('<h5>Small heading</h5>');
    });
  });

  describe('paragraphs', () => {
    it('inserts line break for empty lines', () => {
      const result = renderMarkdown('para 1\n\npara 2');
      expect(result).toContain('<br>');
    });
  });

  describe('XSS prevention', () => {
    it('prevents script injection via img onerror', () => {
      const result = renderMarkdown('<img src=x onerror=alert(1)>');
      expect(result).not.toContain('<img');
      expect(result).toContain('&lt;img');
    });

    it('prevents event handler injection in links via quote escaping', () => {
      const result = renderMarkdown('[x](https://x.com" onmouseover="alert(1))');
      // The " is escaped to &quot;, so the attacker cannot break out of href=""
      expect(result).toContain('&quot;');
      // The href attribute must not be broken — no unescaped " before onmouseover
      expect(result).not.toMatch(/href="[^"]*" onmouseover/);
    });
  });
});
