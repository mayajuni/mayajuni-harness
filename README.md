# mayajuni-harness

`@mayajuni/harness`는 여러 스킬을 한 저장소에서 관리하고, `mhs` CLI로 설치/삭제/검증할 수 있게 만든 패키지입니다.

기본 사용은 질문형 CLI입니다. 옵션을 생략하면 `scope`, `skills`, `tools`, `install mode`를 순서대로 물어봅니다.

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
    └── mj-live-browse/
        └── codex/
            ├── SKILL.md
            └── references/
```

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
```

프로젝트 스코프로 설치:

```bash
mhs install --scope=project
```

개발 중인 스킬을 링크 설치:

```bash
mhs install mj-live-browse --codex --link --force
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
4. 복사 설치인지 링크 설치인지

`mhs uninstall`도 같은 방식으로 `scope`, `skills`, `tools`를 묻고 마지막에 삭제 확인을 받습니다. 자동화가 필요하면 `--yes`를 쓸 수 있습니다.

스킬과 툴은 멀티 선택이 가능합니다. 자동화할 때만 `--all`, `--scope`, `--codex`, `--claude`, `--link` 같은 옵션을 쓰면 됩니다.

## 권장 워크플로

개발 중에는 `link`, 배포 전에는 `copy + validate`를 권장합니다.

1. `catalog/skills/...` 아래에서 스킬을 만든다.
2. `mhs install ... --link`로 실제 사용 위치에 연결한다.
3. Codex나 Claude에서 직접 사용해본다.
4. 원본 스킬을 수정한다.
5. `mhs validate`로 엔트리 파일과 구조를 확인한다.
6. 배포 전에는 일반 `install`로 복사 설치해 최종 상태를 확인한다.

예시:

```bash
mhs install mj-live-browse --codex --link --force
mhs validate mj-live-browse --codex
```

`--link`를 쓰면 설치 대상이 원본 폴더를 가리키므로, `catalog/skills/...`를 수정한 내용이 바로 반영됩니다.

## 설치 경로

- Codex global: `~/.codex/skills`
- Claude global: `~/.claude/skills`
- Project scope: `./.harness/skills/<tool>`

`project` scope는 프로젝트 내부 설치 위치를 관리하기 위한 경로입니다. 실제 Codex/Claude가 이 경로를 자동으로 읽는지는 도구 설정에 따라 다를 수 있으니, 바로 사용되는 경로가 필요하면 `global` scope가 더 확실합니다.

환경 변수로 override 가능합니다.

```bash
HARNESS_CODEX_SKILLS_DIR=/custom/codex/skills mhs install mj-live-browse --codex
HARNESS_PROJECT_SKILLS_DIR=/custom/project-skills mhs install mj-live-browse --project --codex
```

## 스킬 추가

새 스킬을 추가하려면 `catalog/skills/<skill-name>/<target>/...`를 만들고 `skills.json`에 등록하면 됩니다.

예 (Codex 전용):

```text
catalog/skills/my-skill/
└── codex/
    ├── SKILL.md
    └── references/
```

Codex와 Claude 양쪽을 지원하려면:

```text
catalog/skills/my-skill/
├── codex/SKILL.md
└── claude/CLAUDE.md
```

## 배포 후 실행

패키지를 publish하면 아래처럼 실행할 수 있습니다.

```bash
npx @mayajuni/harness install mj-live-browse --codex
bunx @mayajuni/harness install mj-live-browse --codex
mhs install mj-live-browse --codex
```
