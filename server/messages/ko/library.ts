// Korean (the reference language) — server namespace `library`: documents (upload, conversion, rename, delete),
// courses, groups, the library layout, attachments and annotations.

export const library = {
  /** server/library.ts and the document routes of server/index.ts. */
  docs: {
    titleRequired: '강의 이름을 입력해 주세요',
    titleTooLong: (max: number) => `강의 이름이 너무 깁니다 (최대 ${max}자)`,
    notPdf: 'PDF 파일이 아닙니다 (%PDF 헤더가 없습니다)',
    pdfEmpty: 'PDF 파일 내용이 비어 있습니다',
    /** A document whose conversion failed; `error` is the stored reason (or `unknownError`). */
    failed: (error: string) => `문서 처리에 실패했습니다: ${error}`,
    unknownError: '알 수 없는 오류',
    processing: '문서를 아직 처리하는 중입니다',
    alreadyConverted: '이미 변환이 끝난 문서입니다',
    alreadyConverting: '문서를 이미 변환하고 있습니다',
    deleteWhileConverting: 'PDF를 변환하는 중에는 지울 수 없습니다. 변환이 끝난 뒤에 다시 시도해 주세요',
    deleteWhileDigest: '정리본을 만드는 중에는 지울 수 없습니다. 정리본 만들기를 먼저 중단해 주세요',
    deleteWhileAnswering: '답변을 생성하는 중에는 지울 수 없습니다. 답변이 끝난 뒤에 다시 시도해 주세요',
  },
  /** server/versions.ts and the routes of a new version of a lecture's PDF (DESIGN §28, 「새 버전 올리기」). */
  versions: {
    /** 409 of every write for the lecture while its deck is swapped (and of a second swap). */
    swapping: '새 버전으로 바꾸는 중이에요. 잠시 후 다시 해 주세요.',
    /** 409 of an upload (or a swap) while the lecture itself is not converted. */
    notReady: '강의 변환이 끝난 뒤에 새 버전을 올릴 수 있어요.',
    nextNotReady: '새 버전을 아직 준비하고 있어요. 준비가 끝난 뒤에 다시 해 주세요.',
    noNext: '올린 새 버전이 없어요.',
    /** 409 of apply: the deck was swapped (or undone) since the new version was matched. */
    stalePlan: '그사이 강의 슬라이드가 바뀌었어요. 새 버전을 다시 올려 주세요.',
    /** 409 of a slide-numbered write (or an undo) made for another deck than the lecture's (DECK_REV_HEADER). */
    deckChanged: '그사이 이 강의가 새 버전으로 바뀌었어요. 화면을 다시 불러올게요.',
    nothingToUndo: '되돌릴 변경이 없어요.',
    busyAnswering: '답변하는 중에는 바꿀 수 없어요. 답변이 끝난 뒤에 다시 해 주세요.',
    busyDigest: '정리본을 만드는 중에는 바꿀 수 없어요. 끝나거나 멈춘 뒤에 다시 해 주세요.',
    busyRecording: '이 강의를 녹음하는 중에는 바꿀 수 없어요.',
    busyTranscribing: '녹음을 받아쓰거나 정렬하는 중에는 바꿀 수 없어요. 끝난 뒤에 다시 해 주세요.',
    /** NextVersionInfo.error of a conversion the server stopped (a restart). */
    interrupted: '변환이 중단됐어요. 다시 올려 주세요.',
    notPdf: 'PDF 파일만 올릴 수 있어요.',
  },
  /** server/courses.ts */
  courses: {
    nameRequired: {
      course: '과목 이름을 입력해 주세요',
      group: '그룹 이름을 입력해 주세요',
    },
    nameTooLong: {
      course: (max: number) => `과목 이름이 너무 깁니다 (최대 ${max}자)`,
      group: (max: number) => `그룹 이름이 너무 깁니다 (최대 ${max}자)`,
    },
    docIdsInvalid: 'docIds는 문서 id 목록이어야 합니다',
    baseDocIdsInvalid: 'baseDocIds는 문서 id 목록이어야 합니다',
    tooManyLectures: (max: number) => `강의가 너무 많습니다 (최대 ${max}개)`,
    duplicateDoc: (docId: string) => `같은 문서가 두 번 들어 있습니다: ${docId}`,
    unknownDocs: (docIds: string[]) => `알 수 없는 문서입니다: ${docIds.join(', ')}`,
    groupNotFoundId: (groupId: string) => `그룹을 찾을 수 없습니다: ${groupId}`,
    courseNotFoundId: (courseId: string) => `과목을 찾을 수 없습니다: ${courseId}`,
    groupIdInvalid: 'groupId는 그룹 id여야 합니다',
    lecturesChanged: '다른 곳에서 이 과목의 강의 목록이 바뀌었습니다. 새로 불러온 뒤 다시 시도해 주세요',
  },
  /** COURSE.md (server/courses.ts courseMarkdown), written in the language of the request that changed the course. */
  courseMd: {
    /** The top heading after `# `. */
    title: (course: string) => `${course} — 과목 정리`,
    /** In italics, in parentheses. */
    noLectures: '아직 강의가 없습니다',
    noDigest: '정리본 없음',
  },
  /** server/layout.ts: groups of courses and their order. `ids` is an already joined list (`moreIds`). */
  layout: {
    /** "a, b, c 외 2개": the ids shown, then how many more there are. */
    moreIds: (shown: string, more: number) => `${shown} 외 ${more}개`,
    malformed: '배치 정보가 올바르지 않습니다',
    changedElsewhere: '다른 곳에서 과목 배치가 바뀌었습니다. 새로 불러온 뒤 다시 시도해 주세요',
    unknownGroups: (ids: string) => `알 수 없는 그룹입니다 (다른 곳에서 삭제되었을 수 있습니다): ${ids}`,
    unknownCourses: (ids: string) => `알 수 없는 과목입니다: ${ids}`,
    duplicateGroups: (ids: string) => `같은 그룹이 두 번 들어 있습니다: ${ids}`,
    duplicateCourses: (ids: string) => `같은 과목이 두 번 들어 있습니다: ${ids}`,
    missingGroups: (ids: string) => `배치에 빠진 그룹이 있습니다 (다른 곳에서 바뀌었을 수 있으니 새로 고친 뒤 다시 시도해 주세요): ${ids}`,
    missingCourses: (ids: string) => `배치에 빠진 과목이 있습니다 (다른 곳에서 바뀌었을 수 있으니 새로 고친 뒤 다시 시도해 주세요): ${ids}`,
    courseIdsInvalid: 'courseIds는 과목 id 목록이어야 합니다',
  },
  /** server/attachments.ts and the attachment routes: selected regions and images of a question. */
  attachments: {
    idsNotArray: 'attachments는 첨부 id의 배열이어야 합니다',
    tooMany: (max: number) => `첨부는 질문 하나에 최대 ${max}개까지 보낼 수 있습니다`,
    idInvalid: (id: string) => `첨부 id가 올바르지 않습니다: ${id}`,
    missing: (ids: string) =>
      `첨부를 찾을 수 없습니다: ${ids} (지워졌거나 다른 문서의 첨부입니다 — 질문에 쓰지 않은 첨부는 24시간 뒤에 지워집니다)`,
    regionInvalid: '선택 영역(rect: x, y, w, h)이 올바르지 않습니다',
    regionOutside: '선택 영역은 슬라이드 안(0–1)에 있고 넓이가 있어야 합니다',
    /** 400 of POST …/regions when `annotationId` names no item of that slide. */
    annotationNotFound: '그 필기를 찾을 수 없습니다',
    cropFailed: (slide: number) => `슬라이드 ${slide}의 선택 영역을 잘라내지 못했습니다`,
    imageEmpty: '이미지 내용이 비어 있습니다',
    imageOnly: '이미지 파일만 첨부할 수 있습니다 (Content-Type: image/*)',
    unsupportedImage: '지원하지 않는 이미지 형식입니다 (PNG, JPEG, WebP, GIF만 올릴 수 있습니다)',
    /** 413 for an image whose resolution the worker refuses (not a damaged file). */
    imageTooManyPixels: '이미지 해상도가 너무 커서 처리할 수 없습니다. 스크린샷이나 더 작은 이미지로 올려 주세요',
    heifUnsupported: 'HEIC/HEIF 이미지는 이 컴퓨터에서 열 수 없습니다. JPEG나 PNG로 바꿔서(예: 스크린샷) 다시 올려 주세요',
    imageUnreadable: '이미지를 읽을 수 없습니다 (파일이 손상되었을 수 있습니다)',
    imageFailed: '이미지를 처리하지 못했습니다',
    imageTooLarge: (maxMb: number) => `이미지가 너무 큽니다 (최대 ${maxMb} MB)`,
    inUse: '이미 질문에 쓰인 첨부는 지울 수 없습니다',
  },
  /** server/annotations.ts and server/annotationsRoutes.ts: slide annotations (필기). Most are followed by a JSON snippet. */
  annotations: {
    /** 409 of PUT / PATCH when `baseRev` is not the stored rev (or an op names an id the document does not have). */
    conflict: '다른 곳에서 이 슬라이드의 필기가 바뀌었습니다. 새로 불러온 뒤 다시 시도해 주세요',
    /** 400 when the JSON of the slide document after a write would be too large. */
    tooLarge: '이 슬라이드의 필기가 너무 많아요 (일부를 지워 주세요)',
    rectInvalid: '필기의 위치(rect: x, y, w, h)가 올바르지 않습니다',
    rectOutside: '필기는 슬라이드 안(0–1)에 있고 넓이가 있어야 합니다',
    pointInvalid: '메모의 위치(at: x, y)가 올바르지 않습니다',
    textInvalid: '필기의 글(text)이 올바르지 않습니다',
    textTooLong: (max: number) => `필기의 글이 너무 깁니다 (최대 ${max}자)`,
    tagsInvalid: '메모의 태그(tags)는 문자열 배열이어야 합니다',
    tagTooLong: (max: number) => `태그가 너무 깁니다 (최대 ${max}자)`,
    tooManyTags: (max: number) => `태그는 메모마다 최대 ${max}개까지 붙일 수 있습니다`,
    linkInvalid: '메모의 연결(links)이 올바르지 않습니다',
    linkSlideOutOfRange: (pageCount: number) => `연결한 슬라이드 번호가 올바르지 않습니다 (1–${pageCount})`,
    linkSlideInvalid: '연결한 슬라이드 번호가 올바르지 않습니다',
    linkDocInvalid: '연결한 강의 id가 올바르지 않습니다',
    linkRecordingInvalid: '연결한 녹음 시점이 올바르지 않습니다',
    linksNotArray: '메모의 연결(links)은 배열이어야 합니다',
    tooManyLinks: (max: number) => `연결은 메모마다 최대 ${max}개까지 둘 수 있습니다`,
    recordedAtInvalid: '녹음 시점(recordedAt)이 올바르지 않습니다',
    /** `field` is the JSON field name (bold, collapsed, tutor). */
    notBoolean: (field: string) => `${field}은(는) true/false여야 합니다`,
    sizeInvalid: '글자 크기(size)가 올바르지 않습니다',
    fontInvalid: '글꼴(font)이 올바르지 않습니다',
    itemInvalid: '필기 항목이 올바르지 않습니다',
    idInvalid: '필기 id가 올바르지 않습니다',
    colorInvalid: '필기 색이 올바르지 않습니다',
    textHighlightRectsInvalid: '텍스트 형광의 위치(rects)가 올바르지 않습니다',
    textHighlightTooLarge: (maxLines: number) => `텍스트 형광이 너무 큽니다 (최대 ${maxLines}줄)`,
    textHighlightCharsInvalid: '텍스트 형광의 글자 범위(chars)가 올바르지 않습니다',
    textHighlightEngineInvalid: '텍스트 형광의 engine이 올바르지 않습니다',
    unknownType: '알 수 없는 필기 종류입니다',
    markerKeyInvalid: '질문 표시 키가 올바르지 않습니다',
    hiddenMarkersNotArray: 'hiddenMarkers는 배열이어야 합니다',
    tooManyHiddenMarkers: (max: number) => `숨긴 질문 표시는 슬라이드마다 최대 ${max}개까지입니다`,
    tooManyItems: (max: number) => `필기는 슬라이드마다 최대 ${max}개까지 둘 수 있습니다`,
    baseRevRequired: 'baseRev(0 이상의 정수)가 필요합니다',
    itemsRequired: 'items 배열이 필요합니다',
    duplicateId: '필기 id가 겹칩니다',
    opsRequired: 'ops 배열이 필요합니다',
    tooManyOps: (max: number) => `한 번에 최대 ${max}개의 작업만 보낼 수 있습니다`,
    opInvalid: '필기 작업이 올바르지 않습니다',
    opIdInvalid: '필기 작업의 id가 올바르지 않습니다',
    opPatchInvalid: '필기 작업의 patch가 올바르지 않습니다',
    unknownField: (key: string) => `이 필기에 없는 항목입니다: ${key}`,
    unknownOp: '알 수 없는 필기 작업입니다',
    listUnreadable: (error: string) => `필기 목록을 읽지 못했습니다: ${error}`,
    /** 404 bodies of GET …/text-layout/:slide (TextLayoutMissingResponse). */
    layoutPending: '이 슬라이드의 글자 위치를 아직 준비하지 못했어요',
    layoutNever: '이 슬라이드에는 글자 위치 정보가 없어요',
  },
};
