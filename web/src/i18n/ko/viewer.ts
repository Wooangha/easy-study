// Korean (the reference language) — namespace `viewer`: the slide viewer, annotation tools, menus, memos and question markers, the region menu.

export const viewer = {
  /** The viewer's toolbar (SlideViewer): the page jump, the hint, the zoom. */
  toolbar: {
    jumpLabel: '이동할 슬라이드 번호',
    /** The title of the one-line hint (toolHint). */
    keyboardTitle:
      '키보드: j/k 또는 ↑/↓ 로 슬라이드 이동 · 도구 없이 빈 곳을 끌면 그 영역을 질문에 첨부해요 · 필기는 어느 도구에서든 클릭해서 옮기거나 지워요 (Shift+클릭으로 여러 개, 범위 선택 도구로 끌어서 여러 개) · ⌘Z/Ctrl+Z 되돌리기',
    zoomGroup: '확대/축소',
    zoomOut: '축소',
    zoomFitTitle: '너비에 맞춤',
    /** The zoom button at 100 %. */
    zoomFit: '맞춤',
    zoomIn: '확대',
  },
  /** The scrolling slide list (SlideViewer). */
  slides: {
    label: '슬라이드 (j/k 또는 ↑/↓ 로 이동, 빈 곳을 끌어서 영역 첨부)',
    filterEmptyTag: (tag: string) => `#${tag} 태그가 붙은 슬라이드가 없어요.`,
    filterEmpty: '표시가 있는 슬라이드가 아직 없어요.',
    showAll: '모든 슬라이드 보기',
    /** The bottom sheet of a memo (narrow panes / touch). */
    memoSheet: (slide: number) => `슬라이드 ${slide}의 메모`,
    imageFailed: (slide: number) => `슬라이드 ${slide} 이미지를 불러오지 못했어요`,
    imageAlt: (slide: number) => `슬라이드 ${slide}`,
    pinned: '고정됨',
    qaBadge: (n: number) => `이 슬라이드의 Q&A ${n}개 보기`,
    unsaved: '저장 안 됨',
    unsavedTitle: '이 슬라이드의 필기를 서버에 저장하지 못했어요. 연결되면 다음 수정과 함께 다시 저장해요.',
  },
  /** Toasts and the delete confirmation of the viewer (SlideViewer). */
  toasts: {
    layoutPending: '이 슬라이드의 글자 위치를 준비하는 중이에요 — 잠시 뒤 다시 해 보세요',
    noText: '이 슬라이드에서는 글자를 찾지 못했어요',
    longPress: '길게 누른 채로 끌어서 영역을 선택하세요',
    memoNotFound: '그 메모를 찾을 수 없어요',
    undone: '되돌렸어요',
    redone: '다시 실행했어요',
  },
  confirmDelete: {
    memoTitle: '메모를 지울까요?',
    itemsTitle: (n: number) => `필기 ${n}개를 지울까요?`,
    /** Several items, `memos` of them memos with text. */
    itemsMessage: (memos: number) => `글이 있는 메모 ${memos}개가 함께 지워져요`,
  },
  /** The floating menu of a finished region selection. */
  regionMenu: {
    label: (slide: number) => `슬라이드 ${slide}에서 선택한 영역`,
    attach: '첨부',
    attachTitle: '질문에 첨부해요 (입력창 위에 표시돼요)',
    /** `prompt`: the question the button sends (lib/attachments.ts explainRegionPrompt), also the button's text. */
    askTitle: (prompt: string) => `이 영역을 첨부해서 “${prompt}”라고 바로 질문해요`,
    cancel: '선택 취소',
    cancelTitle: '선택 취소 (Esc)',
  },

  /** The annotation toolbar (AnnotationTools). */
  tools: {
    labels: {
      select: '선택·첨부',
      marquee: '범위 선택',
      pen: '펜',
      eraser: '지우개',
      highlight: '형광펜',
      textHighlight: '텍스트 형광',
      rect: '사각형',
      ellipse: '동그라미',
      text: '텍스트',
      memo: '메모',
    },
    titles: {
      select: '선택·첨부: 필기를 클릭해 옮기거나 지우고, 빈 곳을 끌면 그 영역을 질문에 첨부해요',
      marquee: '범위 선택: 빈 곳에서 끌어 여러 필기를 한꺼번에 골라요 · Shift+클릭으로 더하고 빼요 (다시 누르거나 Esc로 끔)',
      pen: '펜: Apple Pencil·S Pen·마우스로 써요 — 손가락은 스크롤·확대 (다시 누르거나 Esc로 끔)',
      eraser: '지우개: 지나간 펜 획을 지워요 (다시 누르거나 Esc로 끔)',
      highlight: '형광펜: 글줄 위에서 끌면 그 줄에 맞춰 칠해요 (다시 누르거나 Esc로 끔)',
      textHighlight: '텍스트 형광: 글자 위에서 끌면 단어에 맞춰 칠하고, 칠한 글 위를 다시 끌면 범위가 바뀌어요 (다시 누르거나 Esc로 끔)',
      rect: '사각형: 끌어서 그려요 (다시 누르거나 Esc로 끔)',
      ellipse: '동그라미: 끌어서 그려요 (다시 누르거나 Esc로 끔)',
      text: '텍스트 상자: 클릭하거나 끌어서 만들고 글을 써요 (다시 누르거나 Esc로 끔)',
      memo: '메모: 클릭한 자리에 스티커 메모를 붙여요 (다시 누르거나 Esc로 끔)',
    },
    /** The toolbar's one-line hint (toolHint). */
    hintSelect: 'j/k · ↑/↓ · 빈 곳을 끌면 영역 첨부',
    hintMarquee: '범위 선택: 빈 곳에서 끌어 여러 개 고르기 · Shift+클릭 더하기·빼기 · Esc',
    /** 펜's hint: `finger` = 손가락으로도 쓰기 is on. */
    hintPen: (finger: boolean): string => (finger ? '펜: 펜·손가락·마우스로 쓰기 · Esc' : '펜: Apple Pencil·마우스로 쓰기 · 손가락은 스크롤'),
    hintEraser: '지우개: 지나간 펜 획을 지워요',
    /** A drawing tool's hint: `label` is the tool's name, `click` whether it draws with a click (text, memo). */
    hintDraw: (label: string, click: boolean) => `${label}: 빈 곳에서 ${click ? '클릭' : '끌기'} · 필기는 클릭해 옮기기 · Esc`,
    group: '필기 도구',
    hiddenTitle: '필기가 숨겨져 있어요 (⋯ 필기 메뉴에서 보이기)',
    colorGroup: '새 필기의 색',
    colorTitle: (color: string) => `새 필기의 색: ${color}`,
    /** The folded tools' button (a narrow pane). */
    compactTitle: (tool: string, color: string) => `필기 도구: ${tool} · ${color}`,
    /** Under 펜: the ink colors, the widths (shared/types.ts INK_WIDTHS, in that order), 손가락으로도 쓰기. */
    inkColorGroup: '펜 색',
    inkColorTitle: (color: string) => `펜 색: ${color}`,
    inkWidthGroup: '펜 굵기',
    inkWidths: ['가늘게', '보통', '굵게'],
    inkWidthTitle: (width: string) => `펜 굵기: ${width}`,
    fingerInk: '손가락으로도 쓰기',
    fingerInkTitle: (on: boolean): string =>
      on ? '손가락으로도 쓰기: 켜짐 — 손가락도 펜처럼 써요 (끄면 손가락은 스크롤·확대)' : '손가락으로도 쓰기: 꺼짐 — 펜·마우스만 쓰고 손가락은 스크롤·확대 (스타일러스가 없으면 켜세요)',
    /** 되돌리기 / 다시 실행 under 펜 / 지우개 (a tablet has no ⌘Z). */
    historyGroup: '되돌리기·다시 실행',
    undo: '되돌리기',
    undoTitle: '되돌리기: 마지막 필기를 취소해요 (⌘Z/Ctrl+Z)',
    redo: '다시 실행',
    redoTitle: '다시 실행: 되돌린 필기를 다시 해요 (⌘⇧Z/Ctrl+Y)',
  },
  /** The ⋯ 필기 menu (AnnotationTools). */
  layerMenu: {
    label: '필기 메뉴',
    button: '필기',
    buttonHidden: '필기 숨김',
    title: '필기 보기/숨기기 · 표시 있는 슬라이드만 · 태그 · 질문 표시 · 그때 필기 재생',
    showLayer: '필기 보기',
    onlyMarked: '표시 있는 슬라이드만',
    tag: '태그',
    tagFilter: '태그로 슬라이드 거르기',
    allTags: '모든 태그',
    showMarkers: '질문 표시 보기',
    replay: '그때 필기 재생',
    replayTitle: '녹음 탭에서 재생하는 동안, 그때까지 쓴 필기만 보여요',
    /** Slides shown of the deck while a filter is on. */
    shownCount: (shown: number, total: number) => `표시 ${shown}/${total}`,
    showAll: '모두 보기',
    shownCountTitle: '표시 있는 슬라이드만 보는 중 (⋯ 필기 메뉴에서 해제)',
    replaying: '그때 필기 재생 중',
    replayingTitle: '녹음 탭의 재생 위치까지 쓴 필기만 보여요 (⋯ 필기 메뉴에서 끌 수 있어요)',
  },
  /** The four annotation colors (shared/types.ts ANNOTATION_COLORS) and the 펜's inks (INK_COLORS). */
  colorNames: {
    yellow: '노랑',
    green: '초록',
    pink: '분홍',
    blue: '파랑',
    black: '검정',
    red: '빨강',
  },

  /** The floating menu of the selected item(s) (ItemMenu). */
  itemMenu: {
    label: (slide: number) => `슬라이드 ${slide}의 선택한 필기`,
    labelMany: (slide: number, n: number) => `슬라이드 ${slide}의 선택한 필기 ${n}개`,
    count: (n: number) => `${n}개`,
    colors: '색',
    colorAllTitle: (color: string) => `선택한 필기 모두 ${color}`,
    attach: '첨부',
    attachTitle: '이 필기를 질문에 첨부해요 (입력창 위에 표시돼요)',
    attachManyTitle: '선택한 필기를 하나씩 질문에 첨부해요 — 펜 획은 모두 한 장으로 (입력창 위에 표시돼요)',
    expand: '펴기',
    expandSheetTitle: '메모 펴기 (아래 시트에서 편집)',
    expandTitle: '메모 펴기',
    collapse: '접기',
    collapseTitle: '메모 접기',
    deleteTitle: '이 필기 삭제 (Delete)',
    deleteManyTitle: (n: number) => `선택한 필기 ${n}개 삭제 (Delete)`,
    questions: (n: number) => `질문 ${n}개`,
    questionsTitle: (n: number) => `이 필기를 첨부해서 물어본 질문 ${n}개 (선택을 풀면 모서리의 파란 점)`,
    deselect: '선택 해제',
    deselectTitle: '선택 해제 (Esc)',
  },
  /** The text look of a text box and a memo's text size (ItemMenu). */
  textStyle: {
    /** The folded controls' button: a glyph sample and the size in points. */
    summary: (pt: number) => `가 ${pt}`,
    label: '글자 모양 (크기 · 글꼴 · 굵게)',
    size: '글자 크기',
    sizeDown: '글자 크기 줄이기',
    sizeUp: '글자 크기 키우기',
    memoSize: '메모 글자 크기',
    memoSizeDown: '메모 글자 크기 줄이기',
    memoSizeUp: '메모 글자 크기 키우기',
    /** The size field's title: `label` is one of the size labels above. */
    sizeTitle: (label: string, min: number, max: number) => `${label}: ${min}–${max} pt (슬라이드 기준)`,
    font: '글꼴',
    bold: '굵게',
    /** shared/types.ts TEXT_FONTS. */
    fonts: { sans: '기본', serif: '명조', mono: '고정폭' },
  },
  /** A text box on the slide (AnnotationLayer). */
  textBox: {
    placeholder: '텍스트…',
    label: '텍스트 상자',
  },

  /** A sticky memo (MemoCard), shared with the item menu (튜터에게 보이기). */
  memo: {
    /** A memo without text (its header, its pill). */
    fallbackTitle: '메모',
    /** The 메모 tab's line of a memo without text (lib/annotations/memoList.ts memoLines). */
    empty: '(빈 메모)',
    tooManyLinks: (max: number) => `메모 하나에는 연결을 ${max}개까지 넣을 수 있어요`,
    goToSlide: (slide: number) => `슬라이드 ${slide}로 이동`,
    deletedLecture: '지워진 강의',
    /** `page`: " · p.3", or empty. */
    openLecture: (title: string, page: string) => `‘${title}’ 열기${page}`,
    lectureDeleted: '이 강의는 지워졌어요',
    playMoment: '녹음의 이 순간 듣기 (녹음 탭)',
    menu: '메모 메뉴',
    menuAttach: '질문에 첨부',
    menuAttachHint: '다음 질문과 함께',
    menuLink: '슬라이드·강의 연결',
    /** `clock`: the playhead ("1:23"). */
    menuLinkNow: (clock: string) => `지금 재생 위치 연결 (${clock})`,
    tutorShow: '튜터에게 보이기',
    tutorHide: '튜터에게 숨기기',
    tutorHidden: '튜터에게 숨김',
    tutorShownTitle: '튜터에게 보이기 — 질문할 때 이 메모도 함께 가요 (클릭하면 숨김)',
    tutorHiddenTitle: '튜터에게 숨김 — 이 메모는 튜터가 보지 않아요 (클릭하면 보이기)',
    collapse: '접기',
    collapseLabel: '메모 접기',
    delete: '메모 삭제',
    pillTitle: '메모 (클릭해서 펴기)',
    /** The collapsed pill's name: its preview, whether the tutor does not see it, the questions asked with it (null: none). */
    pillLabel: (preview: string, tutorHidden: boolean, questions: number | null) =>
      `메모: ${preview}${tutorHidden ? ' · 튜터에게 숨김' : ''}${questions !== null ? ` · 질문 ${questions}개` : ''}`,
    questionsTitle: (n: number) => `이 메모로 물어본 질문 ${n}개 (메모를 펴면 볼 수 있어요)`,
    dragTitle: '끌어서 옮기기',
    placeholder: '메모…',
    textLabel: '메모 내용',
    /** `label`: the link chip's text. */
    removeLink: (label: string) => `연결 ${label} 빼기`,
    removeLinkTitle: '연결 빼기',
    link: '연결',
    linkTitle: '슬라이드나 다른 강의에 연결',
    attach: '첨부',
    attachTitle: '이 메모를 질문에 첨부해요 (입력창 위에 표시돼요)',
  },
  /** A memo's 연결 panel (LinkPicker). */
  linkPicker: {
    label: '메모에 연결할 슬라이드',
    thisLecture: '이 강의',
    thisLectureSlide: '이 강의의 슬라이드 번호',
    otherLecture: '다른 강의',
    otherLectureSlide: '다른 강의의 슬라이드 번호 (선택)',
    noOthers: '(다른 강의 없음)',
    chooseLecture: '강의 선택…',
    link: '연결',
  },
  /** A memo's tags (TagInput). */
  tags: {
    remove: (tag: string) => `태그 ${tag} 빼기`,
    removeTitle: '태그 빼기',
    placeholder: '태그 추가…',
    add: '태그 추가',
  },

  /** 질문 표시 (QuestionMarkers, lib/annotations/markers.ts). */
  markers: {
    /** A question sent with attachments only. */
    noText: '(첨부만 보냄)',
    /** `label`: the newest question's first line. */
    label: (n: number, label: string) => `질문 ${n}개: ${label}`,
    title: (n: number) => `이 부분으로 물어본 질문 ${n}개`,
    tipLabel: '이 부분으로 물어본 질문',
    goToQuestion: '이 질문으로 이동',
    more: (n: number) => `외 ${n}개`,
    openNotes: '노트에서 보기',
    hide: '이 표시 지우기',
    hideTitle: '이 표시를 슬라이드에서 지워요 (질문과 답은 그대로예요)',
  },

  /** The annotation store's toasts (lib/annotations/store.ts). */
  store: {
    conflictReloaded: '다른 곳에서 필기가 바뀌어서 다시 불러왔어요',
    tooManyItems: (max: number) => `이 슬라이드에는 필기를 더 넣을 수 없어요 (최대 ${max}개)`,
    tooManyHidden: '숨긴 질문 표시가 너무 많아요',
    /** A write that would pass MAX_INK_STROKES or MAX_SLIDE_ANNOTATION_BYTES (DESIGN §29). */
    tooMuchOnSlide: '이 슬라이드에 필기가 너무 많아요',
    saveFailed: (reason: string) => `필기를 저장하지 못했어요: ${reason}`,
  },
};
