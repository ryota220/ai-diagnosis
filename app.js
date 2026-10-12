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
const isVideo = (url) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || '');

/* ---------------- リッチテキスト（結果詳細の文字装飾） ---------------- */
const looksLikeHtml = (v) => /<[a-z][\s\S]*>/i.test(v || '');
// 装飾HTMLを安全なタグ・スタイルだけに絞る（自院の入力前提の軽量サニタイズ）
function sanitizeHtml(html) {
  const allowTags = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'SPAN', 'MARK', 'BR', 'DIV', 'P', 'FONT']);
  const safeStyle = (s) => (s || '').split(';').map(x => x.trim()).filter(d => {
    const p = d.split(':')[0].trim().toLowerCase();
    return ['color', 'background-color', 'background', 'font-weight', 'text-decoration'].includes(p) && !/url\(|expression|javascript:/i.test(d);
  }).join('; ');
  const tpl = document.createElement('template'); tpl.innerHTML = html || '';
  const walk = (node) => {
    [...node.childNodes].forEach(n => {
      if (n.nodeType === 1) {
        if (!allowTags.has(n.tagName)) { // 許可外タグは中身だけ残して除去
          const parent = n.parentNode;
          while (n.firstChild) parent.insertBefore(n.firstChild, n);
          parent.removeChild(n); return;
        }
        [...n.attributes].forEach(a => {
          if (a.name === 'style') { const s = safeStyle(a.value); if (s) n.setAttribute('style', s); else n.removeAttribute('style'); }
          else if (a.name === 'color' && n.tagName === 'FONT') { /* keep */ }
          else n.removeAttribute(a.name);
        });
        walk(n);
      }
    });
  };
  walk(tpl.content);
  return tpl.innerHTML;
}
// 保存済みの値を表示用HTMLに（旧データ＝プレーンテキストは改行を<br>に）
const renderRich = (v) => looksLikeHtml(v) ? sanitizeHtml(v) : esc(v).replace(/\n/g, '<br>');
const richInit = (v) => looksLikeHtml(v) ? v : esc(v).replace(/\n/g, '<br>');

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
  upload: (dataUrl) => apiJSON('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }) }),
  logEvent: (diagnosisId, type, extra = {}) =>
    fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ diagnosisId, type, source: extra.source || 'direct', resultKey: extra.resultKey || null }) }).catch(() => {}),
};
function logEvent(diagnosisId, type, extra = {}) { api.logEvent(diagnosisId, type, extra); }

/* ---------------- GTM（診断ごとのタグ管理） ---------------- */
const GTM_ID_RE = /^GTM-[A-Z0-9]{4,12}$/;
const normalizeGtmId = (v) => String(v || '').trim().toUpperCase();
const loadedGtmIds = new Set();
// 公開診断ページでのみ呼ぶ（管理画面・プレビューでは読み込まない）
function loadGtm(id) {
  if (!GTM_ID_RE.test(id) || loadedGtmIds.has(id)) return;
  loadedGtmIds.add(id);
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id);
  document.head.appendChild(s);
}
// 診断内の行動をdataLayerへ送る（GTM側でMetaピクセル等のトリガーに使う）
function pushDataLayer(event, st, extra = {}) {
  if (!st || st.isPreview) return;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event,
    diagnosis_id: st.diag.id,
    diagnosis_slug: st.diag.slug,
    diagnosis_title: st.diag.title,
    source: st.source,
    ...extra,
  });
}

/* ---------------- factory ---------------- */
// 結果ページのおすすめ欄の見出し（未設定の診断はこの文言のまま）
const DEFAULT_MENU_LABEL = 'あなたにおすすめの予約メニュー';

function emptyResultType(key) {
  return {
    key, name: '', priority: TYPE_KEYS.indexOf(key) + 1, summary: '', description: '',
    mistake: '', risk: '', solution: '', service: '', menuLabel: '', recommendedMenu: '', ctaText: '予約する', ctaUrl: '', image: ''
  };
}
function emptyChoice(keys) {
  const scores = {}; keys.forEach(k => scores[k] = 0);
  return { id: uid('c'), text: '', image: '', scores };
}
// type: 'single'(単一選択) | 'multi'(複数選択) | 'scale'(スライダー) | 'image'(画像選択)
function emptyQuestion(keys) {
  return { id: uid('q'), text: '', type: 'single', choices: [emptyChoice(keys), emptyChoice(keys)] };
}
const QTYPE_LABELS = { single: '単一選択', multi: '複数選択', scale: 'スライダー', image: '画像選択' };
function newDiagnosis() {
  const keys = ['A', 'B', 'C', 'D'];
  return {
    id: uid('d'), title: '', adminTitle: '', description: '', slug: '', status: 'draft',
    topCopy: '', lineMessage: '', leaveMessage: '', sourceDefault: 'line', reserveUrl: '', gtmId: '',
    bannerImage: '', bannerLink: '', titleImage: '', themeColor: '', choiceStyle: 'standard', startInline: false,
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
  // 回答の言い回しをバラす（毎回同じ「当てはまる」4択にしない）
  const scaleSets = [
    ['かなり当てはまる', '少し当てはまる', 'あまり当てはまらない', '当てはまらない'],
    ['よくある', 'たまにある', 'ほとんどない', 'まったくない'],
    ['はい', 'どちらかといえば はい', 'どちらかといえば いいえ', 'いいえ'],
    ['とても感じる', 'やや感じる', 'あまり感じない', '感じない'],
  ];
  // 先頭ほど高得点で、主軸/副軸タイプに配点した choices を作る
  const scoredChoices = (labels, lead) => labels.map((label, ci) => {
    const scores = {}; const weight = labels.length - ci;
    keys.forEach((k, ki) => {
      let s = 0;
      if (ki === lead) s = weight;
      else if (ki === (lead + 1) % keys.length) s = Math.max(0, weight - 2);
      else s = Math.max(0, weight - 3);
      scores[k] = s;
    });
    return { id: uid('c'), text: label, image: '', scores };
  });
  // 複数選択用：業種を問わず使える汎用の習慣・状況リスト（各項目を別タイプへ配点）
  const multiItems = [
    '自己流で対処してきた',
    '忙しくて自分のケアは後回しになりがち',
    '生活リズム（睡眠・食事・運動）が不規則',
    '専門家に相談したことがない',
    '一時的に良くなっても元に戻る',
    '同じ悩みを長く繰り返している',
  ];

  const questions = [];
  for (let qi = 0; qi < n; qi++) {
    const lead = qi % keys.length; // この設問で点を集めやすいタイプ
    if (qi === 1 && n >= 3) {
      // 2問目：複数選択（当てはまるものを全て）
      const items = multiItems.slice(0, Math.max(4, Math.min(6, keys.length + 1)));
      const choices = items.map((label, i) => {
        const scores = {}; keys.forEach(k => scores[k] = 0);
        scores[keys[i % keys.length]] = 2;
        return { id: uid('c'), text: label, image: '', scores };
      });
      questions.push({ id: uid('q'), type: 'multi', text: '当てはまる習慣・状況を全て選んでください', choices });
    } else if (qi === 2 && n >= 3) {
      // 3問目：スライダー（深刻度）
      const labels = ['気にならない', '少し気になる', '気になる', 'とても気になる'];
      questions.push({ id: uid('q'), type: 'scale', text: `${problem || '今のお悩み'}は、どのくらい気になっていますか？`, choices: scoredChoices(labels, lead) });
    } else {
      // 単一選択（言い回しをローテーション）
      const text = qTemplates[qi % qTemplates.length];
      const labels = scaleSets[qi % scaleSets.length];
      questions.push({ id: uid('q'), type: 'single', text, choices: scoredChoices(labels, lead) });
    }
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
    const a = answers[q.id];
    if (a == null) return;
    // 単一/画像/スライダーは数値、複数選択は配列。選ばれた全選択肢のスコアを合計。
    const sel = Array.isArray(a) ? a : [a];
    sel.forEach(ci => {
      const choice = q.choices[ci];
      if (!choice) return;
      diag.keys.forEach(k => { totals[k] += Number(choice.scores[k] || 0); });
    });
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
  if (typeof setLeaveGuard === 'function') setLeaveGuard(false); // 画面遷移のたびにリセット（回答画面で再有効化）
  const { parts, params } = parseHash();
  const root = $('#root');
  const header = $('#app-header');
  // 公開ページではヘッダーを隠す（受診者向け）
  const isPublic = parts[0] === 'd' || parts[0] === 'embed';
  header.style.display = isPublic ? 'none' : 'flex';
  document.body.style.background = isPublic ? '#eef1f6' : 'var(--bg)';

  if (parts.length === 0) return viewList(root);
  switch (parts[0]) {
    case 'new': return viewEditor(root, null);
    case 'edit': return viewEditor(root, parts[1]);
    case 'analytics': return viewAnalytics(root, parts[1]);
    case 'generate': return viewGenerate(root);
    case 'd': return viewPublic(root, parts[1], parts[2], params);
    case 'embed': return viewEmbed(root);
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
        ${d.adminTitle ? `<span class="pill" style="margin-left:6px">🔒 ${esc(d.adminTitle)}</span>` : ''}
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
let pvScreen = { stage: 'top' }; // 右側プレビューで表示中の画面 { stage: 'top'|'q'|'result', id }
let pvTimer = null;

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
  pvScreen = { stage: 'top' };
  paintEditor(root);
}

function paintEditor(root) {
  const d = editState;
  root.innerHTML = `
    <div class="wrap wide">
      <div class="page-title">
        <a class="btn ghost" href="#/">← 一覧</a>
        <h1>${d._fresh ? '診断を新規作成' : '診断を編集'}</h1>
        <div class="spacer"></div>
        <div class="view-toggle" id="view-toggle">
          <button class="active" data-action="view-mode" data-mode="edit">編集</button>
          <button data-action="view-mode" data-mode="preview">プレビュー</button>
        </div>
        <a class="btn" href="#/d/__preview__?source=preview" data-action="preview">▶ 通しで確認</a>
        <button class="btn primary" data-action="save">保存</button>
      </div>
      <div class="editor-split" id="editor-split">
        <div class="editor-main">
          <div class="tabs" id="tabs">
            <button data-tab="basic" class="${editTab==='basic'?'active':''}">基本情報</button>
            <button data-tab="questions" class="${editTab==='questions'?'active':''}">質問・スコア（<span id="q-count">${d.questions.length}</span>）</button>
            <button data-tab="results" class="${editTab==='results'?'active':''}">結果タイプ（${d.resultTypes.length}）</button>
            <button data-tab="publish" class="${editTab==='publish'?'active':''}">公開・配信</button>
          </div>
          <div id="tab-body"></div>
        </div>
        <aside class="pv-pane">
          <div class="pv-screens" id="pv-screens"></div>
          <div class="pv-phone"><iframe id="pv-frame" src="${location.pathname}#/embed" title="スマホプレビュー"></iframe></div>
          <p class="subtle pv-help">クリックで編集欄へ移動／画像はドラッグ＆ドロップで追加</p>
        </aside>
      </div>
    </div>`;
  paintTab();
}

function paintTab() {
  const body = $('#tab-body'); const d = editState;
  if (editTab === 'basic') body.innerHTML = tabBasic(d);
  else if (editTab === 'questions') body.innerHTML = tabQuestions(d);
  else if (editTab === 'results') body.innerHTML = tabResults(d);
  else if (editTab === 'publish') body.innerHTML = tabPublish(d);
  const qc = $('#q-count'); if (qc) qc.textContent = d.questions.length;
  schedulePreview();
}

// タブ切り替え（プレビューのiframeは作り直さない）。follow=true ならプレビューもタブに合わせる
function switchTab(tab, follow) {
  editTab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (follow) {
    const d = editState;
    if (tab === 'questions' && pvScreen.stage !== 'q') pvScreen = { stage: 'q', id: d.questions[0] && d.questions[0].id };
    else if (tab === 'results' && pvScreen.stage !== 'result') pvScreen = { stage: 'result', id: d.resultTypes[0] && d.resultTypes[0].key };
    else if (tab === 'basic' || tab === 'publish') pvScreen = { stage: 'top' };
  }
  paintTab();
}

/* ---- 右側のライブプレビュー（iframe に編集中の内容を送って描画） ---- */
function schedulePreview() {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(sendPreview, 120);
}
function sendPreview() {
  const frame = $('#pv-frame'); const d = editState;
  if (!frame || !d) return;
  // 削除などで表示中の画面が無くなったらトップに戻す
  if (pvScreen.stage === 'q' && !d.questions.some(q => q.id === pvScreen.id)) pvScreen = { stage: 'top' };
  if (pvScreen.stage === 'result' && !d.resultTypes.some(r => r.key === pvScreen.id)) pvScreen = { stage: 'top' };
  paintPvScreens();
  if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'pv-render', diag: JSON.parse(JSON.stringify(d)), screen: pvScreen }, location.origin);
}
function paintPvScreens() {
  const box = $('#pv-screens'); const d = editState;
  if (!box) return;
  const btn = (stage, id, label) => {
    const on = pvScreen.stage === stage && (stage === 'top' || pvScreen.id === id);
    return `<button class="${on ? 'active' : ''}" data-action="pv-screen" data-stage="${stage}" data-id="${esc(id || '')}">${esc(label)}</button>`;
  };
  box.innerHTML = btn('top', '', 'トップ')
    + d.questions.map((q, i) => btn('q', q.id, 'Q' + (i + 1))).join('')
    + d.resultTypes.map(rt => btn('result', rt.key, '結果' + rt.key)).join('');
}
// プレビューでクリックされた部品に対応する入力欄へ移動する
function focusEditorTarget(key) {
  const d = editState; if (!d) return;
  const [kind, a, b] = key.split(':');
  const q = (s) => CSS.escape(s || '');
  let tab, sel;
  if (kind === 'q') { tab = 'questions'; sel = `[data-qfield="text"][data-q="${q(a)}"]`; }
  else if (kind === 'c') { tab = 'questions'; sel = `[data-cfield="text"][data-q="${q(a)}"][data-c="${q(b)}"]`; }
  else if (kind === 'rt') { tab = 'results'; sel = b === 'image' ? `[data-dropslot="rt:${q(a)}"]` : `[data-rfield="${q(b)}"][data-k="${q(a)}"]`; }
  else if (kind === 'bannerImage' || kind === 'titleImage') { tab = 'basic'; sel = `[data-dropslot="${kind}"]`; }
  else { tab = 'basic'; sel = `[data-field="${q(kind)}"]`; }
  if (editTab !== tab) switchTab(tab, false);
  setViewMode('edit');
  const el = $(sel); if (!el) return;
  const box = el.closest('.field') || el.closest('.score-row') || el;
  box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (el.matches('input, textarea, select, [contenteditable]')) el.focus({ preventScroll: true });
  box.classList.remove('pv-flash'); void box.offsetWidth; box.classList.add('pv-flash');
}
// スマホ幅のときの「編集／プレビュー」切り替え
function setViewMode(mode) {
  const split = $('#editor-split'); if (!split) return;
  split.classList.toggle('mode-preview', mode === 'preview');
  document.querySelectorAll('#view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}

/* ---- 画像のアップロード（ファイル選択・ドラッグ＆ドロップ共通） ---- */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});
// slot: 'bannerImage' | 'titleImage' | 'rt:{key}' | 'c:{質問id}:{選択肢id}'
async function uploadToSlot(file, slot) {
  const d = editState; if (!d || !file) return;
  const allowVideo = slot.startsWith('rt:');
  if (!IMAGE_TYPES.includes(file.type) && !(allowVideo && VIDEO_TYPES.includes(file.type))) {
    toast(allowVideo ? '画像（PNG/JPEG/GIF/WebP）か動画（MP4/WebM/MOV）を選んでください' : '画像（PNG/JPEG/GIF/WebP）を選んでください');
    return;
  }
  if (file.size > 30 * 1024 * 1024) { toast('ファイルは30MBまでです'); return; }
  toast('アップロード中…');
  let res;
  try { res = await api.upload(await readAsDataUrl(file)); }
  catch (err) { toast('アップロードに失敗しました'); return; }
  if (editState !== d || !$('#editor-split')) return; // アップロード中に別の画面へ移動していたら反映しない
  const [kind, a, b] = slot.split(':');
  if (kind === 'rt') {
    const rt = d.resultTypes.find(x => x.key === a); if (!rt) return;
    rt.image = res.url;
  } else if (kind === 'c') {
    const qq = d.questions.find(x => x.id === a);
    const c = qq && qq.choices.find(x => x.id === b); if (!c) return;
    c.image = res.url;
  } else if (kind === 'bannerImage' || kind === 'titleImage') {
    d[kind] = res.url;
  } else return;
  toast('画像を追加しました');
  paintTab();
}

// 画像ファイルのドロップ枠。attr を持つ要素がドロップ先になる
function setupDropZones(attr, isActive, onDrop) {
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const mark = (zone) => document.querySelectorAll('.drop-over').forEach(z => { if (z !== zone) z.classList.remove('drop-over'); });
  document.addEventListener('dragover', (e) => {
    if (!isActive() || !hasFiles(e)) return;
    e.preventDefault(); // 枠の外に落としてもブラウザがファイルを開かないようにする
    const zone = e.target.closest(`[${attr}]`);
    mark(zone);
    if (zone) zone.classList.add('drop-over');
    e.dataTransfer.dropEffect = zone ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) mark(null); });
  document.addEventListener('drop', (e) => {
    if (!isActive() || !hasFiles(e)) return;
    e.preventDefault();
    mark(null);
    const zone = e.target.closest(`[${attr}]`);
    const file = e.dataTransfer.files[0];
    if (zone && file) onDrop(zone.getAttribute(attr), file);
  });
}
// 管理画面の入力欄側のドロップ枠
setupDropZones('data-dropslot', () => !!$('#editor-split'), (slot, file) => uploadToSlot(file, slot));

// 診断全体に付ける画像（バナー・タイトル画像）のアップロード欄
function diagImageField(d, field, label, hint, name) {
  return `<div class="field" data-dropslot="${field}"><label>${label} <span class="hint">${hint}</span></label>
      ${d[field] ? `<div class="rt-img-preview"><img src="${esc(d[field])}" alt=""><button class="btn sm danger" data-action="diag-img-remove" data-f="${field}">削除</button></div>` : ''}
      <label class="btn sm" style="cursor:pointer">📤 ${name}をアップロード
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-diagupload="${field}" style="display:none">
      </label> <span class="subtle">またはここへドロップ</span></div>`;
}

function tabBasic(d) {
  return `<div class="card pad">
    <div class="field"><label>管理用タイトル <span class="hint">🔒 内部用・受診者には表示されません（一覧での識別に使用）</span></label>
      <input type="text" data-field="adminTitle" value="${esc(d.adminTitle||'')}" placeholder="例：ダイエット院A・6月LINE配信用"></div>
    <hr class="muted-divider">
    <div class="field"><label>診断タイトル <span class="hint">受診者に表示される公開タイトル</span></label>
      <input type="text" data-field="title" value="${esc(d.title)}" placeholder="例：30代から痩せない原因診断"></div>
    <div class="field"><label>診断説明文</label>
      <textarea data-field="description" placeholder="例：あなたがなぜ痩せにくいのかを7問でチェックします。">${esc(d.description)}</textarea></div>
    <div class="field"><label>診断トップページ文章 <span class="hint">受診者が最初に見る導入文（離脱防止）</span></label>
      <textarea data-field="topCopy" style="min-height:130px">${esc(d.topCopy)}</textarea></div>
    ${diagImageField(d, 'bannerImage', 'トップページのバナー画像', '診断トップの一番上に表示（任意・PNG/JPEG/GIF/WebP・30MBまで）', 'バナー画像')}
    <div class="field"><label>バナーのリンク先URL <span class="hint">任意・空欄ならタップしても移動しません</span></label>
      <input type="url" data-field="bannerLink" value="${esc(d.bannerLink||'')}" placeholder="https://example.com/campaign"></div>
    <hr class="muted-divider">
    <h4 style="margin:0 0 10px">公開ページのデザイン</h4>
    <div class="field"><label class="check-label"><input type="checkbox" data-field="startInline" ${d.startInline ? 'checked' : ''}>
      スタート画面を省略し、バナーのすぐ下に1問目を表示する</label>
      <p class="subtle" style="margin:6px 0 0">オンにするとトップページ文章は表示されません。最初の回答で「診断開始」として計測します。</p></div>
    ${diagImageField(d, 'titleImage', '診断タイトル画像', 'タイトル文字の代わりに表示（任意・横長推奨）', 'タイトル画像')}
    <div class="two-col">
      <div class="field"><label>テーマ色 <span class="hint">ボタン・進捗バーなどの色</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="color" data-field="themeColor" value="${esc(THEME_COLOR_RE.test(d.themeColor||'') ? d.themeColor : '#2f6df6')}" style="width:56px;height:40px;padding:2px">
          ${d.themeColor ? '<button class="btn sm" data-action="theme-reset">標準色に戻す</button>' : '<span class="subtle">標準色（青）</span>'}
        </div></div>
      <div class="field"><label>選択肢ボタンの形</label>
        <select data-field="choiceStyle">
          <option value="standard" ${d.choiceStyle !== 'pill' ? 'selected' : ''}>標準（タップで次へ）</option>
          <option value="pill" ${d.choiceStyle === 'pill' ? 'selected' : ''}>丸ボタン（選んで「次へ」）</option>
        </select></div>
    </div>
    <div class="field"><label>離脱確認ポップアップの文言 <span class="hint">回答途中で「戻る」をした時に表示。空欄なら標準文を使用</span></label>
      <textarea data-field="leaveMessage" placeholder="${esc(DEFAULT_LEAVE_MSG)}">${esc(d.leaveMessage||'')}</textarea></div>
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
  const type = q.type || 'single';
  const isImage = type === 'image';
  const head = `<div class="score-row" style="margin-bottom:6px">
      <div class="score-head" style="text-align:left">${isImage ? '選択肢テキスト（＋下に画像URL）' : (type === 'scale' ? 'スライダーの目盛りラベル' : '選択肢テキスト')}</div>
      ${d.keys.map(k => `<div class="score-head">${k}</div>`).join('')}
      <div></div></div>`;
  const typeHints = {
    single: 'タップで1つ選び、次の質問へ自動で進みます。',
    multi: '「当てはまるものを全て」複数選べます。選んだ全ての点数が加算されます。',
    scale: '選択肢を目盛りとしたスライダーで表示します（左＝上、右＝下の順）。',
    image: '各選択肢に画像を設定すると、画像カードで選べます（アップロード・ドロップ・URL入力）。'
  };
  return `<div class="section-block" data-q="${q.id}">
    <div class="sb-head">
      <span class="qnum">${qi+1}</span>
      <input type="text" data-qfield="text" data-q="${q.id}" value="${esc(q.text)}" placeholder="質問文を入力">
      <select data-qtype data-q="${q.id}" style="width:150px">
        ${Object.entries(QTYPE_LABELS).map(([v, l]) => `<option value="${v}" ${type===v?'selected':''}>${l}</option>`).join('')}
      </select>
      <button class="btn ghost sm" data-action="del-question" data-q="${q.id}" title="質問を削除">✕</button>
    </div>
    <div class="subtle" style="margin:-4px 0 12px">${typeHints[type]}</div>
    ${head}
    ${q.choices.map((c, ci) => `
      <div style="margin-bottom:8px">
        <div class="score-row">
          <input type="text" data-cfield="text" data-q="${q.id}" data-c="${c.id}" value="${esc(c.text)}" placeholder="選択肢">
          ${d.keys.map(k => `<div class="sc"><input type="number" min="0" data-score="${k}" data-q="${q.id}" data-c="${c.id}" value="${Number(c.scores[k]||0)}"></div>`).join('')}
          <button class="btn ghost sm" data-action="del-choice" data-q="${q.id}" data-c="${c.id}">✕</button>
        </div>
        ${isImage ? `<div class="choice-img-row" data-dropslot="c:${q.id}:${c.id}">
          ${c.image ? `<img class="choice-thumb" src="${esc(c.image)}" alt="">` : ''}
          <input type="url" data-cfield="image" data-q="${q.id}" data-c="${c.id}" value="${esc(c.image||'')}" placeholder="画像URL（https://...）">
          <label class="btn sm" style="cursor:pointer;white-space:nowrap">📤 画像
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-cupload data-q="${q.id}" data-c="${c.id}" style="display:none">
          </label>
        </div>` : ''}
      </div>`).join('')}
    <button class="btn sm" data-action="add-choice" data-q="${q.id}">＋ 選択肢</button>
  </div>`;
}

function tabResults(d) {
  return `<div class="flash-note">結果ページの本文と、<b>結果タイプ別の予約CTA</b>を設定します。同点時は優先順位（数字が小さいほど優先）で決まります。</div>
  ${d.resultTypes.map(rt => resultBlock(rt)).join('')}`;
}
const RICH_COLORS = ['#dc2626', '#2f6df6', '#16a34a', '#d97706', '#111827'];
const RICH_MARKS = ['#fff3ba', '#ffd1d1', '#d1f0ff', '#e5d1ff'];
// 文字装飾つき編集欄（太字・文字色・マーカー）
function richField(rt, field, label) {
  return `<div class="field rich-wrap">
    <label>${label}</label>
    <div class="rt-toolbar">
      <button type="button" class="rt-tool tb" data-cmd="bold" title="太字"><b>B</b></button>
      ${RICH_COLORS.map(c => `<button type="button" class="rt-tool sw" data-cmd="foreColor" data-val="${c}" title="文字色" style="color:${c}">A</button>`).join('')}
      <span class="tb-sep"></span>
      ${RICH_MARKS.map(c => `<button type="button" class="rt-tool sw mk" data-cmd="hiliteColor" data-val="${c}" title="マーカー" style="background:${c}"></button>`).join('')}
      <button type="button" class="rt-tool tb" data-cmd="removeFormat" title="装飾をクリア">✕</button>
    </div>
    <div class="rich-edit" contenteditable="true" data-rfield="${field}" data-k="${rt.key}">${richInit(rt[field])}</div>
  </div>`;
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
    <div class="flash-note" style="margin:4px 0 14px">下の詳細は<b>文字を選択してツールバー</b>で装飾できます（太字・文字色・マーカー）。</div>
    ${richField(rt,'description','① このタイプの特徴 / なぜ改善しなかったのか')}
    ${richField(rt,'mistake','② よくある間違い')}
    ${richField(rt,'risk','③ このまま放置するとどうなるか')}
    ${richField(rt,'solution','④ 本来必要な改善方法')}
    ${richField(rt,'service','⑤ 当院でできること')}
    ${f('menuLabel',`おすすめ欄の見出し <span class="hint">空欄なら「${DEFAULT_MENU_LABEL}」</span>`,'例：あなたへのアドバイス')}
    <div class="two-col">
      ${f('recommendedMenu','おすすめ欄の内容（メニュー名・アドバイスなど）','例：栄養状態チェック付きカウンセリング')}
      ${f('ctaText','予約CTAボタン文言','例：栄養状態チェックを予約する')}
    </div>
    ${f('ctaUrl','予約URL（空欄なら基本予約URLを使用）','https://example.com/reserve')}
    <div class="field" data-dropslot="rt:${rt.key}"><label>結果ページに表示する画像・動画 <span class="hint">クーポン・ビフォーアフター・院長メッセージ動画など（任意・30MBまで）</span></label>
      ${rt.image ? `<div class="rt-img-preview">${isVideo(rt.image) ? `<video src="${esc(rt.image)}" controls muted playsinline></video>` : `<img src="${esc(rt.image)}" alt="">`}<button class="btn sm danger" data-action="rt-img-remove" data-k="${rt.key}">削除</button></div>` : ''}
      <label class="btn sm" style="cursor:pointer">📤 画像・動画をアップロード
        <input type="file" accept="image/*,video/mp4,video/webm,video/quicktime" data-imgupload data-k="${rt.key}" style="display:none">
      </label> <span class="subtle">またはここへドロップ</span>
    </div>
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
    <div class="field"><label>Googleタグマネージャー（GTM）コンテナID</label>
      <input type="text" data-field="gtmId" value="${esc(d.gtmId||'')}" placeholder="GTM-XXXXXXX" autocomplete="off">
      <p class="subtle" style="margin:6px 0 0">この診断の公開ページだけでGTMを読み込みます（空欄なら読み込みません）。
        dataLayerに diagnosis_view / diagnosis_start / diagnosis_complete / reserve_click を送信します。</p></div>
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
  const val = target.type === 'checkbox' ? target.checked : target.value;
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
  schedulePreview();
}

async function saveEditor() {
  const d = editState;
  if (!d.title.trim()) { switchTab('basic', true); toast('診断タイトルを入力してください'); return; }
  d.gtmId = normalizeGtmId(d.gtmId);
  if (d.gtmId && !GTM_ID_RE.test(d.gtmId)) { switchTab('publish', true); toast('GTMのIDは「GTM-XXXXXXX」の形式で入力してください'); return; }
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
        <h1>分析：${esc(d.adminTitle || d.title)}</h1>
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

// 回答中だけ「閉じる確認」を出すためのフラグ。トップ・結果・プレビューでは false。
let leaveGuard = false;
function setLeaveGuard(on) {
  leaveGuard = !!on;
  if (!on) { leaveTrapInstalled = false; document.querySelector('.modal-back.aidx-leave')?.remove(); }
}

// 離脱確認ポップアップ（文言は診断ごとに編集可能）
const DEFAULT_LEAVE_MSG = '診断はまだ途中です。\n今やめると結果が表示されません。続けますか？';
let leaveMsg = DEFAULT_LEAVE_MSG;
let leaveTrapInstalled = false;

// タブの強制クローズ／リロード時はブラウザ標準ダイアログ（文言は固定・ブラウザ仕様）
window.addEventListener('beforeunload', (e) => {
  if (leaveGuard) { e.preventDefault(); e.returnValue = ''; return ''; }
});

// 「戻る」操作を捕まえて、編集可能なカスタムポップアップを表示する
function installLeaveTrap() {
  if (leaveTrapInstalled) return;
  leaveTrapInstalled = true;
  history.pushState({ aidxGuard: true }, '', location.href);
}
window.addEventListener('popstate', () => {
  if (leaveGuard && !document.querySelector('.modal-back.aidx-leave')) {
    history.pushState({ aidxGuard: true }, '', location.href); // ページに留まる
    showLeaveModal();
  }
});
function showLeaveModal() {
  const back = document.createElement('div');
  back.className = 'modal-back aidx-leave';
  back.innerHTML = `<div class="modal" style="max-width:380px">
    <div class="m-body" style="text-align:center">
      <div style="font-size:34px;margin-bottom:8px">✋</div>
      <p style="font-size:16px;font-weight:700;line-height:1.6;white-space:pre-line;margin:0">${esc(leaveMsg)}</p>
    </div>
    <div class="m-foot" style="justify-content:center;gap:10px;border-top:none;padding:0 20px 20px">
      <button class="btn" id="aidx-leave-yes">中断する</button>
      <button class="btn primary" id="aidx-leave-no">診断を続ける</button>
    </div>
  </div>`;
  document.body.appendChild(back);
  back.querySelector('#aidx-leave-no').onclick = () => back.remove();
  back.querySelector('#aidx-leave-yes').onclick = () => {
    setLeaveGuard(false); back.remove();
    if (pubState) { // 中断 → 診断トップへ戻す
      pubState.stage = 'top'; pubState.qIndex = 0; pubState.answers = {}; pubState.started = false; pubState.dir = null;
      paintPublic($('#root'));
    }
  };
}

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

  const isNewVisit = !pubState || pubState.diagId !== diag.id;
  if (isNewVisit) {
    pubState = { diagId: diag.id, diag, source, isPreview, stage: 'top', qIndex: 0, answers: {}, started: false };
  }
  pubState.diag = diag;
  pubState.source = source;
  pubState.isPreview = isPreview;
  if (!isPreview) loadGtm(normalizeGtmId(diag.gtmId));
  if (isNewVisit) pushDataLayer('diagnosis_view', pubState);
  paintPublic(root);
}

/* ---- 編集画面の右側に埋め込むプレビュー（iframe内で動く） ---- */
function viewEmbed(root) {
  document.body.classList.add('pv-edit');
  root.innerHTML = '<div class="pub"><div class="pub-inner"><p class="subtle">プレビューを準備中…</p></div></div>';
  if (window.parent !== window) window.parent.postMessage({ type: 'pv-ready' }, location.origin);
}
function paintEmbed(diag, screen) {
  const root = $('#root');
  const key = screen.stage + ':' + (screen.id || '');
  const sameScreen = pubState && pubState.screenKey === key;
  const y = window.scrollY;
  const st = { diagId: diag.id, diag, source: 'preview', isPreview: true, editMode: true, stage: 'top', qIndex: 0, answers: {}, started: false, screenKey: key };
  if (!diag.questions || diag.questions.length === 0) {
    root.innerHTML = '<div class="pub"><div class="pub-inner empty"><p>質問を1つ以上追加してください。</p></div></div>';
    return;
  }
  if (screen.stage === 'q') {
    st.stage = 'q'; st.qIndex = Math.max(0, diag.questions.findIndex(q => q.id === screen.id));
  } else if (screen.stage === 'result' && diag.resultTypes.length) {
    const rt = diag.resultTypes.find(r => r.key === screen.id) || diag.resultTypes[0];
    // 見本のスコア（表示中のタイプが1位になるよう並べる）
    const sample = [10, 7, 5, 3, 2]; let i = 1; const totals = {};
    diag.resultTypes.forEach(t => { totals[t.key] = t.key === rt.key ? sample[0] : sample[Math.min(i++, 4)]; });
    st.stage = 'result'; st.result = { winner: rt, totals };
  }
  pubState = st;
  paintPublic(root);
  if (sameScreen) window.scrollTo(0, y); // 入力のたびに先頭へ戻らないよう、同じ画面ならスクロール位置を保つ
}
// 編集プレビューのときだけ付ける属性（クリック先の入力欄・画像のドロップ先）
function edAttr(editKey, dropSlot) {
  if (!pubState || !pubState.editMode) return '';
  return ` data-edit="${esc(editKey)}"` + (dropSlot ? ` data-drop="${esc(dropSlot)}"` : '');
}
// 編集プレビューのときだけ、空の画像枠に点線のドロップ枠を出す（公開ページには出ない）
function dropPh(slot, label, cls = '') {
  if (!pubState || !pubState.editMode) return '';
  return `<div class="pv-drop ${cls}"${edAttr(slot.startsWith('rt:') ? slot + ':image' : slot, slot)}>🖼️ ${esc(label)}</div>`;
}
// プレビュー内のクリックは画面遷移させず、親の編集画面へ「どこが押されたか」だけ伝える
document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('pv-edit')) return;
  e.preventDefault(); e.stopPropagation();
  const t = e.target.closest('[data-edit]');
  if (t) window.parent.postMessage({ type: 'pv-focus', key: t.dataset.edit }, location.origin);
}, true);
setupDropZones('data-drop', () => document.body.classList.contains('pv-edit'),
  (slot, file) => window.parent.postMessage({ type: 'pv-drop', slot, file }, location.origin));

function paintPublic(root) {
  const st = pubState; const d = st.diag;
  if (st.stage === 'top' && d.startInline) { st.stage = 'q'; st.qIndex = 0; } // スタート画面を省略
  if (st.stage === 'top') return paintPubTop(root);
  if (st.stage === 'q') return paintPubQuestion(root);
  if (st.stage === 'result') return paintPubResult(root);
}

/* ---- 公開ページのデザイン設定（診断ごと） ---- */
const THEME_COLOR_RE = /^#[0-9a-f]{6}$/i;
// 公開ページの外枠。テーマ色・ボタンの形をクラスとCSS変数で切り替える
function pubOpen(d) {
  const cls = ['pub'];
  let style = '';
  if (THEME_COLOR_RE.test(d.themeColor || '')) { cls.push('themed'); style = ` style="--brand:${d.themeColor}"`; }
  if (d.choiceStyle === 'pill') cls.push('choice-pill');
  return `<div class="${cls.join(' ')}"${style}>`;
}
function bannerHtml(d) {
  if (!d.bannerImage) return dropPh('bannerImage', 'バナー画像をドロップ（任意）', 'banner');
  const img = `<img src="${esc(d.bannerImage)}" alt="">`;
  // リンクは http(s) のみ許可（javascript: などは無視して画像だけ表示）
  const link = /^https?:\/\//i.test(d.bannerLink || '') ? d.bannerLink : '';
  const ed = edAttr('bannerImage', 'bannerImage');
  return link
    ? `<a class="pub-banner" id="pub-banner" href="${esc(link)}" target="_blank" rel="noopener"${ed}>${img}</a>`
    : `<div class="pub-banner"${ed}>${img}</div>`;
}
const titleImgHtml = (d) => d.titleImage ? `<h1 class="pub-title-img"${edAttr('titleImage', 'titleImage')}><img src="${esc(d.titleImage)}" alt="${esc(d.title)}"></h1>` : '';
const titlePh = () => dropPh('titleImage', 'タイトル画像をドロップ（任意）', 'sm');

function paintPubTop(root) {
  setLeaveGuard(false); // トップでは確認を出さない
  const d = pubState.diag;
  const minutes = Math.max(1, Math.round(d.questions.length * 0.3));
  root.innerHTML = `
    ${pubOpen(d)}${bannerHtml(d)}<div class="pub-inner">
      ${pubState.isPreview && !pubState.editMode ? '<div class="flash-note">プレビュー表示中（計測されません）</div>' : ''}
      <div class="pub-hero">
        <div class="eyebrow">無料診断</div>
        ${titleImgHtml(d) || `${titlePh()}<h1${edAttr('title')}>${esc(d.title)}</h1>`}
        <div class="pub-lead"${edAttr('topCopy')}>${esc(d.topCopy || d.description)}</div>
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
    markStarted(pubState);
    pubState.stage = 'q'; pubState.qIndex = 0; paintPublic(root);
  });
}

// 診断開始を1回だけ記録（通常はスタートボタン、スタート画面省略時は最初の回答で呼ぶ）
function markStarted(st) {
  if (st.started || st.isPreview) return;
  logEvent(st.diag.id, 'start', { source: st.source });
  pushDataLayer('diagnosis_start', st);
  st.started = true;
}

function paintPubQuestion(root) {
  const st = pubState; const d = st.diag; const qi = st.qIndex;
  // 回答中のみ確認を出す（プレビュー・スタート画面省略時の回答前は出さない）
  const guard = !st.isPreview && st.started;
  setLeaveGuard(guard);
  if (guard) { leaveMsg = (d.leaveMessage || '').trim() || DEFAULT_LEAVE_MSG; installLeaveTrap(); }
  const pill = d.choiceStyle === 'pill';
  const q = d.questions[qi];
  const total = d.questions.length;
  const pct = Math.round((qi) / total * 100);
  // 編集プレビューでは入力のたびに描き直すので、アニメーションは付けない
  const animClass = st.editMode ? 'q-card' : (st.dir === 'back' ? 'q-card q-enter-back' : 'q-card q-enter');
  const type = q.type || 'single';
  const stored = st.answers[q.id];
  const selArr = Array.isArray(stored) ? stored.slice() : [];
  const curIdx = (typeof stored === 'number') ? stored : Math.floor((q.choices.length - 1) / 2);
  const isSel = (ci) => stored === ci;

  // 回答エリアの中身を設問タイプ別に生成
  let body = '', needsNext = false;
  if (type === 'image') {
    body = `<div id="choices" class="img-grid">
      ${q.choices.map((c, ci) => `<button class="img-choice${isSel(ci) ? ' picked' : ''}" data-ci="${ci}"${edAttr(`c:${q.id}:${c.id}`, `c:${q.id}:${c.id}`)}>
        ${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : `<div class="img-ph">🖼️${st.editMode ? '<small>ドロップ</small>' : ''}</div>`}
        <span>${esc(c.text)}</span></button>`).join('')}
    </div>`;
  } else if (type === 'multi') {
    needsNext = true;
    body = `<div class="q-hint">当てはまるものを全て選んでください（複数可）</div>
      <div id="choices">
      ${q.choices.map((c, ci) => `<button class="choice multi${selArr.includes(ci) ? ' picked' : ''}" data-ci="${ci}"${edAttr(`c:${q.id}:${c.id}`)}>
        <span class="chk">${selArr.includes(ci) ? '✓' : ''}</span>${esc(c.text)}</button>`).join('')}
      </div>`;
  } else if (type === 'scale') {
    needsNext = true;
    const n = q.choices.length;
    body = `<div class="scale-wrap"${edAttr(`c:${q.id}:${q.choices[0] ? q.choices[0].id : ''}`)}>
        <input type="range" id="scale" min="0" max="${n - 1}" step="1" value="${curIdx}">
        <div class="scale-label" id="scale-label">${esc(q.choices[curIdx] ? q.choices[curIdx].text : '')}</div>
        <div class="scale-ends"><span>${esc(q.choices[0] ? q.choices[0].text : '')}</span><span>${esc(q.choices[n - 1] ? q.choices[n - 1].text : '')}</span></div>
      </div>`;
  } else { // single（丸ボタン型では「選ぶ→次へ」の2段階にする）
    needsNext = pill;
    body = `<div id="choices">
      ${q.choices.map((c, ci) => `<button class="choice${isSel(ci) ? ' picked' : ''}" data-ci="${ci}"${edAttr(`c:${q.id}:${c.id}`)}>${esc(c.text)}</button>`).join('')}
    </div>`;
  }

  const nextDisabled = (type === 'multi' && selArr.length === 0) || (type === 'single' && typeof stored !== 'number');
  root.innerHTML = `
    ${pubOpen(d)}${d.startInline ? bannerHtml(d) : ''}<div class="pub-inner">
      ${st.isPreview && !st.editMode && d.startInline && qi === 0 ? '<div class="flash-note">プレビュー表示中（計測されません）</div>' : ''}
      ${d.startInline ? (titleImgHtml(d) || titlePh()) : ''}
      <div class="q-head" id="q-head">
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="q-step"><span class="cur">${qi + 1}</span><span class="tot"> / ${total} 問</span></div>
      </div>
      <div class="${animClass}" data-qkey="${qi}">
        <div class="q-badge">Q${qi + 1}</div>
        <div class="q-text"${edAttr(`q:${q.id}`)}>${esc(q.text)}</div>
        ${body}
      </div>
      ${needsNext ? `<button class="cta-big q-next" id="pub-next"${nextDisabled ? ' disabled' : ''}>次へ進む</button>` : ''}
      ${qi > 0 ? `<button class="btn ghost block q-back" id="pub-back">← 前の質問に戻る</button>` : ''}
    </div></div>`;
  // スタート画面省略時は、回答を始めたらバナーを飛ばして質問の位置へ
  if (d.startInline && st.started) $('#q-head').scrollIntoView();
  else if (window.scrollTo) window.scrollTo(0, 0);

  const advance = (val) => {
    markStarted(st);
    st.answers[q.id] = val; st.dir = 'fwd';
    if (qi + 1 < total) { st.qIndex++; paintPublic(root); }
    else { finishDiagnosis(root); }
  };

  if (type === 'single' && pill) {
    const nextBtn = $('#pub-next');
    let picked = typeof stored === 'number' ? stored : null;
    $('#choices').querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        picked = Number(btn.dataset.ci);
        $('#choices').querySelectorAll('button').forEach(b => b.classList.toggle('picked', b === btn));
        nextBtn.disabled = false;
      });
    });
    nextBtn.addEventListener('click', () => { if (picked !== null) advance(picked); });
  } else if (type === 'single' || type === 'image') {
    $('#choices').querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => advance(Number(btn.dataset.ci)));
    });
  } else if (type === 'multi') {
    const nextBtn = $('#pub-next');
    $('#choices').querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const ci = Number(btn.dataset.ci);
        const i = selArr.indexOf(ci);
        if (i >= 0) selArr.splice(i, 1); else selArr.push(ci);
        btn.classList.toggle('picked');
        btn.querySelector('.chk').textContent = selArr.includes(ci) ? '✓' : '';
        st.answers[q.id] = selArr.slice();
        if (nextBtn) nextBtn.disabled = selArr.length === 0;
      });
    });
    if (nextBtn) nextBtn.addEventListener('click', () => { if (selArr.length) advance(selArr.slice()); });
  } else if (type === 'scale') {
    const slider = $('#scale'); const label = $('#scale-label');
    st.answers[q.id] = Number(slider.value); // 既定値も確定
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      label.textContent = q.choices[v] ? q.choices[v].text : '';
      st.answers[q.id] = v;
    });
    const nextBtn = $('#pub-next');
    if (nextBtn) nextBtn.addEventListener('click', () => advance(Number(slider.value)));
  }

  const back = $('#pub-back');
  if (back) back.addEventListener('click', () => { st.dir = 'back'; st.qIndex--; paintPublic(root); });
}

function finishDiagnosis(root) {
  const st = pubState; const d = st.diag;
  const { totals, winner } = scoreDiagnosis(d, st.answers);
  st.result = { totals, winner };
  st.stage = 'result';
  if (!st.isPreview) logEvent(d.id, 'complete', { source: st.source, resultKey: winner.key });
  pushDataLayer('diagnosis_complete', st, { result_type: winner.key, result_name: winner.name });
  paintPublic(root);
}

function paintPubResult(root) {
  setLeaveGuard(false); // 結果ページでは確認を出さない（CTAへ進める）
  const st = pubState; const d = st.diag;
  const rt = st.result.winner; const totals = st.result.totals;
  const ctaUrl = rt.ctaUrl || d.reserveUrl || '#';
  const maxTotal = Math.max(1, ...Object.values(totals));
  const section = (icon, title, field, cls = '') => rt[field] ? `
    <div class="res-section ${cls}"${edAttr(`rt:${rt.key}:${field}`)}><h3><span class="ico">${icon}</span>${title}</h3><div class="rich">${renderRich(rt[field])}</div></div>` : '';

  root.innerHTML = `
    ${pubOpen(d)}<div class="pub-inner">
      <div class="res-badge"${edAttr(`rt:${rt.key}:name`)}>
        <div class="pre">あなたのタイプは…</div>
        <div class="type">${esc(rt.name)}</div>
      </div>
      ${rt.summary ? `<p class="pub-lead" style="text-align:center"${edAttr(`rt:${rt.key}:summary`)}>${esc(rt.summary)}</p>` : ''}
      ${rt.image ? `<div class="res-image"${edAttr(`rt:${rt.key}:image`, `rt:${rt.key}`)}>${isVideo(rt.image) ? `<video src="${esc(rt.image)}" controls playsinline preload="metadata"></video>` : `<img src="${esc(rt.image)}" alt="" loading="lazy">`}</div>` : dropPh(`rt:${rt.key}`, '結果ページの画像・動画をドロップ（任意）')}

      <div class="score-bars">
        ${d.resultTypes.map(t => {
          const v = totals[t.key] || 0;
          return `<div class="sb ${t.key === rt.key ? 'win' : ''}"><div class="nm">${esc(t.name || t.key)}</div>
            <div class="track"><i style="width:${v / maxTotal * 100}%"></i></div></div>`;
        }).join('')}
      </div>

      ${section('1', 'このタイプの特徴', 'description')}
      ${section('2', 'よくある間違い', 'mistake')}
      ${section('!', 'このまま放置すると…', 'risk', 'risk')}
      ${section('3', '本来必要な改善方法', 'solution')}
      ${section('4', '当院でできること', 'service')}

      ${rt.recommendedMenu ? `
        <div class="res-menu"${edAttr(`rt:${rt.key}:recommendedMenu`)}>
          <div class="label"${edAttr(`rt:${rt.key}:menuLabel`)}>${esc(rt.menuLabel || DEFAULT_MENU_LABEL)}</div>
          <div class="name">${esc(rt.recommendedMenu)}</div>
        </div>` : ''}

      <div class="cta-sticky">
        <a class="cta-big accent" id="pub-cta" href="${esc(ctaUrl)}" target="_blank" rel="noopener"${edAttr(`rt:${rt.key}:ctaText`)}>${esc(rt.ctaText || '予約する')}</a>
        <div class="pub-note">${pubState.isPreview ? 'プレビュー中（クリックは計測されません）' : 'タップで予約ページへ移動します'}</div>
        <button class="btn ghost block" id="pub-retry" style="margin-top:10px">もう一度診断する</button>
      </div>
    </div></div>`;

  $('#pub-cta').addEventListener('click', (e) => {
    if (pubState.isPreview) { e.preventDefault(); return; }
    logEvent(d.id, 'cta_click', { source: pubState.source, resultKey: rt.key });
    if (!ctaUrl || ctaUrl === '#') { e.preventDefault(); toast('予約URLが設定されていません'); return; }
    pushDataLayer('reserve_click', pubState, { result_type: rt.key, result_name: rt.name, reserve_url: ctaUrl });
  });
  $('#pub-retry').addEventListener('click', () => {
    pubState.stage = 'top'; pubState.qIndex = 0; pubState.answers = {}; pubState.started = false; pubState.result = null;
    paintPublic(root);
  });
}

/* ---------------- リッチ編集：ツールバー ---------------- */
// ツールバー押下で選択が外れないようにする
document.addEventListener('mousedown', (e) => { if (e.target.closest('.rt-tool')) e.preventDefault(); });
document.addEventListener('click', (e) => {
  const tool = e.target.closest('.rt-tool');
  if (!tool) return;
  const cmd = tool.dataset.cmd, val = tool.dataset.val || null;
  try { document.execCommand('styleWithCSS', false, true); } catch (_) {}
  document.execCommand(cmd, false, val);
  const ed = tool.closest('.rich-wrap').querySelector('.rich-edit');
  if (ed) commitRich(ed);
});
function commitRich(ed) {
  if (!editState) return;
  const rt = editState.resultTypes.find(x => x.key === ed.dataset.k);
  if (rt) rt[ed.dataset.rfield] = sanitizeHtml(ed.innerHTML);
  schedulePreview();
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
  if (tabBtn) { switchTab(tabBtn.dataset.tab, true); return; }

  const act = e.target.closest('[data-action]');
  if (!act) return;
  const action = act.dataset.action;

  // editor actions
  if (action === 'save') { saveEditor(); return; }
  if (action === 'view-mode') { setViewMode(act.dataset.mode); return; }
  if (action === 'pv-screen') {
    pvScreen = act.dataset.stage === 'top' ? { stage: 'top' } : { stage: act.dataset.stage, id: act.dataset.id };
    sendPreview();
    return;
  }
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
  if (action === 'rt-img-remove') {
    const rt = editState.resultTypes.find(x => x.key === act.dataset.k);
    if (rt) { rt.image = ''; paintTab(); }
    return;
  }
  if (action === 'diag-img-remove') { editState[act.dataset.f] = ''; paintTab(); return; }
  if (action === 'theme-reset') { editState.themeColor = ''; paintTab(); return; }

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
      // 公開タイトルはそのまま、管理用タイトルに「（複製）」を付けて識別しやすく
      copy.adminTitle = (src.adminTitle || src.title || '無題') + '（複製）';
      copy.status = 'draft'; copy.slug = '';
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
  if (t.classList && t.classList.contains('rich-edit')) { commitRich(t); return; }
  if (t.dataset && (t.dataset.field || t.dataset.qfield || t.dataset.cfield || t.dataset.score || t.dataset.rfield)) {
    commitField(t);
  }
});
// 設問タイプの変更 → 保存して再描画（画像URL欄などの表示切替のため）
document.addEventListener('change', (e) => {
  if (!editState) return;
  const t = e.target;
  if (t.type === 'checkbox' && t.dataset.field) { commitField(t); return; }
  if (t.dataset && t.dataset.qtype != null) {
    const q = editState.questions.find(x => x.id === t.dataset.q);
    if (q) { q.type = t.value; paintTab(); }
  } else if (t.dataset && t.dataset.imgupload != null && t.files && t.files[0]) {
    uploadToSlot(t.files[0], 'rt:' + t.dataset.k); t.value = '';
  } else if (t.dataset && t.dataset.diagupload && t.files && t.files[0]) {
    uploadToSlot(t.files[0], t.dataset.diagupload); t.value = '';
  } else if (t.dataset && t.dataset.cupload != null && t.files && t.files[0]) {
    uploadToSlot(t.files[0], 'c:' + t.dataset.q + ':' + t.dataset.c); t.value = '';
  }
});

// 左で触っている場所に合わせて、プレビューの画面を切り替える
document.addEventListener('focusin', (e) => {
  if (!editState || !$('#editor-split') || !e.target.closest('#tab-body')) return;
  const qEl = e.target.closest('[data-q]'); const kEl = e.target.closest('[data-k]');
  let next;
  if (qEl) next = { stage: 'q', id: qEl.dataset.q };
  else if (kEl) next = { stage: 'result', id: kEl.dataset.k };
  else if (editTab === 'basic') next = { stage: 'top' };
  if (next && (next.stage !== pvScreen.stage || next.id !== pvScreen.id)) { pvScreen = next; sendPreview(); }
});

// プレビュー（iframe）からのメッセージ
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const frame = $('#pv-frame');
  const m = e.data || {};
  if (frame && e.source === frame.contentWindow) {
    if (m.type === 'pv-ready') sendPreview();
    else if (m.type === 'pv-focus' && typeof m.key === 'string') focusEditorTarget(m.key);
    else if (m.type === 'pv-drop' && typeof m.slot === 'string' && m.file instanceof Blob) uploadToSlot(m.file, m.slot);
  } else if (window.parent !== window && e.source === window.parent && m.type === 'pv-render' && m.diag) {
    paintEmbed(m.diag, m.screen || { stage: 'top' });
  }
});

/* ---------------- boot ---------------- */
window.addEventListener('hashchange', render);
async function boot() {
  // 公開ページ表示時はシードをスキップ（受診者の表示を速くする）
  const { parts } = parseHash();
  if (parts[0] !== 'd' && parts[0] !== 'embed') { await seedIfEmpty(); }
  render();
}
window.addEventListener('DOMContentLoaded', boot);
if (document.readyState !== 'loading') { boot(); }
