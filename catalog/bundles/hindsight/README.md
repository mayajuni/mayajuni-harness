# Hindsight 프로젝트 번들

Hindsight 프로젝트 번들은 Codex와 Claude Code가 현재 저장소에 관한 기억을 자동으로 조회하고 증분 저장하도록 연결합니다. 일반 스킬이 아니라 Git 저장소별로 설치하는 훅 번들이며 MCP 설정은 추가하지 않습니다.

## 동작 방식

런타임은 `./.codex/hindsight`에 한 번만 설치하며 Codex와 Claude Code가 함께 사용합니다.

- 공용 런타임과 설정: `./.codex/hindsight`
- 프로젝트별 비밀 설정: `./.codex/hindsight/secrets.json`
- Codex 훅: `./.codex/hooks.json`
- Claude Code 훅: `./.claude/settings.json`
- 설치 메타데이터: `./.codex/hindsight/.harness-install.json`

Claude를 선택해도 `./.claude/hindsight`는 생성되지 않습니다. Claude 훅이 공용 `./.codex/hindsight/scripts`를 실행하는 구조입니다. 기존 JSON 설정과 다른 훅은 보존합니다.

## 사전 준비

설치 대상은 Git 저장소여야 하며 Python 3가 필요합니다. 연결할 Hindsight API URL과 프로젝트에서 사용할 API 토큰을 준비하세요. 프로젝트마다 서로 다른 API 토큰을 사용할 수 있습니다.

토큰을 코드, `settings.json`, 셸 히스토리 또는 Git 저장소에 커밋하지 마세요.

## API URL

설치할 때 `--api-url`로 Hindsight API의 기본 URL을 입력합니다. 마지막 `/`는 자동으로 제거되며 `http://` 또는 `https://` URL만 허용됩니다.

```bash
--api-url=https://hindsight.example.com
```

입력한 URL은 설치된 `./.codex/hindsight/settings.json`의 `hindsightApiUrl`에 저장됩니다. 설치 대상 저장소가 공개되어 있고 API URL도 공개하고 싶지 않다면 이 설정 파일을 커밋하지 마세요.

실행 환경의 `HINDSIGHT_API_URL` 환경 변수로 설치된 설정값을 덮어쓸 수도 있습니다.

```bash
export HINDSIGHT_API_URL='https://hindsight.example.com'
```

## API 토큰 설정

질문형 설치에서는 API 토큰을 화면에 표시하지 않는 숨김 입력으로 받습니다. 입력한 토큰은 해당 프로젝트의 `./.codex/hindsight/secrets.json`에만 저장됩니다.

- 파일 권한: 소유자만 읽고 쓸 수 있는 `0600`
- Git 보호: 로컬 `.git/info/exclude`에 `/.codex/hindsight/secrets.json` 자동 등록
- 공유 범위: 현재 프로젝트의 Codex와 Claude Code만 공동 사용
- 일반 설정, 훅, 설치 메타데이터 및 로그에는 토큰을 기록하지 않음

토큰 입력에서 Enter만 누르면 기존 프로젝트 토큰을 보존합니다. 기존 토큰이 없다면 저장하지 않고 실행 시점의 `HINDSIGHT_API_TOKEN` 환경변수를 사용합니다.

질문할 수 없는 자동화 환경에서는 설치 명령을 실행할 때 `HINDSIGHT_API_TOKEN`을 설정하면 해당 프로젝트 비밀 파일에 저장합니다. 토큰을 명령행 옵션으로 전달하지 마세요.

```bash
read -s "HINDSIGHT_API_TOKEN?Hindsight API token: "
echo
export HINDSIGHT_API_TOKEN
mhs install hindsight \
  --project \
  --codex \
  --claude \
  --api-url=https://hindsight.example.com \
  --bank-id=my-project
unset HINDSIGHT_API_TOKEN
```

프로젝트 비밀 파일이 있으면 해당 토큰을 우선 사용합니다. 프로젝트 비밀 파일이 없는 경우에만 실행 환경의 `HINDSIGHT_API_TOKEN`을 전역 fallback으로 사용합니다.

## 설치

먼저 Hindsight를 사용할 프로젝트의 Git 저장소 루트로 이동합니다.

```bash
cd /path/to/target-project
```

`mhs` 명령을 사용할 수 있다면 Codex와 Claude Code에 함께 설치합니다.

```bash
mhs install hindsight \
  --project \
  --codex \
  --claude \
  --api-url=https://hindsight.example.com \
  --bank-id=my-project
```

이 저장소의 CLI를 직접 실행할 때는 대상 프로젝트 폴더에서 CLI의 절대 경로를 지정합니다.

```bash
node /path/to/mayajuni-harness/bin/harness-skills.js \
  install hindsight \
  --project \
  --codex \
  --claude \
  --api-url=https://hindsight.example.com \
  --bank-id=my-project
```

현재 기본 로컬 경로를 사용하는 예시는 다음과 같습니다.

```bash
node /Users/mayajuni/Projects/dan/harness/bin/harness-skills.js \
  install hindsight \
  --project \
  --codex \
  --claude \
  --api-url=https://hindsight.example.com \
  --bank-id=my-project
```

Codex 또는 Claude Code만 사용한다면 필요하지 않은 옵션을 제외합니다.

```bash
mhs install hindsight --project --codex --api-url=https://hindsight.example.com --bank-id=my-project
mhs install hindsight --project --claude --api-url=https://hindsight.example.com --bank-id=my-project
```

질문형 설치에서는 `mhs install`을 실행하고 `project`, `hindsight`, 사용할 도구를 선택한 뒤 API URL, bank ID, API 토큰을 차례로 입력합니다. bank ID는 저장소 폴더명을 기본값으로 제안하며 토큰은 화면에 표시되지 않습니다.

### bank ID

bank ID는 해당 프로젝트의 기억을 구분하는 식별자입니다. 같은 프로젝트를 Codex와 Claude Code에서 함께 사용하려면 동일한 bank ID를 사용하세요.

권장 형식:

- 저장소 이름과 동일하거나 쉽게 연결되는 값
- 영문자, 숫자, `.`, `_`, `:`, `-` 사용
- 다른 프로젝트와 중복되지 않는 값

예: `hangil-ai`, `dan-harness`, `project:my-app`

## 설치 결과 확인

설치 대상과 bank ID를 확인합니다.

```bash
jq . .codex/hindsight/.harness-install.json
```

Codex와 Claude Code를 모두 선택했다면 `targets`에 두 값이 표시되어야 합니다.

```json
{
  "installer": "hindsight-project",
  "bankId": "my-project",
  "targets": [
    "claude",
    "codex"
  ]
}
```

공용 설정에서 자동 recall과 retain이 활성화됐는지 확인합니다.

```bash
jq '{
  hindsightApiUrl,
  bankId,
  autoRecall,
  autoRetain,
  codex,
  claudeCode
}' .codex/hindsight/settings.json
```

각 도구의 훅 등록 여부를 확인합니다.

```bash
rg 'hindsight|HINDSIGHT_BANK_ID' .codex/hooks.json
rg 'hindsight|HINDSIGHT_AGENT_NAME=claude-code' .claude/settings.json
```

토큰 값을 출력하지 않고 프로젝트 비밀 파일의 권한과 Git 제외 여부를 확인합니다.

```bash
test -s .codex/hindsight/secrets.json && echo "project token is stored"
stat -f '%Sp %N' .codex/hindsight/secrets.json
git check-ignore .codex/hindsight/secrets.json
```

정상 권한은 `-rw-------`이며 `git check-ignore` 결과에 비밀 파일 경로가 표시됩니다. 프로젝트 비밀 파일과 실행 환경의 `HINDSIGHT_API_TOKEN`이 모두 없으면 설치는 완료되지만 recall과 retain 훅은 오류 없이 건너뜁니다.

토큰 로딩 우선순위:

1. 프로젝트의 `./.codex/hindsight/secrets.json`
2. 실행 환경의 `HINDSIGHT_API_TOKEN`
3. 토큰이 없으면 훅 건너뜀

## 기본 저장 프로필

- 자동 recall: 활성화
- 자동 retain: 활성화
- Codex: 3턴마다 증분 저장
- Claude Code: 5턴마다 증분 저장
- Claude Code: 세션 종료 시 최종 저장
- 도구 호출 내용: 저장하지 않음

## 업데이트와 재설치

이미 `./.codex/hindsight`가 있다면 `--force`로 런타임을 갱신하고 훅을 다시 병합합니다. 토큰 입력에서 Enter를 누르면 기존 `secrets.json`과 파일 권한을 보존합니다. 질문할 수 없는 자동화 환경에서도 기존 프로젝트 토큰을 우선 보존하므로, 셸에 다른 프로젝트의 `HINDSIGHT_API_TOKEN`이 있더라도 재설치만으로 덮어쓰지 않습니다.

```bash
mhs install hindsight \
  --project \
  --codex \
  --claude \
  --api-url=https://hindsight.example.com \
  --bank-id=my-project \
  --force
```

한 도구만 나중에 추가할 수도 있습니다. 기존 설치에서 사용한 bank ID를 그대로 지정하세요.

```bash
mhs install hindsight \
  --project \
  --claude \
  --api-url=https://hindsight.example.com \
  --bank-id=my-project \
  --force
```

## 삭제

Codex와 Claude Code에서 모두 제거합니다.

```bash
mhs uninstall hindsight --project --codex --claude --yes
```

한 도구만 제거하면 해당 훅만 삭제하고, 다른 도구가 사용하는 공용 런타임은 유지합니다.

```bash
mhs uninstall hindsight --project --claude --yes
```

마지막 대상까지 제거하면 `./.codex/hindsight` 런타임과 프로젝트 API 토큰도 함께 삭제됩니다. 기존 JSON 설정과 Hindsight가 아닌 다른 훅은 보존합니다. `.git/info/exclude`의 비밀 파일 제외 규칙은 무해한 로컬 보호 규칙으로 남겨둡니다.

## 문제 해결

### `.codex/hindsight`만 생성됨

정상 동작입니다. Codex와 Claude Code가 이 런타임을 공유합니다. Claude 설치 여부는 `./.claude/settings.json`과 `.harness-install.json`의 `targets`에서 확인하세요.

### 설치됐지만 기억을 조회하거나 저장하지 않음

프로젝트 비밀 파일 또는 실행 환경에 토큰이 있는지 값 자체를 출력하지 않고 확인합니다.

```bash
test -s .codex/hindsight/secrets.json \
  && echo "project token is stored" \
  || echo "project token is missing"
test -n "$HINDSIGHT_API_TOKEN" \
  && echo "environment token is set" \
  || echo "environment token is missing"
```

둘 중 하나라도 있으면 Codex 또는 Claude Code를 완전히 종료했다가 프로젝트에서 다시 실행하세요.

### `Target already exists` 오류

기존 설치를 갱신하려면 같은 API URL 및 bank ID와 `--force`를 사용합니다.

### API URL 오류

질문 없이 설치할 때는 `--api-url`이 필수입니다. 프로토콜을 포함한 전체 URL을 입력하고 URL 안에 아이디나 비밀번호를 넣지 마세요.

```bash
--api-url=https://hindsight.example.com
```

### `hindsight project install must be run inside a Git repository` 오류

설치할 프로젝트의 Git 저장소 안에서 명령을 실행하세요. 저장소 하위 폴더에서 실행해도 CLI가 Git 루트를 찾아 설치하지만, 혼동을 줄이려면 저장소 루트에서 실행하는 것을 권장합니다.

### JSON 설정 오류

`.codex/hooks.json` 또는 `.claude/settings.json`이 올바른 JSON인지 확인하세요.

```bash
jq empty .codex/hooks.json
jq empty .claude/settings.json
```

잘못된 JSON은 자동으로 덮어쓰지 않습니다. JSON을 수정한 뒤 설치 명령을 다시 실행하세요.
