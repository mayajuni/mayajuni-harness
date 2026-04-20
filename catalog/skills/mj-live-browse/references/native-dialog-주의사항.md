# Native Dialog 주의사항

## 핵심 원칙

**`window.alert/confirm` JS monkey-patch는 동작하지 않는다.**

Playwright는 CDP `Page.javascriptDialogOpening` 이벤트를 JS 실행보다 먼저 받아
`DialogManager`에서 handler가 없으면 자동으로 `dialog.close()`(=dismiss, false 반환)를 호출한다.
monkey-patch가 실행될 기회 자체가 없다. **사용 금지.**

반드시 `page.on('dialog', handler)` CDP 레이어 handler를 사용한다.

---

## 문제 1: CDP 클라이언트가 native dialog를 자동 dismiss

`agent-browser connect 9222` 실행 시 상주 daemon이 생성된다.
이 daemon은 Playwright 계열 CDP 클라이언트로, 브라우저의 native `alert/confirm/prompt`를
handler 없이 자동으로 dismiss(false)한다.

사용자가 직접 dialog를 확인하거나 시나리오에서 dialog를 처리해야 하는 경우,
이 daemon이 붙어 있으면 dialog가 보이기도 전에 닫혀버린다.

### daemon 확인 및 종료

```bash
# 1. CDP 포트에 연결된 프로세스 확인
lsof -iTCP:9222 -sTCP:ESTABLISHED -n -P

# 2. node 프로세스 강제 종료 (kill만으로는 자식 프로세스 잔류 — kill -9 필수)
lsof -iTCP:9222 -sTCP:ESTABLISHED -n -P | awk '/node/{print $2}' | xargs kill -9

# 3. 종료 확인 (출력 없으면 정상)
lsof -iTCP:9222 -sTCP:ESTABLISHED -n -P
```

> `kill <PID>`는 자식 프로세스(daemon.js)가 살아남는 경우가 있다. 반드시 `kill -9` 사용.

### 브라우저 재시작이 필요한 경우

- **거의 없다.** daemon만 종료하면 브라우저는 정상 동작한다.
- CDP 포트 자체가 응답하지 않을 때만 재시작: `curl -s http://127.0.0.1:9222/json/version` 실패 시
- daemon 종료 후에도 dialog가 자동으로 닫히면 → 다른 CDP 클라이언트가 붙어 있는지 `lsof` 재확인

---

## 문제 2: 다중 CDP 세션 race condition

agent-browser daemon + E2E 스크립트가 동시에 CDP에 붙으면,
CDP `Page.javascriptDialogOpening` 이벤트가 **모든 세션에 브로드캐스트**된다.
먼저 도달한 세션이 `Page.handleJavaScriptDialog`를 처리하고,
나머지 세션이 시도하면 `ProtocolError: No dialog is showing` 에러가 발생한다.

**해결**: 시나리오 실행 전 항상 daemon 종료 후 진행.

---

## 올바른 dialog 처리 패턴

### connect.js 기본 handler (자동 등록)

`connect.js`의 `connect()`는 기본 `page.on('dialog', d => d.accept())` handler를 자동 등록하고
`defaultDialogHandler`를 반환한다.

```js
const { page, defaultDialogHandler } = await connect();
// 이미 기본 accept handler가 등록된 상태
```

### handler 교체 — setDialogHandler 유틸 사용 필수

`page.on('dialog')`를 추가 등록하면 **기존 handler와 모두 실행**되어 충돌한다.
반드시 `setDialogHandler`로 교체하라.

```js
const { connect, setDialogHandler } = require('../../lib/connect');

// dialog 로그 수집 recorder 패턴
function installDialogRecorder(page, prevHandler) {
  const logs = [];
  const handler = async (dialog) => {
    logs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  };
  const newHandler = setDialogHandler(page, prevHandler, handler);
  return { handler: newHandler, getLogs: () => logs.splice(0) };
}

// 사용
const { page, defaultDialogHandler } = await connect();
const recorder = installDialogRecorder(page, defaultDialogHandler);

// ... 클릭 등 동작 ...

const logs = recorder.getLogs();
console.log(logs[0]?.message); // dialog 메시지 확인

// finally에서 반드시 복원
setDialogHandler(page, recorder.handler, defaultDialogHandler);
```

### popup에서의 handler 등록

popup은 `connect.js`를 거치지 않으므로 기본 handler가 없다.
별도로 등록해야 한다 (prevHandler=null).

```js
const popup = await page.waitForEvent('popup');
// popup에는 기본 handler 없음 — 직접 등록
const popupRecorder = installDialogRecorder(popup, null);
```

### dialog 대기 — 이벤트 기반 사용

고정 `waitForTimeout` 대신 `waitForEvent('dialog')`로 이벤트 기반 대기.
팝업이 dialog 없이 바로 닫힐 수 있는 경우 `Promise.race`로 처리.

```js
// 단순 대기
const dialogPromise = page.waitForEvent('dialog', { timeout: 10000 });
await clickButton();
await dialogPromise;

// popup이 dialog 없이 바로 닫힐 수 있는 경우
const dialogP = page.waitForEvent('dialog', { timeout: 10000 }).catch(() => 'no-dialog');
const closeP = popup.waitForEvent('close', { timeout: 10000 }).catch(() => 'no-close');
await clickButton();
await Promise.race([dialogP, closeP]);
// popup close 추가 대기 (이미 닫혔어도 안전하게)
await popup.waitForEvent('close', { timeout: 10000 }).catch(() => {});
```

---

## 금지 규칙

- `window.confirm/alert` JS monkey-patch **금지** — CDP 레이어보다 늦어 실행 기회 없음
- `page.on('dialog')` 직접 추가 등록 **금지** — 기존 handler와 충돌, `setDialogHandler` 사용
- dialog handler `finally` 복원 생략 **금지**
- `process.exit(0)` 고정 종료 **금지** → `try/catch/finally + exitCode` 패턴 사용
- `kill <PID>` 단독 사용 **금지** → `kill -9` 사용
