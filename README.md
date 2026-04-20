# harness-skills

레포 안에서 여러 스킬을 관리하고, `npx`/`bunx`로 선택 설치할 수 있게 만든 최소 스캐폴드입니다.

개발 중에는 `link`, 배포 전에는 `copy + validate` 흐름을 권장합니다.

기본 사용은 질문형 설치입니다. 옵션을 생략하면 CLI가 스코프, 스킬, 타깃, 설치 방식을 순서대로 물어봅니다.

## 구조

```text
.
├── bin/harness-skills.js
├── skills.json
└── catalog/skills/
    ├── starter-workflow/
    │   ├── codex/SKILL.md
    │   └── claude/CLAUDE.md
    └── release-checklist/
        └── codex/SKILL.md
```

## 예시

전체 목록 보기:

```bash
npx . list
```

질문형 설치:

```bash
npx . install
```

질문형 삭제:

```bash
npx . uninstall
```

옵션으로 모든 스킬 설치:

```bash
npx . install --all
```

프로젝트 스코프로 설치:

```bash
npx . install --scope=project
```

프로젝트 스코프에서 여러 툴 선택:

```bash
npx . install starter-workflow --project --codex --claude
```

개발 중인 스킬을 라이브 링크로 설치:

```bash
npx . install starter-workflow --codex --link --force
```

특정 스킬 하나만 Codex 대상으로 설치:

```bash
npx . install starter-workflow --codex
```

여러 스킬을 Claude 대상으로만 설치:

```bash
npx . install starter-workflow another-skill --claude
```

기존 설치를 덮어쓰기:

```bash
npx . install starter-workflow --codex --force
```

설치 삭제:

```bash
npx . uninstall starter-workflow --codex
npx . uninstall --all --project --yes
```

manifest와 엔트리 파일 검증:

```bash
npx . validate
npx . validate starter-workflow --codex
```

## 질문형 흐름

`npx . install`처럼 실행하면 다음을 묻습니다.

1. global인지 project인지
2. 설치할 스킬이 무엇인지, 혹은 `all`인지
3. 대상 툴이 무엇인지, 혹은 `all`인지
4. 복사 설치인지 링크 설치인지

스킬과 툴은 멀티 선택이 가능합니다. 자동화가 필요할 때만 `--all`, `--scope`, `--codex`, `--claude`, `--link` 같은 옵션을 쓰면 됩니다.

`npx . uninstall`도 같은 방식으로 `scope`, `skills`, `tools`를 묻고 마지막에 삭제 확인을 받습니다. 자동화할 때는 `--yes`로 확인을 생략할 수 있습니다.

## 권장 워크플로

실제 사용하면서 수정할 때는 복사보다 링크가 편합니다.

1. 개발할 스킬을 링크 설치합니다.
2. 실제 Codex/Claude에서 그 스킬을 사용해봅니다.
3. 원본 `catalog/skills/...`를 수정합니다.
4. 필요하면 `npx . validate`로 구조를 확인합니다.
5. 배포 전에는 일반 `install`로 복사 설치해 최종 상태를 다시 확인합니다.

예시:

```bash
npx . install starter-workflow --codex --link --force
npx . validate starter-workflow --codex
```

`--link`를 쓰면 설치 대상이 원본 폴더를 가리키므로, `catalog/skills/...`를 수정한 내용이 바로 반영됩니다.

## 타깃 경로

- Codex 기본값: `~/.codex/skills`
- Claude 기본값: `~/.claude/skills`
- Project scope 기본값: `./.harness/skills/<tool>`

`project` scope는 프로젝트 내부 설치 위치를 관리하기 위한 경로입니다. 실제 Codex/Claude가 이 경로를 자동으로 읽는지는 도구 설정에 따라 다를 수 있으니, 바로 사용되는 경로가 필요하면 `global` scope가 더 확실합니다.

환경 변수로 override 가능합니다.

```bash
HARNESS_CODEX_SKILLS_DIR=/custom/codex/skills npx . install starter-workflow --codex
HARNESS_CLAUDE_SKILLS_DIR=/custom/claude/skills npx . install starter-workflow --claude
HARNESS_PROJECT_SKILLS_DIR=/custom/project-skills npx . install starter-workflow --project --codex
```

## 배포

패키지를 npm에 publish하면 아래처럼 사용할 수 있습니다.

```bash
npx harness-skills install starter-workflow --codex
bunx harness-skills install starter-workflow --claude
```

스킬을 추가하려면 `catalog/skills/<skill-name>/<target>/...`를 만들고 `skills.json`에 등록하면 됩니다.
