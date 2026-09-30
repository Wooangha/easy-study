import { memo, useMemo } from 'react';
import { ImageIcon } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import 'katex/dist/katex.min.css';
import { msg, useLang } from '../i18n/index.ts';
import { normalizeMathDelimiters } from '../lib/mathDelimiters.ts';
import {
  BLOCKED_IMAGE_ALT,
  BLOCKED_IMAGE_CLASS,
  blockedImageLabel,
  rehypePlugins,
  remarkPlugins,
  urlTransform,
} from '../lib/markdownOptions.ts';

/**
 * A remote image that was not loaded (lib/markdownOptions.ts BLOCKED_IMAGE_CLASS): a link that starts with an image
 * icon, or plain text without a usable URL. Its texts are read here, at render time: a change of language re-renders
 * just this, never the parse of the whole Markdown (memo() below).
 */
function BlockedImage({ href, alt }: { href: string | undefined; alt: string }) {
  useLang();
  const label = blockedImageLabel(alt, href);
  if (!href) return <span className={BLOCKED_IMAGE_CLASS}>{label}</span>;
  return (
    <a href={href} className={BLOCKED_IMAGE_CLASS} title={msg().chat.markdown.blockedImageTitle(href)} target="_blank" rel="noreferrer noopener">
      <ImageIcon /> {label}
    </a>
  );
}

const components: Components = {
  // Links open in a new tab (in the desktop app: other sites in the system browser, the server's own pages in an app
  // window). One whose URL was dropped (lib/markdownOptions.ts urlTransform: the shell's reserved path, javascript:)
  // is plain text. A remote image that was not loaded is drawn by BlockedImage.
  a: ({ node: _node, href, children, ...props }) => {
    if (props.className === BLOCKED_IMAGE_CLASS) {
      const alt = (props as Record<string, unknown>)[BLOCKED_IMAGE_ALT];
      return <BlockedImage href={href || undefined} alt={typeof alt === 'string' ? alt : ''} />;
    }
    return href ? (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span className="md-dead-link">{children}</span>
    );
  },
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
