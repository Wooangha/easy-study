import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import 'katex/dist/katex.min.css';
import { normalizeMathDelimiters } from '../lib/mathDelimiters.ts';
import { rehypePlugins, remarkPlugins, urlTransform } from '../lib/markdownOptions.ts';

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
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
