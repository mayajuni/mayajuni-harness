---
name: blog-publish
description: Dan의 블로그(/Users/mayajuni/Projects/dan/blog)에서 backup/drafts 디렉토리의 드래프트를 정식 발행하고 링크드인·쓰레드 SNS 글까지 만드는 워크플로우. 사용자가 "N편 발행해줘", "N편 해줘", "블로그 N편 올려줘", "이번 글 발행해", "SNS 글도 만들어줘" 같이 블로그 발행 의사를 보일 때 반드시 트리거. **사용자가 단순히 .md 파일명만 던졌을 때(예: "ai-usage-analysis-2-ai-team-manager.md", "07-graph-rag-neo4j-도입기.md", 또는 파일명 + "이거 해줘"/"이것도 해줘")도 발행 요청으로 해석하고 반드시 트리거**. "법령 블로그", "법률 AI 검색 실험기" 시리즈 발행 멘션도 포함. 새 글 발행, 발행 후 SNS 글 생성, 또는 둘 다를 한 번에 처리.
---

# Blog Publish Workflow

Dan의 블로그 발행 루틴을 자동화한다. 매번 수동으로 하던 6~7단계를 한 번에 처리한다.

블로그 루트: `/Users/mayajuni/Projects/dan/blog`

## 무엇을 자동화하는가

이 스킬이 트리거되면 다음을 처리한다:

1. **드래프트 위치 식별** — `backup/`(주 위치) 또는 `content/drafts/`에서 발행할 글 찾기
2. **정식 위치로 복사** — `content/posts/YYYY-MM-DD-{slug}.md`로 (slug은 frontmatter에서 가져옴, 날짜는 오늘)
3. **publish 플래그 활성화** — frontmatter `publish: false` → `publish: true`
4. **Git commit & push** — 정해진 커밋 메시지 형식
5. **SNS 글 생성** — 링크드인 / 쓰레드 두 가지 (사용자가 요청한 경우)

사용자가 일부만 원할 수도 있다(발행만, SNS만, 등). 맥락을 보고 판단하라.

## 발행 절차

### 드래프트 찾기

사용자가 "N편" 또는 파일명을 지정하면 그것에 맞는 파일을 `backup/` 또는 `content/drafts/`에서 찾는다.

- `backup/NN-*.md` (예: `backup/07-graph-rag-neo4j-도입기.md`)
- `content/drafts/NN-*.md`

여러 후보가 있거나 모호하면 사용자에게 확인한다.

### 파일명 결정

새 파일명은 `content/posts/{오늘날짜}-{slug}.md` 형식이다.
- 날짜는 `YYYY-MM-DD` (시스템 컨텍스트의 currentDate 사용)
- slug은 드래프트 frontmatter의 `slug:` 필드에서 그대로 가져온다

예: frontmatter에 `slug: "legal-ai-search-07-graph-rag-neo4j"`라면
→ `content/posts/2026-04-18-legal-ai-search-07-graph-rag-neo4j.md`

### 복사 및 publish 활성화

```bash
cp backup/<원본파일> content/posts/<새파일명>
```

그 다음 새 파일의 frontmatter에서 `publish: false`를 `publish: true`로 Edit 한다. (Read 먼저 해야 Edit 가능)

### Commit & Push

블로그 시리즈는 보통 N번째로 카운트되어 발행된다. 시리즈 글(법령 블로그)인 경우:

```
N번째 법령 블로그 발행

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

N은 시리즈상 몇 번째인지(파일명 NN-에서 추출 가능). 시리즈가 아닌 경우 글의 성격에 맞는 짧은 한 줄 메시지로 한다.

```bash
git add content/posts/<새파일명> && git commit -m "$(cat <<'EOF'
N번째 법령 블로그 발행

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)" && git push
```

(Co-Authored-By의 모델명은 현재 세션 모델에 맞춰 조정한다. 환경의 모델 정보가 있으면 그것을 따른다.)

### 발행된 드래프트 정리

발행이 끝나면 **원본 드래프트를 삭제**한다. `content/posts/`에 정식 발행본이 있는데 `backup/` 또는 `content/drafts/`에 같은 글이 남아 있으면, 다음 발행 작업에서 후보 목록이 어지러워지고 "이거 발행됐나?"를 매번 확인해야 한다.

```bash
rm backup/<원본파일>
# 또는
rm "content/drafts/<원본파일>"
```

push까지 완료한 뒤에 삭제한다. 발행 commit이 만들어지기 전에 드래프트를 지우면 복구가 번거롭다.

사용자가 명시적으로 "드래프트는 남겨둬"라고 하면 두지만, 기본은 *발행 = 드래프트 삭제*. 발행본이 정본이고 드래프트는 그 길의 흔적이다.

## SNS 글 생성

발행 후, 또는 사용자가 요청하면 두 가지 글을 만든다.

### 톤 가이드 (사용자 합의된 스타일)

- **무게감 있고 전문가 느낌**. 가벼운 이모지/감탄 남발 금지
- **너무 많은 정보를 담지 않는다.** 한두 가지 핵심 포인트만
- 본문에 결론을 다 풀지 말고 **"블로그에 정리해 두었습니다"** 같이 클릭 유도
- 질문형 훅으로 시작하는 패턴이 잘 맞음

### 블로그 URL 형식

`https://blog.dongjun.win/{slug}`

slug은 frontmatter의 `slug:` 필드 값.

### 링크드인 템플릿

```
"[질문형 훅 — 글의 핵심 문제 한 줄]"
[1~2문장으로 배경/문제 상황 설명]

[1~2문장으로 무엇을 했는지, 핵심 발견]. 결론이 꽤 의외였는데, 블로그에 정리해 두었습니다.

[blog URL]

#LegalTech #RAG #법률AI [+ 글에 맞는 1~2개]
```

리스트(`-` 불릿) 사용은 핵심 발견이 3개 정도로 명확히 떨어질 때만 쓴다. 보통은 산문 형식이 더 무게감 있다.

### 쓰레드 템플릿

링크드인보다 더 짧고 가볍게. 그러나 여전히 무게감 유지.

```
"[질문형 훅]"
[1~2문장 배경]
[1~2문장 발견 — 의외성 강조]
[클릭 유도 한 줄]
👉 blog.dongjun.win/{slug}
```

쓰레드는 `https://` 없이 짧은 도메인 형식 선호. 해시태그는 보통 생략(쓰레드 문화).

### 톤 예시 (참고)

좋은 링크드인 도입부:
- "검색 결과에 정답이 있는데 왜 답변에서 빠지죠?"
- "쿼리를 다시 쓰면 검색이 좋아질까?"
- "부당해고 당했는데 어떻게 하나요?"
- "실험이 끝나는 순간은 생각보다 조용하다."

피해야 할 패턴:
- 이모지 폭격(🔥🚀💯)
- "처참한", "멘붕" 같은 과장 (초기 톤이었으나 지양)
- 모든 발견을 SNS에 다 풀어버리기 (블로그를 안 봐도 됨)

## 사용자가 자주 하는 추가 요청

- **"살짝 다듬어줘"** — 큰 구조는 유지, 문장만 자연스럽게
- **"이거 빼는 게 좋을까?"** — 짧게 의견 + 이유. 사용자 판단 존중
- **"무게감 있게"** — 감탄/이모지 줄이고 산문 비율 늘리기
- **"커밋만 해줘"** — push는 하지 않기

## 시리즈 카운트 확인

"N번째 법령 블로그 발행" 메시지의 N은 `content/posts/`에서 `legal-ai-search-*` 또는 `법령` 패턴 파일을 세서 결정. 새 글 포함 카운트.

```bash
ls content/posts/ | grep -E "(legal-ai-search|법령|법률)" | wc -l
```

## 절대 하지 말 것

- 사용자가 명시적으로 push를 요청하지 않은 게 분명한 맥락(예: "커밋만")이면 push 하지 말 것
- frontmatter의 `slug` 외에 임의 슬러그를 만들지 말 것
- SNS 글에 글 내용을 다 풀어쓰지 말 것 — 클릭 유도가 목적
- 이전 세션에서 다듬은 SNS 톤을 무시하고 새로 쓰지 말 것 — 합의된 패턴을 따른다
