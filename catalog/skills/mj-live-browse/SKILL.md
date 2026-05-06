---
name: mj-live-browse
description: |
  agent-browser CLI로 Chrome Beta CDP에 연결해 실제 로그인된 브라우저에서 웹 작업을 자동 수행하는 스킬.
  트리거: "브라우저로 해줘", "사이트에서 처리해줘", "클릭해줘", "입력해줘", "업로드해줘", "페이지 봐줘".
  자동으로 의존성 체크/설치, Chrome Beta 실행, CDP 연결, 탭 선택까지 처리한다.
  고정 프로필($HOME/.chrome-beta-live-profile)에 저장된 로그인 세션을 그대로 이어받는다.
---

# AI 라이브 브라우저 제어 (자율 실행 버전)

브라우저 제어는 **`agent-browser`를 기본 도구**로 사용한다. (iframe 등 미지원 케이스에서만 playwright-cli 보조)
사용자가 자연어로 웹 작업을 요청하면 아래 부트스트랩 절차를 **자동 실행**하고 곧바로 작업에 들어간다.
사용자에게 탭 번호나 실행 여부를 묻지 않는다. 단, 결제·계정 삭제·돌이킬 수 없는 상태 변경 직전에는 한 번 확인한다.

> **고정 프로필**: `$HOME/.chrome-beta-live-profile` (변경 금지). 이 프로필에 사용자가 미리 로그인해 둔 세션을 AI가 이어받는다.

---

## 자동 부트스트랩 (작업 시작 시 항상 실행)

아래 한 블록을 그대로 실행하면 의존성 설치 → Chrome Beta 실행 → CDP 확인까지 끝난다.

> macOS에서는 Chrome Beta 바이너리를 `nohup ".../Google Chrome Beta"`로 직접 실행하지 않는다.
> 직접 실행하면 GUI 프로세스가 잠깐 뜬 뒤 종료되고, `agent-browser`가 임시 headless Chrome 세션으로 빠질 수 있다.
> 반드시 `open -na "Google Chrome Beta" --args ...`로 앱 런처를 통해 실행한다.

```bash
# 1) agent-browser 설치 확인 / 자동 설치
if ! command -v agent-browser >/dev/null 2>&1; then
  echo "📦 agent-browser 설치 중..."
  npm i -g agent-browser
fi

# 2) Chrome Beta CDP(9222) 살아 있는지 확인 / 없으면 GUI 앱으로 실행
if ! curl -s --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "🚀 Chrome Beta 실행 중..."

  # 이전에 Chrome Beta가 비정상 종료되며 남긴 stale profile lock만 제거
  lock="$HOME/.chrome-beta-live-profile/SingletonLock"
  if [ -L "$lock" ]; then
    lock_target="$(readlink "$lock" 2>/dev/null || true)"
    lock_pid="${lock_target##*-}"
    if [ -n "$lock_pid" ] && ! ps -p "$lock_pid" >/dev/null 2>&1; then
      rm -f "$HOME/.chrome-beta-live-profile/SingletonLock" \
            "$HOME/.chrome-beta-live-profile/SingletonSocket" \
            "$HOME/.chrome-beta-live-profile/SingletonCookie"
    fi
  fi

  /usr/bin/open -na "Google Chrome Beta" --args \
    --remote-debugging-port=9222 \
    "--remote-allow-origins=*" \
    "--user-data-dir=$HOME/.chrome-beta-live-profile" \
    --no-first-run \
    --no-default-browser-check

  # CDP 깨어날 때까지 폴링 (최대 10초)
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

# 3) 반드시 Beta CDP에 붙는지 확인
agent-browser --cdp 9222 tab list
```

> Windows(Git Bash)는 `"/c/Program Files/Google/Chrome Beta/Application/chrome.exe"` 경로로 대체.
> 이후 모든 `agent-browser` 명령은 기본 세션에 의존하지 말고 `agent-browser --cdp 9222 ...` 형태로 실행한다.
> `agent-browser connect 9222`만 호출한 뒤 `--cdp` 없이 명령하면, 9222가 죽었을 때 임시 headless Chrome으로 빠질 수 있다.

---

## 자동 탭 선택 규칙

부트스트랩 직후 `agent-browser --cdp 9222 tab list`로 탭을 가져와 아래 우선순위로 **AI가 직접 선택**한다 (사용자에게 묻지 않음).

1. 사용자가 URL/도메인을 명시했고, 그 도메인에 매칭되는 탭이 있으면 → 그 탭 사용 (`tab N`)
2. `about:blank` 탭이 있으면 → 그 탭 재활용 후 `open URL`
3. 탭이 하나뿐이면 → 그 탭에 `open URL`
4. 위에 해당 없으면 → `tab new "URL"`로 새 탭

선택 직후에는 반드시 다음을 실행해 의도한 페이지인지 확인한다:

```bash
agent-browser --cdp 9222 eval "document.title + ' | ' + location.href"
```

다르면 다시 navigate. 사용자에게 먼저 묻지 않는다.

---

## 작업 수행 패턴

### 데이터 조회 (eval 우선 — 빠르고 토큰 절약)

```bash
agent-browser --cdp 9222 eval "document.title"
agent-browser --cdp 9222 eval "document.querySelector('#field').value"
agent-browser --cdp 9222 eval "JSON.stringify(Array.from(document.querySelectorAll('li.item')).map(el=>el.innerText))"
agent-browser --cdp 9222 eval "document.body.innerText.substring(0, 2000)"
```

> **eval은 단순 표현식만**. IIFE `(function(){...})()` 금지 — 직렬화 오류. 동작이 여러 개면 eval을 나눠 호출.

### 클릭/입력 (셀렉터 모를 때 snapshot)

```bash
# 인터랙티브 요소만 + 컴팩트 (필수 옵션)
agent-browser --cdp 9222 snapshot -i -c
agent-browser --cdp 9222 snapshot -i -c -s "form"     # 범위 제한

# ref 기반 조작 (DOM 바뀌면 무효 → 다시 snapshot)
agent-browser --cdp 9222 click e10
agent-browser --cdp 9222 fill e37 "검색어"
agent-browser --cdp 9222 press Enter
```

> **eval로 click()은 isTrusted:false** — 보안 폼/SPA에서 무시될 수 있음. 안 되면 snapshot → ref click.
> **전체 snapshot 금지** (~65k 토큰). 항상 `-i -c`.

### Angular/React에서 fill 후 버튼이 [disabled]면

```bash
agent-browser --cdp 9222 eval "document.querySelector('#input').dispatchEvent(new Event('input', {bubbles:true}))"
# 그래도 안 되면 change 이벤트도 발행
```

상세: `references/SPA-프레임워크-입력패턴.md`

### iframe 내부 접근 (agent-browser 미지원 → playwright-cli)

```bash
playwright-cli --config="$HOME/.playwright/cli.config.json" eval \
  "document.querySelector('iframe[src*=대상]').contentDocument.querySelector('#x').innerText"
```

config 자동 생성:
```bash
if [ ! -f "$HOME/.playwright/cli.config.json" ]; then
  mkdir -p "$HOME/.playwright"
  echo '{"browser":{"cdpEndpoint":"http://localhost:9222","isolated":false}}' > "$HOME/.playwright/cli.config.json"
fi
```

### Flutter 웹앱 (canvas/flt-semantics)

`document.body.innerText`가 빈값/"로딩 중"이면 Flutter 의심. UI 조작 대신 dart.js 분석 → fetch 직접 호출이 압도적으로 효율적.
상세: `references/Flutter-웹앱-패턴.md`

### 파일 업로드 (OS 다이얼로그 차단)

`agent-browser --cdp 9222 click`은 isTrusted:true라 다이얼로그가 뜬다. 미리 CDP `Page.setInterceptFileChooserDialog`로 가로챈 뒤 `setFileInputFiles(backendNodeId)` 주입.
상세: `references/SPA-프레임워크-입력패턴.md` §3.

---

## 마무리

작업 완료 후 결과를 사용자에게 텍스트로 요약 보고. Chrome Beta는 **종료하지 않는다** — 사용자가 같은 세션을 계속 쓸 수 있도록 살려둔다.

(작업이 끝나고 사용자가 명시적으로 닫아 달라 하면:
```bash
pkill -f "Google Chrome Beta.*--remote-debugging-port=9222" || true
```
)

---

## 안전 가드

자율 실행이지만 아래는 멈추고 사용자 확인:

- **결제 버튼 클릭 직전** (장바구니 담기/조회는 OK, 최종 결제만 확인)
- **계정 삭제/탈퇴/비밀번호 변경 직전**
- **돌이킬 수 없는 데이터 삭제 직전**
- **로그인이 안 된 상태에서 로그인 시도 — AI가 직접 로그인하지 않음.** 사용자에게 "고정 프로필에 로그인해 주세요" 안내 후 대기.
- **2차 인증/캡차** — 사용자에게 처리 요청 후 대기.

그 외(조회·검색·필터·페이지 이동·폼 작성·자동완성·집계 등)는 묻지 않고 진행한다.

---

## 핵심 규칙 (요약)

1. 부트스트랩 블록을 매번 실행 (이미 떠 있으면 빠르게 통과).
2. 탭은 AI가 자동 선택, 단 선택 직후 `eval document.title`로 확인.
3. 모든 `agent-browser` 명령은 `--cdp 9222`를 붙여 Chrome Beta에 직접 실행.
4. 조회는 eval 우선, 클릭/입력은 ref(snapshot) 우선.
5. snapshot은 `-i -c` 필수.
6. eval은 단순 표현식만, 여러 동작은 나눠 호출.
7. ref는 DOM 바뀌면 무효 → 재 snapshot.
8. iframe → playwright-cli, Flutter → API 직접 호출 검토.
9. screenshot + 이미지 Read 금지(토큰 폭발). 텍스트는 `body.innerText.substring`으로 추출.
10. 작업 끝나도 Chrome Beta 살려둠.
11. 결제/탈퇴/삭제 직전만 확인.

## 참조 문서

| 문서 | 용도 |
|------|------|
| `references/SPA-프레임워크-입력패턴.md` | Angular/React 이벤트 발행, 파일 업로드 CDP 인터셉트 |
| `references/iframe-모달-패턴.md` | jQuery UI Dialog + iframe |
| `references/Flutter-웹앱-패턴.md` | Flutter 판별 / API 직접 호출 |
| `references/native-dialog-주의사항.md` | alert/confirm 자동 dismiss 이슈 |
| `references/외부서비스-링크전환-패턴.md` | 외부 서비스 전환 fallback |
| `references/토큰-최적화-실측데이터.md` | 명령별 토큰 비용 |
