/* ============================================================
   予約導線つきAI診断LPビルダー — MVP
   vanilla JS + localStorage（バックエンド不要）
   要件定義書 ai_diagnosis_lp_builder_requirements.md に準拠
   ============================================================ */

const TYPE_KEYS = ['A', 'B', 'C', 'D', 'E'];
const STORE_KEY = 'aidx_diagnoses_v1';
const EVENT_KEY = 'aidx_events_v1';

/* ---------------- utilities ---------------- */
const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9);
const $ = (sel, el = document) => el.querySelector(sel);
const nowISO = () => new Date().toISOString();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// スラッグはURL共有で壊れないようASCIIのみ。日本語タイトル等は短いランダムIDにフォールバック。
const slugify = (s) => {
  const base = (s || '').toString().trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || ('d-' + Math.random().toString(36).slice(2, 7));
};

function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1900);
}

/* ---------------- data layer（サーバAPI） ---------------- */
async function apiJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : null;
}
const api = {
  list: () => apiJSON('/api/diagnoses'),
  get: (id) => apiJSON('/api/diagnoses/' + id),
  getPublic: (slug) => apiJSON('/api/public/' + encodeURIComponent(slug)),
  stats: (id) => apiJSON('/api/stats/' + id),
  create: (d) => apiJSON('/api/diagnoses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }),
  update: (d) => apiJSON('/api/diagnoses/' + d.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }),
  remove: (id) => apiJSON('/api/diagnoses/' + id, { method: 'DELETE' }),
  logEvent: (diagnosisId, type, extra = {}) =>
    fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ diagnosisId, type, source: extra.source || 'direct', resultKey: extra.resultKey || null }) }).catch(() => {}),
};
function logEvent(diagnosisId, type, extra = {}) { api.logEvent(diagnosisId, type, extra); }

/* ---------------- factory ---------------- */
function emptyResultType(key) {
  return {
    key, name: '', priority: TYPE_KEYS.indexOf(key) + 1, summary: '', description: '',
    mistake: '', risk: '', solution: '', service: '', recommendedMenu: '', ctaText: '予約する', ctaUrl: ''
  };
}
function emptyChoice(keys) {
  const scores = {}; keys.forEach(k => scores[k] = 0);
  return { id: uid('c'), text: '', scores };
}
function emptyQuestion(keys) {
  return { id: uid('q'), text: '', choices: [emptyChoice(keys), emptyChoice(keys)] };
}
function newDiagnosis() {
  const keys = ['A', 'B', 'C', 'D'];
  return {
    id: uid('d'), title: '', description: '', slug: '', status: 'draft',
    topCopy: '', lineMessage: '', sourceDefault: 'line', reserveUrl: '',
    keys, resultTypes: keys.map(emptyResultType),
    questions: [emptyQuestion(keys)],
    createdAt: nowISO(), updatedAt: nowISO()
  };
}

/* ============================================================
   ローカルAI下書きジェネレーター
   （外部API無しで、入力からテンプレ合成で下書きを生成）
   ============================================================ */
function generateDraft(input) {
  const {
    industry, target, problem, menu, goal, theme, reserveUrl,
    qCount = 7, typeCount = 4, tone = '', shopName = '', campaign = '', firstPrice = ''
  } = input;
  const n = Math.max(3, Math.min(10, Number(qCount) || 7));
  const tc = Math.max(3, Math.min(5, Number(typeCount) || 4));
  const keys = TYPE_KEYS.slice(0, tc);
  const shop = shopName || '当院';

  // 結果タイプの「原因軸」をテーマから推定（汎用フォールバック付き）
  const axisLibrary = [
    { name: '生活習慣の乱れタイプ', mistake: '一時的な対処だけで済ませてしまうこと', risk: '根本原因が残り、同じ状態を繰り返しやすくなる可能性があります。', solution: '生活リズム全体を見直し、無理なく続けられる習慣に整えていくことが大切です。', menuSuffix: '生活習慣チェック付き' },
    { name: '自己流ケアの限界タイプ', mistake: '正しい方法か確認しないまま自己流で続けること', risk: 'ズレたケアを続けることで、改善が遠回りになる場合があります。', solution: 'まず現状を客観的に確認し、あなたに合った方法に調整することが必要です。', menuSuffix: '状態チェック付き' },
    { name: '原因の見落としタイプ', mistake: '表面的な症状だけに対処してしまうこと', risk: '本当の原因に気づかないまま時間が経つ可能性があります。', solution: '本来の原因を一度プロと確認し、優先順位をつけて取り組むことが近道です。', menuSuffix: '原因分析付き' },
    { name: '蓄積疲労タイプ', mistake: '頑張りすぎて休めていないこと', risk: '負担が蓄積し、回復しにくい状態が続く場合があります。', solution: '負担の元を見極めながら、回復を優先したケア設計が必要です。', menuSuffix: 'コンディション確認付き' },
    { name: '通い方ミスマッチタイプ', mistake: '間隔やペースが今の状態に合っていないこと', risk: '効果が安定せず、戻りやすくなる可能性があります。', solution: '今の状態に合った頻度・プランに見直すことが改善の近道です。', menuSuffix: '改善計画相談付き' },
  ];

  const resultTypes = keys.map((k, i) => {
    const ax = axisLibrary[i % axisLibrary.length];
    return {
      key: k,
      name: ax.name,
      priority: i + 1,
      summary: `${target || 'あなた'}に多い「${ax.name}」。${problem || 'お悩み'}の背景に、このタイプ特有の傾向が見られます。`,
      description: `${ax.name}は、${industry || 'この分野'}でよく見られる傾向です。${problem ? '「' + problem + '」' : ''}と感じている方に当てはまりやすいタイプです。`,
      mistake: ax.mistake,
      risk: ax.risk,
      solution: ax.solution,
      service: `${shop}では、${ax.menuSuffix}のカウンセリングで現在の状態を丁寧に確認し、あなたに合った提案を行います。個人差があるため、まず初回で詳しく確認します。`,
      recommendedMenu: `${ax.menuSuffix}${menu || 'カウンセリング'}`,
      ctaText: campaign ? `${campaign}を予約する` : `${ax.menuSuffix}カウンセリングを予約する`,
      ctaUrl: reserveUrl || ''
    };
  });

  // 質問テンプレ（汎用・自分ごと化しやすい設問）
  const qTemplates = [
    `${problem || 'この悩み'}を感じることが最近増えていますか？`,
    'これまで自己流でいろいろ試してきましたか？',
    '改善しても、しばらくすると元に戻ってしまうことが多いですか？',
    '忙しくて、自分のケアを後回しにしがちですか？',
    '何が本当の原因なのか、はっきり分からないと感じますか？',
    '生活リズム（睡眠・食事・運動）が不規則になりがちですか？',
    '同じ悩みを長い間ずっと抱えていますか？',
    '人に相談したり専門家に診てもらった経験は少ないですか？',
    '今の状態を「このままではまずい」と感じることがありますか？',
    `${menu || 'プロのサポート'}を受けてみたいと思ったことがありますか？`,
  ];
  const choiceLabels = ['かなり当てはまる', '少し当てはまる', 'あまり当てはまらない', '当てはまらない'];

  const questions = [];
  for (let qi = 0; qi < n; qi++) {
    const text = qTemplates[qi % qTemplates.length];
    const lead = qi % keys.length; // この設問で点を集めやすいタイプ
    const choices = choiceLabels.map((label, ci) => {
      const scores = {};
      const weight = choiceLabels.length - ci; // 当てはまるほど高得点
      keys.forEach((k, ki) => {
        let s = 0;
        if (ki === lead) s = weight;                 // 主軸タイプ
        else if (ki === (lead + 1) % keys.length) s = Math.max(0, weight - 2); // 副軸
        else s = Math.max(0, weight - 3);
        scores[k] = s;
      });
      return { id: uid('c'), text: label, scores };
    });
    questions.push({ id: uid('q'), text, choices });
  }

  const facts = `${n}問・約${Math.max(1, Math.round(n * 0.3))}分`;
  const topCopy = `${problem ? problem + '。\n' : ''}そのお悩み、原因は一つではないかもしれません。\n\n${n}問の質問に答えるだけで、${target || 'あなた'}に多い「${theme || '原因タイプ'}」をチェックできます。${firstPrice ? '\n\n初回特別価格：' + firstPrice : ''}`;

  return {
    title: theme || `${industry || ''}の原因タイプ診断`.trim(),
    description: `${target || 'あなた'}がなぜ${problem || '改善しにくいのか'}を、${n}問でチェックします。`,
    lineMessage: `【無料診断】${problem || 'そのお悩み'}の原因タイプを${n}問でチェックできます。\nあなたに合った改善のヒントが見つかります。\n▼今すぐ診断する\n（診断は${facts}）`,
    topCopy,
    keys,
    resultTypes,
    questions,
    reserveUrl: reserveUrl || ''
  };
}

/* ============================================================
   プリセット：30代から痩せない原因診断（要件 §23 ダイエット版）
   ============================================================ */
function presetDiet() {
  const keys = ['A', 'B', 'C', 'D'];
  const reserveUrl = 'https://example.com/reserve';
  const rt = (key, name, priority, fields) => ({
    key, name, priority, ctaUrl: reserveUrl, ...fields
  });
  const resultTypes = [
    rt('A', '食事制限しすぎタイプ', 3, {
      summary: '食事量を減らしすぎて、代謝が落ちやすくなっているタイプです。',
      description: '頑張って食事を減らしているのに痩せにくい——その背景に、必要な栄養まで不足し代謝が下がっている可能性があります。',
      mistake: 'さらに食事を減らそうとすること',
      risk: '筋肉量や代謝が落ち、リバウンドしやすくなる可能性があります。',
      solution: 'まずは必要な栄養を摂りながら、代謝を落とさない食事設計が必要です。個人差があるため、初回で詳しく確認します。',
      service: '当院では、栄養状態を確認しながら、あなたに合った食事の摂り方を一緒に整えていきます。',
      recommendedMenu: '栄養状態チェック付きダイエットカウンセリング',
      ctaText: '栄養状態チェックを予約する',
    }),
    rt('B', '血糖値乱れタイプ', 2, {
      summary: '食べ方や順番によって、血糖値が乱れやすくなっている傾向のタイプです。',
      description: '食事の量より「食べ方」に改善の余地があるタイプ。間食や早食いが習慣になっていませんか。',
      mistake: '量だけ気にして、食べ方・順番を見直さないこと',
      risk: '脂肪を溜め込みやすい状態が続く可能性があります。',
      solution: '食べる順番やタイミングを整えることで、無理なく変化を目指せます。',
      service: '当院では、食事習慣を丁寧にヒアリングし、続けやすい改善ポイントを提案します。',
      recommendedMenu: '食事習慣チェック付きダイエットカウンセリング',
      ctaText: '食事習慣チェックを予約する',
    }),
    rt('C', '代謝低下タイプ', 1, {
      summary: '筋肉量の低下などで、基礎代謝が落ちやすくなっているタイプです。',
      description: '昔より落ちにくくなった、という方に多いタイプ。代謝そのものを底上げする視点が大切です。',
      mistake: '食事制限だけで何とかしようとすること',
      risk: '代謝が下がったまま、痩せにくい状態が続く可能性があります。',
      solution: '代謝や筋肉量の状態を確認し、それに合わせたアプローチが必要です。',
      service: '当院では、代謝・筋肉量の状態を確認しながら、あなたに合った方法をご提案します。',
      recommendedMenu: '代謝・筋肉量チェック付きカウンセリング',
      ctaText: '代謝・筋肉量チェックを予約する',
    }),
    rt('D', '生活習慣崩れタイプ', 4, {
      summary: '睡眠・運動・生活リズムの乱れが、痩せにくさに影響しているタイプです。',
      description: '頑張りどころが食事ではなく生活リズム側にあるタイプ。土台を整えると変化が出やすくなります。',
      mistake: '生活リズムを後回しにしてしまうこと',
      risk: '土台が整わず、努力が結果に繋がりにくい状態が続く可能性があります。',
      solution: 'まず生活リズムを無理なく整えることが、改善への近道です。',
      service: '当院では、生活リズムを確認しながら、続けられる改善プランを一緒に作ります。',
      recommendedMenu: '生活リズム改善カウンセリング',
      ctaText: '生活リズム改善を相談する',
    }),
  ];

  // 7問。各設問で主軸タイプにスコアを集める設計。
  const Q = (text, leadIndex) => {
    const labels = ['かなり当てはまる', '少し当てはまる', 'あまり当てはまらない', '当てはまらない'];
    const choices = labels.map((label, ci) => {
      const w = labels.length - ci;
      const scores = {};
      keys.forEach((k, ki) => {
        if (ki === leadIndex) scores[k] = w;
        else if (ki === (leadIndex + 2) % keys.length) scores[k] = Math.max(0, w - 2);
        else scores[k] = Math.max(0, w - 3);
      });
      return { id: uid('c'), text: label, scores };
    });
    return { id: uid('q'), text, choices };
  };
  const questions = [
    Q('食事量を減らしているのに痩せにくいと感じますか？', 0),
    Q('間食や甘いものを、つい食べてしまうことが多いですか？', 1),
    Q('昔に比べて、体重が落ちにくくなったと感じますか？', 2),
    Q('運動する習慣がほとんどありませんか？', 3),
    Q('睡眠時間が不規則、または足りていないと感じますか？', 3),
    Q('栄養バランスより「量を減らすこと」を意識しがちですか？', 0),
    Q('食事の時間がバラバラになりがちですか？', 1),
  ];

  return {
    id: uid('d'),
    title: '30代から痩せない原因診断',
    description: 'あなたがなぜ痩せにくくなっているのかを7問でチェックします。',
    slug: 'diet-30',
    status: 'published',
    topCopy: '食べていないのに痩せない。\n運動しても体型が変わらない。\n昔より落ちにくくなった。\n\nその原因は、単なる食べすぎではないかもしれません。\n\n7問で、あなたの痩せにくい原因タイプをチェックできます。',
    lineMessage: '食べていないのに痩せない方へ。7問であなたの痩せにくい原因タイプをチェックできます。\n▼今すぐ診断する',
    sourceDefault: 'line',
    reserveUrl,
    keys, resultTypes, questions,
    createdAt: nowISO(), updatedAt: nowISO()
  };
}

async function seedIfEmpty() {
  try {
    const list = await api.list();
    if (Array.isArray(list) && list.length === 0) {
      await api.create(presetDiet());
    }
  } catch (e) { /* サーバ未起動時は無視 */ }
}

/* ============================================================
   採点ロジック（点数型タイプ診断・同点は priority 昇順）
   ============================================================ */
function scoreDiagnosis(diag, answers) {
  const totals = {}; diag.keys.forEach(k => totals[k] = 0);
  diag.questions.forEach(q => {
    const ci = answers[q.id];
    if (ci == null) return;
    const choice = q.choices[ci];
    if (!choice) return;
    diag.keys.forEach(k => { totals[k] += Number(choice.scores[k] || 0); });
  });
  let best = null;
  diag.resultTypes.forEach(rt => {
    const score = totals[rt.key] || 0;
    if (!best || score > best.score || (score === best.score && rt.priority < best.rt.priority)) {
      best = { rt, score };
    }
  });
  return { totals, winner: best ? best.rt : diag.resultTypes[0] };
}

/* ============================================================
   ルーター
   ============================================================ */
function parseHash() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const [pathPart, queryPart] = h.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  const params = {};
  if (queryPart) queryPart.split('&').forEach(kv => { const [k, v] = kv.split('='); params[k] = decodeURIComponent(v || ''); });
  return { parts, params };
}
function navigate(hash) { location.hash = hash; }

async function render() {
  const { parts, params } = parseHash();
  const root = $('#root');
  const header = $('#app-header');
  // 公開ページではヘッダーを隠す（受診者向け）
  const isPublic = parts[0] === 'd';
  header.style.display = isPublic ? 'none' : 'flex';
  document.body.style.background = isPublic ? '#eef1f6' : 'var(--bg)';

  if (parts.length === 0) return viewList(root);
  switch (parts[0]) {
    case 'new': return viewEditor(root, null);
    case 'edit': return viewEditor(root, parts[1]);
    case 'analytics': return viewAnalytics(root, parts[1]);
    case 'generate': return viewGenerate(root);
    case 'd': return viewPublic(root, parts[1], parts[2], params);
    default: return viewList(root);
  }
}

/* ============================================================
   管理：診断一覧
   ============================================================ */
function publicUrl(slug, source) {
  const base = location.origin + location.pathname + '#/d/' + slug;
  return source ? base + '?source=' + source : base;
}

async function viewList(root) {
  root.innerHTML = `<div class="wrap"><p class="subtle">読み込み中…</p></div>`;
  let list;
  try { list = await api.list(); }
  catch (e) {
    root.innerHTML = `<div class="wrap"><div class="empty card"><div class="big">⚠️</div>
      <p>サーバに接続できませんでした。<br><code>python3 server.py</code> を起動してから <code>http://localhost:4173/</code> を開いてください。</p></div></div>`;
    return;
  }
  root.innerHTML = `
    <div class="wrap">
      <div class="page-title">
        <h1>診断一覧</h1>
        <div class="spacer"></div>
        <a class="btn" href="#/generate">✨ AIで作成</a>
        <a class="btn primary" href="#/new">＋ 新規作成</a>
      </div>
      ${list.length === 0 ? `
        <div class="empty card">
          <div class="big">🩺</div>
          <p>まだ診断がありません。<br>「AIで作成」で下書きを生成するか、新規作成しましょう。</p>
        </div>` : `<div class="dlist">${list.map(cardHtml).join('')}</div>`}
    </div>`;
}

function cardHtml(d) {
  const s = d.stats || { start: 0, complete: 0, cta: 0, compRate: 0, ctaRate: 0 };
  const url = publicUrl(d.slug);
  const lineUrl = publicUrl(d.slug, 'line');
  return `
    <div class="card dcard">
      <div>
        <span class="badge ${d.status === 'published' ? 'published' : 'draft'}">${d.status === 'published' ? '● 公開中' : '下書き'}</span>
        <h3 style="margin-top:8px">${esc(d.title || '(無題の診断)')}</h3>
        <div class="meta">${esc(d.description || '')}</div>
        <div class="kpis">
          <div class="kpi"><div class="n">${s.start}</div><div class="l">開始</div></div>
          <div class="kpi"><div class="n">${s.complete}</div><div class="l">完了</div></div>
          <div class="kpi"><div class="n">${s.compRate}%</div><div class="l">完了率</div></div>
          <div class="kpi"><div class="n">${s.cta}</div><div class="l">予約クリック</div></div>
          <div class="kpi"><div class="n">${s.ctaRate}%</div><div class="l">予約率</div></div>
        </div>
        <div class="url-row">
          <input type="text" readonly value="${esc(lineUrl)}" onclick="this.select()">
          <button class="btn sm" data-copy="${esc(lineUrl)}">LINE用URLをコピー</button>
        </div>
      </div>
      <div class="actions">
        <a class="btn primary" href="#/d/${esc(d.slug)}?source=manual" target="_blank">▶ 診断を開く</a>
        <a class="btn" href="#/edit/${d.id}">編集</a>
        <a class="btn" href="#/analytics/${d.id}">分析</a>
        <button class="btn" data-action="toggle" data-id="${d.id}">${d.status === 'published' ? '非公開にする' : '公開する'}</button>
        <button class="btn" data-action="dup" data-id="${d.id}">複製</button>
        <button class="btn danger" data-action="del" data-id="${d.id}">削除</button>
      </div>
    </div>`;
}

/* ============================================================
   管理：診断作成・編集
   ============================================================ */
let editState = null; // 編集中の診断オブジェクト
let editTab = 'basic';

async function viewEditor(root, id) {
  if (id) {
    let d;
    try { d = await api.get(id); } catch (e) { navigate('#/'); return; }
    if (!d) { navigate('#/'); return; }
    editState = JSON.parse(JSON.stringify(d));
  } else if (!editState || editState._fresh !== true) {
    editState = newDiagnosis(); editState._fresh = true;
  }
  if (!editState.keys) editState.keys = ['A', 'B', 'C', 'D'];
  paintEditor(root);
}

function paintEditor(root) {
  const d = editState;
  root.innerHTML = `
    <div class="wrap">
      <div class="page-title">
        <a class="btn ghost" href="#/">← 一覧</a>
        <h1>${d._fresh ? '診断を新規作成' : '診断を編集'}</h1>
        <div class="spacer"></div>
        <a class="btn" href="#/d/__preview__?source=preview" data-action="preview">▶ プレビュー</a>
        <button class="btn primary" data-action="save">保存</button>
      </div>
      <div class="tabs" id="tabs">
        <button data-tab="basic" class="${editTab==='basic'?'active':''}">基本情報</button>
        <button data-tab="questions" class="${editTab==='questions'?'active':''}">質問・スコア（${d.questions.length}）</button>
        <button data-tab="results" class="${editTab==='results'?'active':''}">結果タイプ（${d.resultTypes.length}）</button>
        <button data-tab="publish" class="${editTab==='publish'?'active':''}">公開・配信</button>
      </div>
      <div id="tab-body"></div>
    </div>`;
  paintTab();
}

function paintTab() {
  const body = $('#tab-body'); const d = editState;
  if (editTab === 'basic') body.innerHTML = tabBasic(d);
  else if (editTab === 'questions') body.innerHTML = tabQuestions(d);
  else if (editTab === 'results') body.innerHTML = tabResults(d);
  else if (editTab === 'publish') body.innerHTML = tabPublish(d);
}

function tabBasic(d) {
  return `<div class="card pad">
    <div class="field"><label>診断タイトル</label>
      <input type="text" data-field="title" value="${esc(d.title)}" placeholder="例：30代から痩せない原因診断"></div>
    <div class="field"><label>診断説明文</label>
      <textarea data-field="description" placeholder="例：あなたがなぜ痩せにくいのかを7問でチェックします。">${esc(d.description)}</textarea></div>
    <div class="field"><label>診断トップページ文章 <span class="hint">受診者が最初に見る導入文（離脱防止）</span></label>
      <textarea data-field="topCopy" style="min-height:130px">${esc(d.topCopy)}</textarea></div>
    <div class="two-col">
      <div class="field"><label>公開URL用スラッグ</label>
        <input type="text" data-field="slug" value="${esc(d.slug)}" placeholder="diet-30"></div>
      <div class="field"><label>予約URL（既存の予約ページ）</label>
        <input type="url" data-field="reserveUrl" value="${esc(d.reserveUrl||'')}" placeholder="https://example.com/reserve"></div>
    </div>
  </div>`;
}

function tabQuestions(d) {
  return `<div class="flash-note">各回答に <b>タイプ別スコア</b>（${d.keys.join('/')}）を設定します。合計点が最も高いタイプが結果になります。</div>
  ${d.questions.map((q, qi) => questionBlock(d, q, qi)).join('')}
  <button class="btn" data-action="add-question">＋ 質問を追加</button>`;
}

function questionBlock(d, q, qi) {
  const head = `<div class="score-row" style="margin-bottom:6px">
      <div class="score-head" style="text-align:left">選択肢テキスト</div>
      ${d.keys.map(k => `<div class="score-head">${k}</div>`).join('')}
      <div></div></div>`;
  return `<div class="section-block" data-q="${q.id}">
    <div class="sb-head">
      <span class="qnum">${qi+1}</span>
      <input type="text" data-qfield="text" data-q="${q.id}" value="${esc(q.text)}" placeholder="質問文を入力">
      <button class="btn ghost sm" data-action="del-question" data-q="${q.id}" title="質問を削除">✕</button>
    </div>
    ${head}
    ${q.choices.map((c, ci) => `
      <div class="score-row" style="margin-bottom:8px">
        <input type="text" data-cfield="text" data-q="${q.id}" data-c="${c.id}" value="${esc(c.text)}" placeholder="選択肢">
        ${d.keys.map(k => `<div class="sc"><input type="number" min="0" data-score="${k}" data-q="${q.id}" data-c="${c.id}" value="${Number(c.scores[k]||0)}"></div>`).join('')}
        <button class="btn ghost sm" data-action="del-choice" data-q="${q.id}" data-c="${c.id}">✕</button>
      </div>`).join('')}
    <button class="btn sm" data-action="add-choice" data-q="${q.id}">＋ 選択肢</button>
  </div>`;
}

function tabResults(d) {
  return `<div class="flash-note">結果ページの本文と、<b>結果タイプ別の予約CTA</b>を設定します。同点時は優先順位（数字が小さいほど優先）で決まります。</div>
  ${d.resultTypes.map(rt => resultBlock(rt)).join('')}`;
}
function resultBlock(rt) {
  const f = (field, label, ph, ta) => ta
    ? `<div class="field"><label>${label}</label><textarea data-rfield="${field}" data-k="${rt.key}" placeholder="${ph}">${esc(rt[field]||'')}</textarea></div>`
    : `<div class="field"><label>${label}</label><input type="text" data-rfield="${field}" data-k="${rt.key}" value="${esc(rt[field]||'')}" placeholder="${ph}"></div>`;
  return `<div class="section-block">
    <div class="sb-head">
      <span class="qnum">${rt.key}</span>
      <input type="text" data-rfield="name" data-k="${rt.key}" value="${esc(rt.name)}" placeholder="タイプ名（例：代謝低下タイプ）">
      <div style="width:130px"><label class="subtle" style="font-size:11px">優先順位</label>
        <input type="number" min="1" data-rfield="priority" data-k="${rt.key}" value="${Number(rt.priority||1)}"></div>
    </div>
    ${f('summary','一言サマリー','このタイプの要約')}
    ${f('description','① このタイプの特徴 / なぜ改善しなかったのか','特徴の説明', true)}
    ${f('mistake','② よくある間違い','例：さらに食事を減らそうとすること', true)}
    ${f('risk','③ このまま放置するとどうなるか','例：〜の可能性があります', true)}
    ${f('solution','④ 本来必要な改善方法','例：まず〜が必要です', true)}
    ${f('service','⑤ 当院でできること','例：当院では〜', true)}
    <div class="two-col">
      ${f('recommendedMenu','おすすめ予約メニュー','例：栄養状態チェック付きカウンセリング')}
      ${f('ctaText','予約CTAボタン文言','例：栄養状態チェックを予約する')}
    </div>
    ${f('ctaUrl','予約URL（空欄なら基本予約URLを使用）','https://example.com/reserve')}
  </div>`;
}

function tabPublish(d) {
  const slug = d.slug || '(スラッグ未設定)';
  const pub = publicUrl(slug);
  const sources = ['line', 'instagram', 'ad', 'manual'];
  return `<div class="card pad">
    <div class="field"><label>公開ステータス</label>
      <select data-field="status">
        <option value="draft" ${d.status==='draft'?'selected':''}>下書き（非公開）</option>
        <option value="published" ${d.status==='published'?'selected':''}>公開</option>
      </select></div>
    <div class="field"><label>LINE配信用 紹介文</label>
      <textarea data-field="lineMessage" style="min-height:120px" placeholder="LINEで配信する紹介文">${esc(d.lineMessage||'')}</textarea></div>
    <hr class="muted-divider">
    <h4 style="margin:0 0 10px">配信用URL</h4>
    <p class="subtle" style="margin-top:0">流入元（source）別にURLを発行できます。クリック計測に使われます。</p>
    ${sources.map(s => `
      <div class="url-row">
        <span class="pill" style="min-width:84px;text-align:center">${s}</span>
        <input type="text" readonly value="${esc(publicUrl(slug, s))}" onclick="this.select()">
        <button class="btn sm" data-copy="${esc(publicUrl(slug, s))}">コピー</button>
      </div>`).join('')}
    <div class="url-row">
      <span class="pill" style="min-width:84px;text-align:center">公開</span>
      <input type="text" readonly value="${esc(pub)}" onclick="this.select()">
      <button class="btn sm" data-copy="${esc(pub)}">コピー</button>
    </div>
  </div>`;
}

/* ---- editor event wiring (delegation) ---- */
function commitField(target) {
  const d = editState; if (!d) return;
  const val = target.value;
  if (target.dataset.field) {
    d[target.dataset.field] = val;
    if (target.dataset.field === 'title' && !d._slugTouched && d._fresh) {
      // タイトルからスラッグ自動生成（基本タブの slug 入力には反映しない簡易版）
    }
  } else if (target.dataset.qfield) {
    const q = d.questions.find(x => x.id === target.dataset.q); if (q) q[target.dataset.qfield] = val;
  } else if (target.dataset.cfield) {
    const q = d.questions.find(x => x.id === target.dataset.q);
    const c = q && q.choices.find(x => x.id === target.dataset.c); if (c) c[target.dataset.cfield] = val;
  } else if (target.dataset.score) {
    const q = d.questions.find(x => x.id === target.dataset.q);
    const c = q && q.choices.find(x => x.id === target.dataset.c);
    if (c) c.scores[target.dataset.score] = Number(val || 0);
  } else if (target.dataset.rfield) {
    const rt = d.resultTypes.find(x => x.key === target.dataset.k);
    if (rt) rt[target.dataset.rfield] = target.dataset.rfield === 'priority' ? Number(val || 1) : val;
  }
}

async function saveEditor() {
  const d = editState;
  if (!d.title.trim()) { editTab = 'basic'; paintEditor($('#root')); toast('診断タイトルを入力してください'); return; }
  // スラッグ生成と重複回避はサーバ側で実施
  const isNew = d._fresh === true;
  const payload = JSON.parse(JSON.stringify(d)); delete payload._fresh;
  try {
    const saved = isNew ? await api.create(payload) : await api.update(payload);
    editState = saved; editState._fresh = false;
    toast('保存しました');
    navigate('#/');
  } catch (e) {
    toast('保存に失敗しました（サーバ未起動の可能性）');
  }
}

/* ============================================================
   AI生成画面
   ============================================================ */
function viewGenerate(root) {
  root.innerHTML = `
    <div class="wrap">
      <div class="page-title">
        <a class="btn ghost" href="#/">← 一覧</a>
        <h1>✨ AIで診断の下書きを生成</h1>
      </div>
      <div class="flash-note">最低限の情報を入力すると、タイトル・質問・選択肢・スコア・結果タイプ・予約CTAの<b>下書き</b>を自動生成します。生成後に管理画面で確認・編集してから公開できます。</div>
      <div class="card pad">
        <h4 style="margin-top:0">必須入力</h4>
        <div class="two-col">
          <div class="field"><label>業種</label><input type="text" id="g-industry" placeholder="例：ダイエット整体"></div>
          <div class="field"><label>ターゲット</label><input type="text" id="g-target" placeholder="例：30〜40代女性"></div>
        </div>
        <div class="field"><label>見込み客の悩み</label><input type="text" id="g-problem" placeholder="例：食べてないのに痩せない"></div>
        <div class="two-col">
          <div class="field"><label>売りたいメニュー</label><input type="text" id="g-menu" placeholder="例：初回ダイエットカウンセリング"></div>
          <div class="field"><label>予約に繋げたいゴール</label><input type="text" id="g-goal" placeholder="例：予約を増やしたい"></div>
        </div>
        <div class="field"><label>診断テーマ</label><input type="text" id="g-theme" placeholder="例：30代から痩せない原因診断"></div>
        <div class="field"><label>予約URL</label><input type="url" id="g-reserve" placeholder="https://example.com/reserve"></div>
        <hr class="muted-divider">
        <h4>任意入力</h4>
        <div class="three-col">
          <div class="field"><label>質問数</label><input type="number" id="g-qcount" value="7" min="3" max="10"></div>
          <div class="field"><label>結果タイプ数</label><input type="number" id="g-typecount" value="4" min="3" max="5"></div>
          <div class="field"><label>店舗名</label><input type="text" id="g-shop" placeholder="例：〇〇整体院"></div>
        </div>
        <div class="three-col">
          <div class="field"><label>診断の雰囲気</label><input type="text" id="g-tone" placeholder="例：納得感重視"></div>
          <div class="field"><label>キャンペーン内容</label><input type="text" id="g-campaign" placeholder="例：初回限定枠"></div>
          <div class="field"><label>初回価格</label><input type="text" id="g-price" placeholder="例：2,980円"></div>
        </div>
        <button class="btn primary block" id="g-run" style="margin-top:8px">✨ 診断を生成する</button>
      </div>
    </div>`;

  $('#g-run').addEventListener('click', () => {
    const v = id => ($('#' + id) || {}).value || '';
    const input = {
      industry: v('g-industry'), target: v('g-target'), problem: v('g-problem'),
      menu: v('g-menu'), goal: v('g-goal'), theme: v('g-theme'), reserveUrl: v('g-reserve'),
      qCount: v('g-qcount'), typeCount: v('g-typecount'), shopName: v('g-shop'),
      tone: v('g-tone'), campaign: v('g-campaign'), firstPrice: v('g-price')
    };
    if (!input.industry && !input.theme && !input.problem) { toast('業種・悩み・テーマのいずれかを入力してください'); return; }
    const btn = $('#g-run'); btn.disabled = true; btn.textContent = '生成中…';
    setTimeout(() => {
      const draft = generateDraft(input);
      const d = newDiagnosis();
      Object.assign(d, {
        title: draft.title, description: draft.description, topCopy: draft.topCopy,
        lineMessage: draft.lineMessage, reserveUrl: draft.reserveUrl, keys: draft.keys,
        resultTypes: draft.resultTypes.map(r => ({ ...emptyResultType(r.key), ...r })),
        questions: draft.questions, status: 'draft'
      });
      editState = d; editState._fresh = true; editTab = 'basic';
      toast('下書きを生成しました。内容を確認・編集してください');
      navigate('#/new');
    }, 450);
  });
}

/* ============================================================
   分析画面
   ============================================================ */
async function viewAnalytics(root, id) {
  let d, s;
  try { d = await api.get(id); s = await api.stats(id); } catch (e) { navigate('#/'); return; }
  if (!d) { navigate('#/'); return; }
  // 結果タイプ別人数（全タイプを0で初期化してサーバ集計を反映）
  const byType = {}; d.resultTypes.forEach(rt => byType[rt.key] = 0);
  Object.entries(s.byType || {}).forEach(([k, v]) => { byType[k] = v; });
  const maxType = Math.max(1, ...Object.values(byType));
  // 流入元別クリック
  const bySource = s.bySource || {};
  const maxSrc = Math.max(1, ...Object.values(bySource));

  root.innerHTML = `
    <div class="wrap">
      <div class="page-title">
        <a class="btn ghost" href="#/">← 一覧</a>
        <h1>分析：${esc(d.title)}</h1>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="n">${s.start}</div><div class="l">診断開始数</div></div>
        <div class="stat"><div class="n">${s.complete}</div><div class="l">診断完了数</div><div class="sub">完了率 ${s.compRate}%</div></div>
        <div class="stat"><div class="n">${s.cta}</div><div class="l">予約クリック数</div></div>
        <div class="stat"><div class="n">${s.ctaRate}%</div><div class="l">予約クリック率</div></div>
      </div>

      <div class="card pad" style="margin-bottom:16px">
        <h4 style="margin-top:0">結果タイプ別 人数</h4>
        <div class="bar-list">
          ${d.resultTypes.map(rt => {
            const v = byType[rt.key] || 0;
            return `<div class="row"><div class="nm">${rt.key}：${esc(rt.name||'')}</div>
              <div class="track"><i style="width:${v/maxType*100}%"></i></div>
              <div class="v">${v}人</div></div>`;
          }).join('')}
        </div>
      </div>

      <div class="card pad">
        <h4 style="margin-top:0">流入元別 予約クリック数</h4>
        ${Object.keys(bySource).length === 0 ? `<p class="subtle">まだ予約クリックがありません。</p>` : `
        <div class="bar-list">
          ${Object.entries(bySource).map(([src, v]) =>
            `<div class="row"><div class="nm">${esc(src)}</div>
              <div class="track"><i style="width:${v/maxSrc*100}%"></i></div>
              <div class="v">${v}回</div></div>`).join('')}
        </div>`}
      </div>

      <p class="subtle" style="margin-top:18px">※ 計測データはこのブラウザのローカルに保存されています（MVP）。診断を実際に開いて回答・予約クリックすると数値が増えます。</p>
    </div>`;
}

/* ============================================================
   公開（受診者向け）ページ：トップ → 質問 → 結果
   ============================================================ */
let pubState = null;

async function viewPublic(root, slug, sub, params) {
  let diag;
  if (slug === '__preview__') {
    diag = editState ? JSON.parse(JSON.stringify(editState)) : null;
    if (!diag) { root.innerHTML = '<div class="wrap"><p>プレビュー対象がありません。</p></div>'; return; }
  } else {
    root.innerHTML = `<div class="pub"><div class="pub-inner"><p class="subtle">読み込み中…</p></div></div>`;
    try {
      diag = await api.getPublic(slug);
    } catch (e) {
      if (e.status === 403) {
        root.innerHTML = `<div class="pub"><div class="pub-inner empty"><div class="big">🔒</div><p>この診断は現在公開されていません。</p></div></div>`;
      } else {
        root.innerHTML = `<div class="pub"><div class="pub-inner empty"><div class="big">🔍</div><p>診断が見つかりませんでした。</p></div></div>`;
      }
      return;
    }
  }
  if (!diag) {
    root.innerHTML = `<div class="pub"><div class="pub-inner empty"><div class="big">🔍</div><p>診断が見つかりませんでした。</p></div></div>`;
    return;
  }
  const source = params.source || diag.sourceDefault || 'direct';
  const isPreview = slug === '__preview__';

  if (!pubState || pubState.diagId !== diag.id) {
    pubState = { diagId: diag.id, diag, source, isPreview, stage: 'top', qIndex: 0, answers: {}, started: false };
  }
  pubState.diag = diag;
  pubState.source = source;
  pubState.isPreview = isPreview;
  paintPublic(root);
}

function paintPublic(root) {
  const st = pubState; const d = st.diag;
  if (st.stage === 'top') return paintPubTop(root);
  if (st.stage === 'q') return paintPubQuestion(root);
  if (st.stage === 'result') return paintPubResult(root);
}

function paintPubTop(root) {
  const d = pubState.diag;
  const minutes = Math.max(1, Math.round(d.questions.length * 0.3));
  root.innerHTML = `
    <div class="pub"><div class="pub-inner">
      ${pubState.isPreview ? '<div class="flash-note">プレビュー表示中（計測されません）</div>' : ''}
      <div class="pub-hero">
        <div class="eyebrow">無料診断</div>
        <h1>${esc(d.title)}</h1>
        <div class="pub-lead">${esc(d.topCopy || d.description)}</div>
      </div>
      <div class="pub-facts">
        <div class="pub-fact"><div class="n">${d.questions.length}問</div><div class="l">かんたん回答</div></div>
        <div class="pub-fact"><div class="n">約${minutes}分</div><div class="l">所要時間</div></div>
        <div class="pub-fact"><div class="n">無料</div><div class="l">今すぐ診断</div></div>
      </div>
      <button class="cta-big" id="pub-start">診断をスタートする</button>
      <div class="pub-note">※ 診断結果は目安です。個人差があります。</div>
    </div></div>`;
  $('#pub-start').addEventListener('click', () => {
    if (!pubState.started && !pubState.isPreview) { logEvent(pubState.diag.id, 'start', { source: pubState.source }); pubState.started = true; }
    pubState.stage = 'q'; pubState.qIndex = 0; paintPublic(root);
  });
}

function paintPubQuestion(root) {
  const st = pubState; const d = st.diag; const qi = st.qIndex;
  const q = d.questions[qi];
  const total = d.questions.length;
  const pct = Math.round((qi) / total * 100);
  const animClass = st.dir === 'back' ? 'q-card q-enter-back' : 'q-card q-enter';
  const answered = st.answers[q.id]; // 戻ったときに前回の回答を強調
  root.innerHTML = `
    <div class="pub"><div class="pub-inner">
      <div class="q-head">
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="q-step"><span class="cur">${qi + 1}</span><span class="tot"> / ${total} 問</span></div>
      </div>
      <div class="${animClass}" data-qkey="${qi}">
        <div class="q-badge">Q${qi + 1}</div>
        <div class="q-text">${esc(q.text)}</div>
        <div id="choices">
          ${q.choices.map((c, ci) => `<button class="choice${answered === ci ? ' picked' : ''}" data-ci="${ci}">${esc(c.text)}</button>`).join('')}
        </div>
      </div>
      ${qi > 0 ? `<button class="btn ghost block q-back" id="pub-back">← 前の質問に戻る</button>` : ''}
    </div></div>`;
  if (window.scrollTo) window.scrollTo(0, 0);

  $('#choices').querySelectorAll('.choice').forEach(btn => {
    btn.addEventListener('click', () => {
      st.answers[q.id] = Number(btn.dataset.ci);
      st.dir = 'fwd';
      if (qi + 1 < total) { st.qIndex++; paintPublic(root); }
      else { finishDiagnosis(root); }
    });
  });
  const back = $('#pub-back');
  if (back) back.addEventListener('click', () => { st.dir = 'back'; st.qIndex--; paintPublic(root); });
}

function finishDiagnosis(root) {
  const st = pubState; const d = st.diag;
  const { totals, winner } = scoreDiagnosis(d, st.answers);
  st.result = { totals, winner };
  st.stage = 'result';
  if (!st.isPreview) logEvent(d.id, 'complete', { source: st.source, resultKey: winner.key });
  paintPublic(root);
}

function paintPubResult(root) {
  const st = pubState; const d = st.diag;
  const rt = st.result.winner; const totals = st.result.totals;
  const ctaUrl = rt.ctaUrl || d.reserveUrl || '#';
  const maxTotal = Math.max(1, ...Object.values(totals));
  const section = (icon, title, text, cls = '') => text ? `
    <div class="res-section ${cls}"><h3><span class="ico">${icon}</span>${title}</h3><p>${esc(text)}</p></div>` : '';

  root.innerHTML = `
    <div class="pub"><div class="pub-inner">
      <div class="res-badge">
        <div class="pre">あなたのタイプは…</div>
        <div class="type">${esc(rt.name)}</div>
      </div>
      ${rt.summary ? `<p class="pub-lead" style="text-align:center">${esc(rt.summary)}</p>` : ''}

      <div class="score-bars">
        ${d.resultTypes.map(t => {
          const v = totals[t.key] || 0;
          return `<div class="sb ${t.key === rt.key ? 'win' : ''}"><div class="nm">${esc(t.name || t.key)}</div>
            <div class="track"><i style="width:${v / maxTotal * 100}%"></i></div></div>`;
        }).join('')}
      </div>

      ${section('1', 'このタイプの特徴', rt.description)}
      ${section('2', 'よくある間違い', rt.mistake)}
      ${section('!', 'このまま放置すると…', rt.risk, 'risk')}
      ${section('3', '本来必要な改善方法', rt.solution)}
      ${section('4', '当院でできること', rt.service)}

      ${rt.recommendedMenu ? `
        <div class="res-menu">
          <div class="label">あなたにおすすめの予約メニュー</div>
          <div class="name">${esc(rt.recommendedMenu)}</div>
        </div>` : ''}

      <div class="cta-sticky">
        <a class="cta-big accent" id="pub-cta" href="${esc(ctaUrl)}" target="_blank" rel="noopener">${esc(rt.ctaText || '予約する')}</a>
        <div class="pub-note">${pubState.isPreview ? 'プレビュー中（クリックは計測されません）' : 'タップで予約ページへ移動します'}</div>
        <button class="btn ghost block" id="pub-retry" style="margin-top:10px">もう一度診断する</button>
      </div>
    </div></div>`;

  $('#pub-cta').addEventListener('click', (e) => {
    if (pubState.isPreview) { e.preventDefault(); return; }
    logEvent(d.id, 'cta_click', { source: pubState.source, resultKey: rt.key });
    if (!ctaUrl || ctaUrl === '#') { e.preventDefault(); toast('予約URLが設定されていません'); }
  });
  $('#pub-retry').addEventListener('click', () => {
    pubState.stage = 'top'; pubState.qIndex = 0; pubState.answers = {}; pubState.started = false; pubState.result = null;
    paintPublic(root);
  });
}

/* ============================================================
   グローバルイベント委譲
   ============================================================ */
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    navigator.clipboard?.writeText(copyBtn.dataset.copy).then(() => toast('コピーしました')).catch(() => toast('コピーに失敗しました'));
    return;
  }
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) { editTab = tabBtn.dataset.tab; paintEditor($('#root')); return; }

  const act = e.target.closest('[data-action]');
  if (!act) return;
  const action = act.dataset.action;

  // editor actions
  if (action === 'save') { saveEditor(); return; }
  if (action === 'preview') {
    e.preventDefault();
    // 同一タブでプレビュー（編集中の内容 editState をそのまま表示）
    navigate('#/d/__preview__?source=preview');
    return;
  }
  if (action === 'add-question') { editState.questions.push(emptyQuestion(editState.keys)); paintTab(); return; }
  if (action === 'del-question') {
    if (editState.questions.length <= 1) { toast('質問は最低1つ必要です'); return; }
    editState.questions = editState.questions.filter(q => q.id !== act.dataset.q); paintTab(); return;
  }
  if (action === 'add-choice') {
    const q = editState.questions.find(x => x.id === act.dataset.q); q.choices.push(emptyChoice(editState.keys)); paintTab(); return;
  }
  if (action === 'del-choice') {
    const q = editState.questions.find(x => x.id === act.dataset.q);
    if (q.choices.length <= 2) { toast('選択肢は最低2つ必要です'); return; }
    q.choices = q.choices.filter(c => c.id !== act.dataset.c); paintTab(); return;
  }

  // list actions
  if (action === 'toggle') {
    (async () => {
      const d = await api.get(act.dataset.id); if (!d) return;
      d.status = d.status === 'published' ? 'draft' : 'published';
      await api.update(d);
      toast(d.status === 'published' ? '公開しました' : '非公開にしました');
      viewList($('#root'));
    })();
    return;
  }
  if (action === 'dup') {
    (async () => {
      const src = await api.get(act.dataset.id); if (!src) return;
      const copy = JSON.parse(JSON.stringify(src));
      delete copy.id; delete copy.createdAt; delete copy.updatedAt;
      copy.title = src.title + '（複製）'; copy.status = 'draft'; copy.slug = '';
      await api.create(copy);
      toast('複製しました'); viewList($('#root'));
    })();
    return;
  }
  if (action === 'del') {
    (async () => {
      const d = await api.get(act.dataset.id); if (!d) return;
      if (confirm(`「${d.title}」を削除しますか？この操作は元に戻せません。`)) {
        await api.remove(act.dataset.id); toast('削除しました'); viewList($('#root'));
      }
    })();
    return;
  }
});

// inputイベントでフォーム同期（editor）
document.addEventListener('input', (e) => {
  if (!editState) return;
  const t = e.target;
  if (t.dataset && (t.dataset.field || t.dataset.qfield || t.dataset.cfield || t.dataset.score || t.dataset.rfield)) {
    commitField(t);
  }
});

/* ---------------- boot ---------------- */
window.addEventListener('hashchange', render);
async function boot() {
  // 公開ページ表示時はシードをスキップ（受診者の表示を速くする）
  const { parts } = parseHash();
  if (parts[0] !== 'd') { await seedIfEmpty(); }
  render();
}
window.addEventListener('DOMContentLoaded', boot);
if (document.readyState !== 'loading') { boot(); }
