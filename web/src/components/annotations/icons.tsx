// The icons of the annotation UI (DESIGN §25): the tool glyphs of the toolbar (and its 되돌리기 / 다시 실행), the eye
// of "튜터에게 보이기" and the speech bubble of questions (the slide's Q&A badge, "이 부분 설명해줘", the item menu's
// question count). Lucide icons
// (lucide-react, like the rest of the app's icons), drawn in currentColor so they take the button's color — an emoji
// would not (the active tool's accent contrast, a muted "off" eye). 16 px unless a class sizes them (.tool-icon,
// .eye-icon, .qa-badge-icon …); the stroke is the app's icon stroke (styles.css, "icons").
import {
  Baseline,
  Circle,
  Eraser,
  Eye,
  EyeOff,
  Hand,
  Highlighter,
  MessageCircle,
  MousePointer2,
  PenLine,
  Redo2,
  Square,
  SquareDashedMousePointer,
  StickyNote,
  Type,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { AnnotationTool } from '../../lib/annotations/geometry.ts';

const SIZE = 16;

/** The eye of "튜터에게 보이기": open, or crossed out (`off`) when the memo is hidden from the tutor. */
export function EyeIcon({ off = false, className = 'eye-icon' }: { off?: boolean; className?: string }) {
  const Glyph = off ? EyeOff : Eye;
  return <Glyph className={off ? `${className} is-off` : className} size={SIZE} />;
}

/** A speech bubble: questions and answers (the slide's Q&A badge, "이 부분 설명해줘"). */
export function ChatIcon({ className = 'chat-icon' }: { className?: string }) {
  return <MessageCircle className={className} size={SIZE} />;
}

/**
 * The glyph of each tool: the pointer of 선택·첨부, a dashed box with a pointer for 범위 선택, a pen and an eraser for
 * 펜 / 지우개, a marker for 형광펜, an underlined A for 텍스트 형광, the shapes, T, a sticky note.
 */
const TOOL_ICONS: Record<AnnotationTool, LucideIcon> = {
  select: MousePointer2,
  marquee: SquareDashedMousePointer,
  pen: PenLine,
  eraser: Eraser,
  highlight: Highlighter,
  textHighlight: Baseline,
  rect: Square,
  ellipse: Circle,
  text: Type,
  memo: StickyNote,
};

/** A hand: 손가락으로도 쓰기 (under 펜 / 지우개). */
export function FingerIcon({ className = 'tool-icon' }: { className?: string }) {
  return <Hand className={className} size={SIZE} />;
}

/** 되돌리기 / 다시 실행 of the toolbar under 펜 / 지우개 (DESIGN §29: a tablet has no ⌘Z). */
export function UndoIcon({ redo = false, className = 'tool-icon' }: { redo?: boolean; className?: string }) {
  const Glyph = redo ? Redo2 : Undo2;
  return <Glyph className={className} size={SIZE} />;
}

/** The glyph of a tool button. */
export function ToolIcon({ tool, className = 'tool-icon' }: { tool: AnnotationTool; className?: string }) {
  const Glyph = TOOL_ICONS[tool];
  return <Glyph className={className} size={SIZE} />;
}
