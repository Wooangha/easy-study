// Inline SVG icons of the annotation UI (DESIGN §25): the tool glyphs of the toolbar, the eye of "튜터에게 보이기" and
// the speech bubble of questions (the slide's Q&A badge, "이 부분 설명해줘", the item menu's question count).
// 16 × 16, drawn in currentColor with the stroke of the app's other icons (organize/parts.tsx Chevron), so they take
// the button's color — an emoji would not (the active tool's accent contrast, a muted "off" eye).
import type { ReactNode } from 'react';
import type { AnnotationTool } from '../../lib/annotations/geometry.ts';

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function Icon({ className, children }: { className: string; children: ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      {children}
    </svg>
  );
}

/** The eye of "튜터에게 보이기": open, or crossed out (`off`) when the memo is hidden from the tutor. */
export function EyeIcon({ off = false, className = 'eye-icon' }: { off?: boolean; className?: string }) {
  return (
    <Icon className={off ? `${className} is-off` : className}>
      <path d="M1.5 8c1.6-2.9 3.8-4.4 6.5-4.4S12.9 5.1 14.5 8c-1.6 2.9-3.8 4.4-6.5 4.4S3.1 10.9 1.5 8Z" {...STROKE} />
      <circle cx="8" cy="8" r="2.1" {...STROKE} />
      {off && <path d="M2.8 2.8l10.4 10.4" {...STROKE} />}
    </Icon>
  );
}

/** A speech bubble: questions and answers (the slide's Q&A badge, "이 부분 설명해줘"). */
export function ChatIcon({ className = 'chat-icon' }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3.2 2.8h9.6a1.7 1.7 0 0 1 1.7 1.7v5.6a1.7 1.7 0 0 1-1.7 1.7H7.6L4.6 14v-2.2H3.2a1.7 1.7 0 0 1-1.7-1.7V4.5a1.7 1.7 0 0 1 1.7-1.7Z" {...STROKE} />
    </Icon>
  );
}

/**
 * The glyph of a tool button: the arrow of 선택·첨부, a dashed box with a small arrow for 범위 선택, a marker over a
 * line, a highlighted A, the shapes, T, a note.
 */
export function ToolIcon({ tool, className = 'tool-icon' }: { tool: AnnotationTool; className?: string }) {
  switch (tool) {
    case 'select':
      return (
        <Icon className={className}>
          <path d="M3.5 2.5 13 8.8 8.9 9.6l2.3 3.7-1.9 1.1-2.3-3.7-3.5 2.6Z" {...STROKE} />
        </Icon>
      );
    case 'marquee':
      return (
        <Icon className={className}>
          <rect x="2" y="2" width="10" height="8" rx="1" {...STROKE} strokeDasharray="2.2 1.6" />
          <path d="M8.5 8.5 14 12.2l-2.4.5 1.3 2.2-1.2.7-1.3-2.2-1.9 1.6Z" {...STROKE} />
        </Icon>
      );
    case 'highlight':
      return (
        <Icon className={className}>
          <path d="M9.6 2.6 13.4 6.4 7.2 12.6 3 12.9 3.3 8.9Z" {...STROKE} />
          <path d="M2 15h12" {...STROKE} />
        </Icon>
      );
    case 'textHighlight':
      return (
        <Icon className={className}>
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="currentColor" fillOpacity="0.22" stroke="none" />
          <path d="M4.5 12 8 4l3.5 8M5.8 9.4h4.4" {...STROKE} />
        </Icon>
      );
    case 'rect':
      return (
        <Icon className={className}>
          <rect x="2.5" y="3.5" width="11" height="9" rx="1.2" {...STROKE} />
        </Icon>
      );
    case 'ellipse':
      return (
        <Icon className={className}>
          <ellipse cx="8" cy="8" rx="5.8" ry="4.4" {...STROKE} />
        </Icon>
      );
    case 'text':
      return (
        <Icon className={className}>
          <path d="M3.5 3.5h9M8 3.5v9M6.2 12.5h3.6" {...STROKE} />
        </Icon>
      );
    case 'memo':
      return (
        <Icon className={className}>
          <path d="M3 3h10v6.5L9.5 13H3Z" {...STROKE} />
          <path d="M9.5 13V9.5H13" {...STROKE} />
        </Icon>
      );
  }
}
