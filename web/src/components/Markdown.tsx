import { memo, useMemo } from 'react';
import { ImageIcon } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import 'katex/dist/katex.min.css';
import { normalizeMathDelimiters } from '../lib/mathDelimiters.ts';
import { BLOCKED_IMAGE_CLASS, rehypePlugins, remarkPlugins, urlTransform } from '../lib/markdownOptions.ts';

const components: Components = {
  // Links open in a new tab (in the desktop app: other sites in the system browser, the server's own pages in an app
  // window). One whose URL was dropped (lib/markdownOptions.ts urlTransform: the shell's reserved path, javascript:)
  // is plain text. A remote image that was not loaded (the link standing in for it) starts with an image icon.
  a: ({ node: _node, href, children, ...props }) =>
    href ? (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener">
        {props.className === BLOCKED_IMAGE_CLASS && (
          <>
            <ImageIcon />{' '}
          </>
        )}
        {children}
      </a>
    ) : (
      <span className="md-dead-link">{children}</span>
    ),
  // Wide tables scroll horizontally instead of breaking the chat column.
  table: ({ node: _node, ...props }) => (
    <div className="md-table-wrap">
      <table {...props} />
    </div>
  ),
};

interface MarkdownProps {
  text: string;
  className?: string;
}

/**
 * LLM Markdown: GFM tables/code, KaTeX math (also \( \) / \[ \] delimiters and `\$` inside math),
 * highlighted code. Remote images are shown as links, never loaded automatically (lib/markdownOptions.ts).
 */
export const Markdown = memo(function Markdown({ text, className }: MarkdownProps) {
  const source = useMemo(() => normalizeMathDelimiters(text), [text]);
  return (
    <div className={className ? `md ${className}` : 'md'}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={urlTransform}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
