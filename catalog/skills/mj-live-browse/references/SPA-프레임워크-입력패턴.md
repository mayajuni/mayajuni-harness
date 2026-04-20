# SPA 프레임워크 입력 패턴

> Angular / React 등 SPA 프레임워크 사이트를 agent-browser로 제어할 때 발생하는 입력 실패 우회 패턴.
> 특정 사이트 전용이 아닌 어떤 SPA 사이트에서든 동일하게 적용된다.
> 작성 근거: 실전 제어 경험 누적 (2026-04-19~)

---

## 1. Angular ngModel / React controlled input — fill 실패

### 원인

`agent-browser fill` 또는 `eval element.value = 'text'`는 DOM 값만 바꾸고
프레임워크의 change/input 이벤트를 트리거하지 않아 제출 버튼이 비활성 상태로 남는다.

### 해결 — 3단계 순서

```bash
# 1단계: focus 먼저
agent-browser eval "document.querySelector('textarea[aria-label=\"쿼리 상자\"]').focus()"

# 2단계: fill 시도 (성공하면 끝)
agent-browser fill ref "입력할 텍스트"

# 3단계: fill 후 버튼이 [disabled]이면 → input 이벤트 발행
agent-browser eval "document.querySelector('textarea').dispatchEvent(new Event('input', {bubbles:true}))"
agent-browser eval "document.querySelector('textarea').dispatchEvent(new Event('change', {bubbles:true}))"
```

### 판별법

fill 후 `agent-browser snapshot -i -c`에서 버튼이 여전히 `[disabled]`이면 이벤트 미발행.

### 이벤트 발행 흐름

```
fill 또는 eval value 설정 후 버튼이 [disabled]이면
  → snapshot -i -c 에서 버튼 상태 재확인
  → [disabled] 유지 → 이벤트 미발행 의심
  → eval dispatchEvent(new Event('input', {bubbles:true})) 추가 시도
  → 여전히 [disabled] → change 이벤트도 발행
  → 여전히 [disabled] → CDP Input.insertText 시도 (아래 §4 참조)
```

---

## 2. 숨겨진 file input 탐색 — TreeWalker

### 원인

SPA에서 file input이 `display:none` 또는 프레임워크 컴포넌트 내부에 있으면
`document.querySelector('input[type=file]')`가 null 반환.

### 해결 — TreeWalker 전체 DOM 순회

```bash
agent-browser eval "
var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
var node;
while(node = walker.nextNode()) {
  if (node.tagName === 'INPUT' && node.type === 'file')
    return 'found: accept=' + node.accept + ' visible=' + (node.offsetWidth > 0);
}
'not found'
"
```

> **주의**: `eval`은 단순 표현식만 허용. IIFE `(function(){...})()`는 직렬화 오류 발생.
> 위 코드는 블록문이 필요하므로 `agent-browser eval "..."`로 멀티라인 전달 시
> 스크립트 방식으로 실행된다. 안 되면 아래 한 줄 버전 사용:

```bash
# 한 줄 버전
agent-browser eval "Array.from(document.querySelectorAll('*')).filter(function(n){return n.tagName==='INPUT'&&n.type==='file'}).map(function(n){return 'accept='+n.accept+' visible='+(n.offsetWidth>0)}).join(',')||'not found'"
```

### 실전 사례

Google Drive 업로드 등 Angular SPA에서 querySelector 실패 시 TreeWalker로 탐색 가능.

---

## 3. 파일 업로드 — OS 다이얼로그 완전 차단 (권장 기본값)

### 문제

사이트가 `파일 업로드` 버튼 클릭 시 OS 네이티브 파일 선택 다이얼로그를 띄우는 경우,
`DOM.setFileInputFiles` 직접 주입만으로는 다이얼로그가 잔존하여 이후 명령이 막힌다.

**왜 Escape로 닫히지 않는가**: macOS 파일 다이얼로그는 Chrome 바깥의 XPC 서비스
(`com.apple.appkit.xpc.openAndSavePanelService`)로 뜬다.
CDP 키 이벤트(`Input.dispatchKeyEvent`)와 `agent-browser press Escape` 모두
브라우저 프로세스 범위 안의 이벤트라 XPC 서비스에 전달되지 않는다.
실측 결과 두 방법 모두 닫히지 않음이 확인됨 (2026-04-19).

### 해결 — Page.setInterceptFileChooserDialog (어떤 사이트든 동일)

CDP `Page.setInterceptFileChooserDialog`를 활성화하면 브라우저가 파일 선택기를
OS에 위임하지 않고 `Page.fileChooserOpened` 이벤트로 가로챈다.
OS 다이얼로그 자체가 열리지 않으므로 Escape 처리가 불필요하다.

**흐름:**
```
1. CDP 스크립트 백그라운드 실행 (인터셉트 활성화 + 이벤트 대기)
2. agent-browser click 으로 업로드 트리거 버튼 클릭
   ⚠️ eval click()은 isTrusted:false라 SPA가 무시할 수 있음 — agent-browser click 필수
3. 스크립트가 Page.fileChooserOpened 이벤트에서 backendNodeId 수신
4. DOM.setFileInputFiles({ files, backendNodeId }) 로 파일 주입
5. Page.setInterceptFileChooserDialog(enabled: false) 로 인터셉트 해제
```

### 탭 targetId 확인 방법

인터셉트 스크립트는 URL 키워드 대신 **targetId** 로 탭을 특정한다.
동일 도메인 탭이 여러 개일 때도 정확한 탭에 인터셉트가 걸린다.

```bash
# agent-browser tab list 출력 후 원하는 탭에서 targetId 확인
agent-browser eval "'' + location.href"   # 현재 탭 URL 확인
curl -s http://127.0.0.1:9222/json | node -e \
  "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
   d.filter(t=>t.type==='page').forEach(t=>console.log(t.id, t.url.substring(0,60)))"
# → 출력된 id(targetId) 값을 아래 TAB_TARGET_ID에 입력
```

### 스크립트 템플릿

아래를 `/tmp/file-upload-intercept.mjs` 로 저장 후 백그라운드 실행한다.
`TAB_TARGET_ID`와 `FILES`만 수정하면 어떤 사이트에서든 재사용 가능하다.

```javascript
// === 수정할 부분 ===
const FILES = [
  '/절대/경로/파일1.pdf',
  '/절대/경로/파일2.m4a',
];
// agent-browser tab list 후 curl 명령으로 확인한 targetId
const TAB_TARGET_ID = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
// === 여기까지 ===

const res = await fetch('http://127.0.0.1:9222/json');
const tabs = await res.json();
// targetId로 정확한 탭 선택 (URL 키워드는 동일 도메인 탭이 여럿일 때 엉뚱한 탭에 걸릴 수 있어 사용 금지)
const tab = tabs.find(t => t.id === TAB_TARGET_ID);
if (!tab) { console.error('탭 없음 — targetId를 확인하세요:', TAB_TARGET_ID); process.exit(1); }
console.log('탭:', tab.title);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 1;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msgId = id++;
  const h = (e) => { const m = JSON.parse(e.data); if (m.id === msgId) { ws.removeEventListener('message', h); resolve(m.result || {}); } };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id: msgId, method, params }));
  setTimeout(() => reject(new Error('timeout: ' + method)), 10000);
});

ws.addEventListener('open', async () => {
  try {
    await send('Page.enable');
    await send('DOM.enable');

    // OS 다이얼로그 차단 활성화
    await send('Page.setInterceptFileChooserDialog', { enabled: true });
    console.log('인터셉트 활성화 — agent-browser click 으로 업로드 버튼을 클릭하세요');

    // Page.fileChooserOpened 이벤트 대기 (15초 — agent-browser click 시간 포함)
    const chooser = await new Promise((resolve, reject) => {
      const h = (e) => {
        const m = JSON.parse(e.data);
        if (m.method === 'Page.fileChooserOpened') { ws.removeEventListener('message', h); resolve(m.params); }
      };
      ws.addEventListener('message', h);
      setTimeout(() => reject(new Error('15초 초과 — 버튼 클릭이 감지되지 않음')), 15000);
    });

    console.log('fileChooserOpened backendNodeId:', chooser.backendNodeId, 'mode:', chooser.mode);

    // 파일 주입 (backendNodeId 우선, 없으면 querySelector fallback)
    if (chooser.backendNodeId) {
      await send('DOM.setFileInputFiles', { files: FILES, backendNodeId: chooser.backendNodeId });
    } else {
      const doc = await send('DOM.getDocument', { depth: 0 });
      const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
      if (!found.nodeId) throw new Error('file input 없음');
      await send('DOM.setFileInputFiles', { files: FILES, nodeId: found.nodeId });
    }
    console.log('✅ 파일 주입 완료 — OS 다이얼로그 없음');

  } catch (e) {
    console.error('❌', e.message);
  } finally {
    // 인터셉트 반드시 해제 (성공/실패 무관)
    try { await send('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (_) {}
    ws.close();
  }
});
```

### 실행 방법

```bash
# 1. 스크립트 백그라운드 실행
node /tmp/file-upload-intercept.mjs &
INTERCEPT_PID=$!

# 2. 1초 대기 후 agent-browser로 업로드 버튼 클릭 (ref는 snapshot으로 확인)
sleep 1
agent-browser click eXX

# 3. 스크립트 완료 대기
wait $INTERCEPT_PID
```

### 주의: 빠른 경로(직접 주입)는 검증된 사이트에서만

일부 사이트는 `DOM.setFileInputFiles` 직접 주입으로도 OS 다이얼로그가 열리지 않는다.
**단, 처음 시도하는 사이트에서는 반드시 인터셉트 방식을 기본으로 사용할 것.**
직접 주입을 먼저 시도했다가 다이얼로그가 열리면 — CDP/Escape로 닫을 수 없어 세션이 막힌다.

빠른 경로 사용 조건:
- 해당 사이트에서 직접 주입 시 OS 다이얼로그가 열리지 않음을 이미 검증한 경우만 허용

---

## 4. CDP Input.insertText — 최후 수단

### 조건

- eval + 이벤트 발행으로도 버튼이 활성화되지 않을 때
- Playwright/Node.js CDP 자동화 스크립트 환경에서만 사용 가능
- 순수 `agent-browser` CLI 환경에서는 사용 불가

### 구현 (Node.js + Playwright)

```javascript
// 1. textarea focus
await page.evaluate(() => document.querySelector('textarea').focus());

// 2. CDP Input.insertText 전송
const cdpSession = await page.context().newCDPSession(page);
await cdpSession.send('Input.insertText', { text: '입력할 텍스트' });

// → Angular ngModel, React controlled input 모두 정상 트리거됨
```

### agent-browser CLI 환경에서의 대안 순서

```
1. focus → fill
2. fill 실패 → eval value + input 이벤트 발행
3. 여전히 실패 → eval value + change 이벤트 발행
4. 여전히 실패 → CDP Input.insertText (자동화 스크립트 필요)
```

---

## 5. tab list 후 탭 번호 변경 감지

### 원인

사용자가 탭 번호를 응답하는 사이(수 초~수십 초) Chrome에서 탭이 닫히거나
페이지가 새로고침 되면 번호가 달라짐.

### 해결 — tab N 직후 title 재확인 필수

```bash
# 1. 사용자가 "2번 탭"이라고 응답한 뒤
agent-browser tab 2

# 2. 즉시 재확인 (탭이 바뀌지 않았는지)
agent-browser eval "document.title + ' | ' + location.href"

# 3. 예상한 사이트가 아니면 tab list 다시 출력 후 재선택
agent-browser tab list
```

**규칙**: `tab N` 직후 반드시 `eval "document.title + ' | ' + location.href"`로 탭 상태를 검증한다.
예상과 다르면 재확인.
