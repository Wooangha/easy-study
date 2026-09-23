import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import { normalizeMathDelimiters } from '../lib/mathDelimiters.ts';

const remarkPlugins: Options['remarkPlugins'] = [remarkGfm, remarkMath];
// KaTeX must run before highlight.js so math code nodes are never treated as code.
const rehypePlugins: Options['rehypePlugins'] = [
  [rehypeKatex, { strict: 'ignore', errorColor: 'var(--danger)' }],
  [rehypeHighlight, { detect: false }],
];

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

/** Assistant Markdown: GFM tables/code, KaTeX math (also \( \) / \[ \] delimiters), highlighted code. */
export const Markdown = memo(function Markdown({ text, className }: MarkdownProps) {
  const source = useMemo(() => normalizeMathDelimiters(text), [text]);
  return (
    <div className={className ? `md ${className}` : 'md'}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
