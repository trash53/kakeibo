const GEMINI_MODEL = 'gemini-2.5-flash';
const CATEGORIES = ['食費', '外食', '日用品', '交通費', '衣服', '医療', '娯楽', '光熱費', 'その他'];
const PAYMENTS = ['現金', 'クレジットカード', '電子マネー', 'QR決済', 'その他'];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

// 日本時間の今日(yyyy-MM-dd)
const todayJST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function validate(rec) {
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(rec.date) ? rec.date : todayJST(),
    store: String(rec.store || '不明'),
    amount: Math.round(Number(rec.amount)) || 0,
    payment: PAYMENTS.includes(rec.payment) ? rec.payment : 'その他',
    category: CATEGORIES.includes(rec.category) ? rec.category : 'その他',
  };
}

async function addRecord(env, rec, source) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO records (id,date,store,amount,payment,category,created_at,source) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, rec.date, rec.store, rec.amount, rec.payment, rec.category, new Date().toISOString(), source).run();
  return { id, ...rec };
}

async function analyzeReceipt(env, base64, mimeType) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');
  const prompt =
    'このレシート画像から情報を読み取り、JSONのみで返してください。\n' +
    '{"date":"YYYY-MM-DD","store":"店名","amount":税込合計金額(整数),' +
    '"payment":"' + PAYMENTS.join('|') + '","category":"' + CATEGORIES.join('|') + '"}\n' +
    'payment・categoryは必ず列挙した値から選ぶ。読み取れない項目は date は ' + todayJST() + '、payment は その他 とする。';

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    }
  );
  const body = await res.text();
  console.log('Gemini status', res.status, body); // wrangler tail / ダッシュボードのログで確認
  if (!res.ok) throw new Error(`Gemini APIエラー(${res.status})`);
  return JSON.parse(JSON.parse(body).candidates[0].content.parts[0].text);
}

async function summary(env) {
  const { results } = await env.DB.prepare(
    'SELECT substr(date,1,7) AS ym, category, SUM(amount) AS total FROM records GROUP BY ym, category'
  ).all();
  const monthly = {}, matrix = {}, cats = [...CATEGORIES];
  for (const r of results) {
    monthly[r.ym] = (monthly[r.ym] || 0) + r.total;
    (matrix[r.ym] ||= {})[r.category] = r.total;
    if (!cats.includes(r.category)) cats.push(r.category); // 過去データの独自カテゴリも表示
  }
  return { monthly, matrix, categories: cats };
}


// ===== 固定費 =====
const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

// 指定月の固定費を登録(登録済みの月はスキップ)。maxDay指定時は、その日以前の支払日のものだけ。
async function applyFixed(env, month, maxDay = null) {
  const { results } = await env.DB.prepare('SELECT * FROM fixed_costs ORDER BY day, rowid').all();
  let added = 0, skipped = 0;
  for (const f of results) {
    const day = Math.min(f.day, daysInMonth(month));
    if (maxDay !== null && day > maxDay) continue;
    const r = await env.DB.prepare('INSERT OR IGNORE INTO fixed_applied (fixed_id, month) VALUES (?, ?)').bind(f.id, month).run();
    if (!r.meta.changes) { skipped++; continue; }
    await addRecord(env, { date: `${month}-${String(day).padStart(2, '0')}`, store: f.name, amount: f.amount, payment: f.payment, category: f.category }, '固定費');
    added++;
  }
  return { added, skipped };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === '/api/options' && req.method === 'GET')
        return json({ categories: CATEGORIES, payments: PAYMENTS });

      if (path === '/api/records' && req.method === 'GET') {
        const n = Math.min(Number(url.searchParams.get('limit')) || 30, 200);
        const { results } = await env.DB.prepare(
          'SELECT id,date,store,amount,payment,category FROM records ORDER BY created_at DESC, rowid DESC LIMIT ?'
        ).bind(n).all();
        return json(results);
      }

      if (path === '/api/records' && req.method === 'POST') {
        const rec = validate(await req.json());
        return json(await addRecord(env, rec, '手入力'));
      }

      if (path.startsWith('/api/records/') && req.method === 'DELETE') {
        const id = decodeURIComponent(path.slice('/api/records/'.length));
        const r = await env.DB.prepare('DELETE FROM records WHERE id = ?').bind(id).run();
        if (!r.meta.changes) return json({ error: '該当するデータが見つかりません' }, 404);
        return json({ ok: true });
      }

      if (path === '/api/summary' && req.method === 'GET') return json(await summary(env));

      if (path === '/api/receipt' && req.method === 'POST') {
        const { image, mimeType } = await req.json();
        const rec = validate(await analyzeReceipt(env, image, mimeType || 'image/jpeg'));
        return json(await addRecord(env, rec, 'レシート'));
      }

      if (path === '/api/fixed' && req.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT id,name,amount,payment,category,day FROM fixed_costs ORDER BY day, rowid').all();
        return json(results);
      }
      if (path === '/api/fixed' && req.method === 'POST') {
        const b = await req.json();
        const v = validate({ ...b, date: todayJST() });
        const day = Math.min(31, Math.max(1, Math.round(Number(b.day)) || 1));
        const name = String(b.name || '').trim();
        if (!name) return json({ error: '名称を入力してください' }, 400);
        const id = crypto.randomUUID();
        await env.DB.prepare('INSERT INTO fixed_costs (id,name,amount,payment,category,day,created_at) VALUES (?,?,?,?,?,?,?)')
          .bind(id, name, v.amount, v.payment, v.category, day, new Date().toISOString()).run();
        return json({ id, name, amount: v.amount, payment: v.payment, category: v.category, day });
      }
      if (path.startsWith('/api/fixed/') && req.method === 'DELETE') {
        const id = decodeURIComponent(path.slice('/api/fixed/'.length));
        await env.DB.prepare('DELETE FROM fixed_costs WHERE id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM fixed_applied WHERE fixed_id = ?').bind(id).run();
        return json({ ok: true });
      }
      if (path === '/api/fixed-apply' && req.method === 'POST') {
        const { month } = await req.json();
        if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: '月の形式が不正です' }, 400);
        return json(await applyFixed(env, month));
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },

  // 毎日0時(JST)に、今月分のうち支払日を迎えた固定費を自動登録(取りこぼしも拾う)
  async scheduled(event, env, ctx) {
    const today = todayJST();
    ctx.waitUntil(applyFixed(env, today.slice(0, 7), Number(today.slice(8, 10))));
  },
};
