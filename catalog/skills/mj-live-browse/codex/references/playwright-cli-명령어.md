# playwright-cli 명령어 레퍼런스 (fallback 전용)

> **이 도구는 agent-browser가 지원하지 못하는 경우에만 사용한다.**
> - iframe 내부 요소 접근 (jQuery UI Dialog + iframe 모달)
> - agent-browser snapshot에 iframe 내부가 비어있을 때
>
> 일반 탐색/검증/확인은 `agent-browser`를 사용한다 (6.6x 빠름, 2.3x 토큰 절약).

Chrome Beta CDP에 연결된 상태에서 사용하는 명령어.
모든 명령어 앞에 `./e2e/pwc.sh` (래퍼 스크립트) 또는 `playwright-cli --config=$HOME/.playwright/cli.config.json`을 붙인다.

> `./e2e/pwc.sh`는 `playwright-cli --config=$HOME/.playwright/cli.config.json`의 래퍼 스크립트.
> Claude Bash(비인터랙티브 셸)에서 zsh alias가 동작하지 않으므로 스크립트로 래핑.

## CDP 설정

`~/.playwright/cli.config.json` (`./e2e.sh setup`이 자동 생성):
```json
{
  "browser": {
    "cdpEndpoint": "http://localhost:9222",
    "isolated": false
  }
}
```

> `isolated: false` 필수 -- 기본값 `true`면 CDP에 연결해도 새 브라우저가 열린다.

## 환경 설정

```bash
# 최초 1회 환경 구성 (Chrome Beta 설치 확인, playwright-cli 설치, 설정 파일 생성)
cd e2e && ./e2e.sh setup
```

## 세션 관리

```bash
./e2e/pwc.sh open                    # CDP 연결 (또는 브라우저 시작)
./e2e/pwc.sh list                    # 세션 상태 확인
./e2e/pwc.sh close                   # CDP 연결 끊기 (브라우저는 유지)
```

## 탐색 (Navigation)

```bash
./e2e/pwc.sh goto "https://URL"      # 페이지 이동
./e2e/pwc.sh back                    # 뒤로
./e2e/pwc.sh forward                 # 앞으로
```

## 스냅샷 & 요소 확인

```bash
./e2e/pwc.sh snapshot                # 현재 페이지 스냅샷 → e2e/.playwright-cli/page-*.yml 저장
./e2e/pwc.sh screenshot              # 스크린샷 저장
```

> **snapshot 출력을 AI가 통째로 읽으면 토큰 폭발** (대규모 페이지 기준 328KB ~ 82,000 토큰)
> snapshot 실행 후 반드시 **yml 파일을 grep으로 필터링**해서 필요한 ref만 읽는다.

**ref 찾는 올바른 방법:**
```bash
# snapshot 실행 후 yml 파일에서 필터링
./e2e/pwc.sh snapshot && grep -i "찾을요소" e2e/.playwright-cli/page-*.yml | grep "ref=" | tail -5
```

스냅샷 출력 예시:
```yaml
- link "Gmail" [ref=e10] [cursor=pointer]:
    - /url: https://mail.google.com/
- button "검색" [ref=e64] [cursor=pointer]
- combobox "검색" [active] [ref=e37]
```

## 요소 조작

```bash
./e2e/pwc.sh click e10               # ref로 클릭
./e2e/pwc.sh fill e37 "텍스트"        # ref에 텍스트 입력
./e2e/pwc.sh select e20 "옵션값"      # select 옵션 선택
./e2e/pwc.sh check e15               # 체크박스 체크
./e2e/pwc.sh uncheck e15             # 체크박스 해제
./e2e/pwc.sh press Enter             # 키보드 입력
./e2e/pwc.sh press Tab
./e2e/pwc.sh press Escape
```

## JavaScript 실행 (단순 표현식만)

```bash
./e2e/pwc.sh eval "document.title"
./e2e/pwc.sh eval "document.querySelector('#id').value"
./e2e/pwc.sh eval "document.querySelectorAll('tr').length"
./e2e/pwc.sh eval "document.querySelector('.cls') ? document.querySelector('.cls').innerText.trim() : '없음'"
```

> **IIFE `(function(){...})()` 사용 금지** -- 직렬화 오류 발생.
> 여러 동작이 필요하면 각각 별도 eval로 나눠서 실행한다.

## 탭 관리

```bash
./e2e/pwc.sh tab-list                # 탭 목록
./e2e/pwc.sh tab-select 1            # 탭 전환 (0-based)
./e2e/pwc.sh tab-new "https://URL"   # 새 탭
./e2e/pwc.sh tab-close               # 현재 탭 닫기
```

## 저장 (Save as)

```bash
./e2e/pwc.sh save-as pdf             # PDF 저장
./e2e/pwc.sh save-as html            # HTML 저장
```

## 주의사항

- ref는 **DOM 변경 시 무효화** -- 클릭/이동 후 반드시 다시 snapshot
- **eval은 단순 표현식만** -- IIFE `(function(){...})()` 사용 금지 (직렬화 오류)
- **`### Page` URL/Title은 무시** -- `### Open tabs`의 `(current)` 탭이 실제 현재 탭
- snapshot 결과는 **`e2e/.playwright-cli/page-*.yml`** 파일에 저장 -- 이 파일을 grep
- `./e2e/pwc.sh close`는 **CDP 연결만 끊김** -- Chrome Beta 브라우저는 살아있음
- `--config` 옵션은 CLI 플래그로만 지정 (홈 디렉토리 자동 탐색 없음) → `pwc.sh`가 래핑
