# mayajuni-harness

`@mayajuni/harness`는 여러 스킬을 한 저장소에서 관리하고, `mhs` CLI로 설치/삭제/검증할 수 있게 만든 패키지입니다. 현재 `mj-live-browse`, `video-highlight`, `media-highlight`, `blog-publish`, `blog-write`는 `codex`, `claude` 2타깃을 지원합니다.

기본 사용은 질문형 CLI입니다. 옵션을 생략하면 `scope`, `skills`, `tools`를 순서대로 물어봅니다.

## 이름

- npm package: `@mayajuni/harness`
- bin command: `mhs`
- repository: `mayajuni-harness`

## 구조

```text
.
├── bin/harness-skills.js
├── skills.json
└── catalog/skills/
    ├── mj-live-browse/
    │   ├── SKILL.md
    │   └── references/
    ├── video-highlight/
    │   ├── SKILL.md
    │   └── scripts/
    ├── media-highlight/
    │   ├── SKILL.md
    │   └── scripts/
    ├── blog-publish/
    │   └── SKILL.md
    └── blog-write/
        └── SKILL.md
```

각 스킬은 하나의 source를 두고, Codex와 Claude Code가 그 내용을 함께 사용합니다. 두 타깃 모두 같은 `SKILL.md`와 관련 보조 파일(`references/`, `scripts/` 등)을 설치합니다.

## 기본 사용

질문형 설치:

```bash
mhs install
npx @mayajuni/harness install
```

질문형 삭제:

```bash
mhs uninstall
npx @mayajuni/harness uninstall
```

목록 보기:

```bash
mhs list
npx @mayajuni/harness list
```

검증:

```bash
mhs validate
npx @mayajuni/harness validate
```

로컬 개발 중에는 현재 저장소 안에서 이렇게 실행할 수 있습니다:

```bash
npx . install
npx . uninstall
npx . validate
```

## 예시

전체 스킬 설치:

```bash
mhs install --all
```

특정 스킬만 설치:

```bash
mhs install mj-live-browse --codex
mhs install mj-live-browse --claude
mhs install video-highlight --codex
mhs install media-highlight --codex
mhs install blog-publish --codex
mhs install blog-write --codex
```

프로젝트 스코프로 설치:

```bash
mhs install --scope=project
```

설치 삭제:

```bash
mhs uninstall mj-live-browse --codex
mhs uninstall --all --project --yes
```

## 질문형 흐름

`mhs install`을 실행하면 다음을 묻습니다.

1. `global`인지 `project`인지
2. 설치할 스킬이 무엇인지, 혹은 `all`인지
3. 대상 툴이 무엇인지, 혹은 `all`인지

`mhs uninstall`도 같은 방식으로 `scope`, `skills`, `tools`를 묻고 마지막에 삭제 확인을 받습니다. 자동화가 필요하면 `--yes`를 쓸 수 있습니다.

스킬과 툴은 멀티 선택이 가능합니다. 자동화할 때는 `--all`, `--scope`, `--codex`, `--claude` 같은 옵션을 쓰면 됩니다.

## 권장 워크플로

설치는 항상 복사 설치입니다. 개발 중에도 설치 결과를 실제 로딩 경로에서 확인하고, source를 수정한 뒤 다시 `install --force`로 덮어쓰는 흐름을 권장합니다.

1. `catalog/skills/...` 아래에서 스킬을 만든다.
2. `mhs install ... --force`로 실제 사용 위치에 복사 설치한다.
3. Codex나 Claude에서 직접 사용해본다.
4. source 스킬을 수정한다.
5. `mhs validate`로 엔트리 파일과 구조를 확인한다.
6. 다시 `mhs install ... --force`로 설치본을 갱신한다.

예시:

```bash
mhs install mj-live-browse --codex --force
mhs validate mj-live-browse --codex
```

## 설치 경로

- Codex global: `~/.codex/skills`
- Claude global: `~/.claude/skills`
- Codex project: `./.agents/skills`
- Claude project: `./.claude/skills`

`project` scope는 각 도구가 실제로 읽는 기본 프로젝트 경로에 맞춰 설치합니다. 더 이상 `./.harness/skills/<tool>` 같은 별도 관리 경로를 기본값으로 쓰지 않습니다.

주의:

- Codex는 개인 설치에 `~/.codex/skills`를 주로 사용하지만, 프로젝트 스킬은 `./.agents/skills`에 맞춰 설치합니다.
- Claude Code는 공식 스킬 엔트리인 `SKILL.md`를 사용하며, 프로젝트 스킬은 `./.claude/skills`에 설치합니다.

환경 변수로 override 가능합니다.

```bash
HARNESS_CODEX_SKILLS_DIR=/custom/codex/skills mhs install mj-live-browse --codex
HARNESS_CLAUDE_SKILLS_DIR=/custom/claude/skills mhs install mj-live-browse --claude
HARNESS_PROJECT_SKILLS_DIR=/custom/project-skills-root mhs install mj-live-browse --project --codex
```

`HARNESS_PROJECT_SKILLS_DIR`를 지정하면 위 네이티브 기본 경로 대신 해당 경로를 project install root로 강제합니다. 기본 동작은 네이티브 경로를 쓰는 것입니다.

## 스킬 추가

새 스킬을 추가하려면 `catalog/skills/<skill-name>/...`를 만들고 `skills.json`에 등록하면 됩니다.

기본 구조:

```text
catalog/skills/my-skill/
├── SKILL.md
└── references/
```

Codex와 Claude Code가 같은 Agent Skills 형식을 쓰기 때문에 `skills.json`에서 두 타깃이 같은 source를 가리키게 두는 편이 낫습니다. 현재 등록된 스킬도 그 방식으로 구성돼 있습니다. 현재 각 타깃의 엔트리 파일은 `SKILL.md`입니다.

## 배포 후 실행

패키지를 publish하면 아래처럼 실행할 수 있습니다.

```bash
npx @mayajuni/harness install mj-live-browse --codex
bunx @mayajuni/harness install mj-live-browse --claude
npx @mayajuni/harness install video-highlight --codex
npx @mayajuni/harness install media-highlight --codex
npx @mayajuni/harness install blog-publish --codex
npx @mayajuni/harness install blog-write --codex
```
