# Flutter 웹앱 패턴

Flutter 웹앱(Canvas 렌더링)을 agent-browser로 탐색할 때의 패턴.
일반 HTML과 완전히 다르므로 이 문서를 먼저 확인한다.

## 1. Flutter 판별법

```bash
# 방법 1: 텍스트 확인 — 빈 값 또는 "로딩 중입니다"이면 Flutter 의심
agent-browser eval "document.body.innerText.substring(0,100)"

# 방법 2: flt-semantics 태그 — true이면 Flutter 확정
agent-browser eval "!!document.querySelector('flt-semantics-placeholder')"

# 방법 3: flutter_bootstrap.js 확인
agent-browser eval "!!document.querySelector('script[src*=flutter]')"
```

## 2. Accessibility 활성화 (필수)

Flutter는 Canvas로 렌더링하므로 DOM 트리가 거의 없다.
flt-semantics-placeholder를 클릭하면 접근성 트리가 생성된다.

```bash
# 방법 1: placeholder 클릭 (권장)
agent-browser eval "document.querySelector('flt-semantics-placeholder')?.click(); 'done'"

# 바로 안 보이면 짧게 대기 후 다시 확인
agent-browser wait --load networkidle
agent-browser eval "document.body.innerText.substring(0,200)"

# 방법 2: snapshot → flutter-view 클릭
agent-browser snapshot -i -c
# → [ref=e2] (flutter-view ...) 확인
agent-browser click e2
```

**핵심 주의사항:**
- **페이지 이동마다 accessibility가 리셋됨** → 매번 재활성화 필요
- 재활성화 비용: eval 1줄 (~50B) — 무시 가능
- `click e1` (Enable accessibility 버튼)은 screen reader용이라 직접 클릭으로는 작동 안 함
- placeholder 클릭 직후에도 본문 텍스트가 바로 안 풀릴 수 있음 → 짧게 대기 후 재조회
- 너무 넓은 selector(`flt-semantics` 전체 등)로 snapshot하면 strict mode 오류가 날 수 있음 → `innerText` 확인 또는 더 좁은 범위 우선

## 3. API 직접 호출 (핵심 우회 전략)

**Flutter 사이트에서 가장 효율적이고 안정적인 방법.**
UI 탐색 대비 토큰 99% 절약.

### 단계 1: API 엔드포인트 발견

```bash
agent-browser eval "performance.getEntriesByType('resource').map(function(r){return r.name}).filter(function(u){return u.includes('api') || u.includes('cgi') || u.includes('json')}).join('\n')"
```

### 단계 2: JS 번들에서 API method 추출

```bash
agent-browser eval "fetch('/ui/main.dart.js').then(function(r){return r.text()}).then(function(t){window.__apis = t.match(/\\\"[a-z][a-z0-9_]*\\/[a-z_\\/]+\\\"/gi).filter(function(v,i,a){return a.indexOf(v)===i}).sort(); window.__ready='done'}); 'parsing'"

agent-browser eval "window.__ready === 'done' ? JSON.stringify(window.__apis) : 'parsing...'"
```

### 단계 3: fetch로 직접 호출

```bash
agent-browser eval "fetch('/cgi/service.cgi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'vpncli/server/list'})}).then(function(r){return r.text()}).then(function(t){window.__result=t}); 'go'"

agent-browser eval "window.__result"
```

### 주의사항

- Promise.all로 여러 fetch를 묶으면 window 변수 타이밍 문제 → 개별 eval로 분리
- Flutter 페이지 이동 후 API 안 되면 → 관리도구 페이지에서 호출
- 세션 쿠키 확인: `eval "document.cookie"`
- 관리 화면 진입 확인은 텍스트만 보지 말고 `location.pathname` 같이 확인

### 단계 4: `Invalid params` 대응

method 이름만 찾았다고 바로 무인자 호출이 맞는 것은 아니다.
JSON-RPC 계열 Flutter 웹앱은 method마다 `params` 형식이 다를 수 있다.

```bash
# 1) 일단 method 이름을 찾는다
agent-browser eval "fetch('/ui/main.dart.js').then(function(r){return r.text()}).then(function(t){window.__apis = t.match(/\\\"[a-z][a-z0-9_]*\\/[a-z_\\/]+\\\"/gi).filter(function(v,i,a){return a.indexOf(v)===i}).sort(); window.__ready='done'}); 'parsing'"

# 2) 호출했는데 Invalid params가 나오면
agent-browser eval "fetch('/cgi/service.cgi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'some/method'})}).then(function(r){return r.text()}).then(function(t){window.__err=t}); 'go'"

agent-browser eval "window.__err"
```

에러가 `Invalid params`면 해당 method 주변 호출 문맥을 번들에서 확인한다.

```bash
agent-browser eval "fetch('/ui/main.dart.js').then(function(r){return r.text()}).then(function(t){var k='\\\"some/method\\\"'; var i=t.indexOf(k); window.__ctx = i>=0 ? t.substring(Math.max(0,i-180), Math.min(t.length,i+220)) : 'not found'}); 'go'"

agent-browser eval "window.__ctx"
```

**문맥에서 볼 것:**
- method 뒤에 같이 전달되는 문자열/상수
- 단일 문자열인지, 배열인지, 객체인지
- `null` 자리 뒤에 특정 값이 들어가는지

**핵심 원칙:**
- method 추출 = 시작점
- callsite 문맥 확인 = params shape 추론
- 한 번에 여러 가설을 넣지 말고, 단일 값 → 배열 → 객체 순으로 좁혀 확인

## 4. Flutter에서 JS fetch 가로채기가 안 되는 이유

```
시도: window.fetch를 monkey-patch하여 API 요청 body 캡처
결과: window.__log = [] (빈 배열)
원인: Flutter는 Dart HttpClient를 사용 — JS window.fetch를 우회
결론: dart.js에서 method를 추출하여 직접 호출하는 것이 정답
```

## 5. Flutter 페이지 URL 라우팅 특성

```
/ui/           → Flutter 앱 진입점
/ui/index.html → 동일
/ui/#vpn       → 해시 라우팅 안 먹힘 (Flutter가 자체 라우팅)

결론: URL로 직접 페이지 이동 불가 — 메뉴 클릭 or API 직접 호출만 가능
```
