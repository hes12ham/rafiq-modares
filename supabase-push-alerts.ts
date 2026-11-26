import webpush from "npm:web-push@3.6.7";
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function cfg(k: string): Promise<string | undefined> {
  const r = await sql`select value from private.app_config where key = ${k}`;
  return r[0]?.value;
}
async function vapid() {
  let pub = await cfg("vapid_public");
  if (!pub) {
    const k = webpush.generateVAPIDKeys();
    await sql`insert into private.app_config(key,value) values ('vapid_public', ${k.publicKey}), ('vapid_private', ${k.privateKey}) on conflict (key) do nothing`;
    pub = await cfg("vapid_public");
  }
  const priv = await cfg("vapid_private");
  webpush.setVapidDetails("mailto:noreply@rafiq-modares.app", pub!, priv!);
  return pub!;
}

const TX: Record<string, Record<string, string>> = {
  ar: {
    day: "بكرة: حصة {g} الساعة {t}", dayB: "{n} طالب — افتح التطبيق وذكّر الطلاب",
    soon: "حصة {g} كمان {m} دقيقة", soonB: "الساعة {t} — افتح وسجّل الحضور",
    miss: "حصة {g} النهارده لسه متسجلتش", missB: "سجّل الحضور والدرجات عشان التقارير تطلع",
    abs: "{s} غاب {n} حصص ورا بعض", absB: "ابعت لولي الأمر من التطبيق",
    fee: "{n} طالب لسه مدفعوش الشهر ده", feeB: "افتح صفحة المصاريف وابعت تذكير",
    exT: "امتحان \"{e}\" بكرة", exD: "امتحان \"{e}\" النهارده", exB: "{g}",
    test: "الإشعارات شغالة ✓", testB: "هيوصلك تنبيه بالحصص والغياب والمصاريف",
  },
  en: {
    day: "Tomorrow: {g} at {t}", dayB: "{n} students — open the app to remind them",
    soon: "{g} starts in {m} min", soonB: "At {t} — open the app to take attendance",
    miss: "{g} today isn't recorded yet", missB: "Record attendance and grades so reports are ready",
    abs: "{s} missed {n} sessions in a row", absB: "Message the parent from the app",
    fee: "{n} students haven't paid this month", feeB: "Open Fees and send a reminder",
    exT: "Exam \"{e}\" tomorrow", exD: "Exam \"{e}\" today", exB: "{g}",
    test: "Notifications are on ✓", testB: "You'll get alerts for sessions, absences and fees",
  },
};
const f = (s: string, v: Record<string, unknown>) => s.replace(/\{(\w)\}/g, (_, k) => String(v[k] ?? ""));

function local(tz: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hour = (+p.hour) % 24;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
    hour, mins: hour * 60 + +p.minute,
  };
}
const addDays = (s: string, n: number) => {
  const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};

type Alert = { id: string; k: string; title: Record<string, string>; body: Record<string, string>; url: string };

function compute(docs: Record<string, any>): Alert[] {
  const meta = docs.meta || {}, P = meta.prefs || {}, on = P.on || {};
  if (P.push === false) return [];
  const tz = P.tz || "Africa/Cairo", L = local(tz), out: Alert[] = [];
  const groups: any[] = docs.groups?.items || [], students: any[] = (docs.students?.items || []).filter((s: any) => s.active !== false);
  const sessions: any[] = Object.keys(docs).filter((k) => k.startsWith("ses-")).flatMap((k) => docs[k].items || []);
  const both = (key: string, v: Record<string, unknown>) => ({ ar: f(TX.ar[key], v), en: f(TX.en[key], v) });
  for (const g of groups) {
    if (g.start && L.date < g.start) continue;
    const slots: { d: number; t: string }[] = (g.slots && g.slots.length) ? g.slots : (g.days || []).map((d: number) => ({ d, t: g.time }));
    for (const sl of slots) {
      if (sl.d !== L.wd || !sl.t) continue;
      const [h, m] = String(sl.t).split(":").map(Number), t = h * 60 + (m || 0);
      const done = sessions.some((s) => s.groupId === g.id && s.date === L.date);
      const remind = +P.remind || 30;
      if (on.soon !== false && !done && t - L.mins > 0 && t - L.mins <= remind)
        out.push({ id: `soon-${g.id}${L.date}${sl.t}`, k: "soon", title: both("soon", { g: g.name, m: t - L.mins }), body: both("soonB", { t: sl.t }), url: "#home" });
      if (on.missing !== false && !done && L.mins - t >= 60 && L.mins - t <= 300)
        out.push({ id: `miss-${g.id}${L.date}${sl.t}`, k: "missing", title: both("miss", { g: g.name }), body: both("missB", {}), url: "#home" });
    }
  }
  if (on.day !== false) {
    const tom = addDays(L.date, 1), twd = (L.wd + 1) % 7;
    for (const g of groups) {
      if (g.start && tom < g.start) continue;
      const slots: { d: number; t: string }[] = (g.slots && g.slots.length) ? g.slots : (g.days || []).map((d: number) => ({ d, t: g.time }));
      const n = students.filter((s) => s.groupId === g.id).length;
      for (const sl of slots) {
        if (sl.d !== twd || !sl.t) continue;
        const [h, m] = String(sl.t).split(":").map(Number), t = h * 60 + (m || 0);
        if (L.mins >= t) out.push({ id: `day-${g.id}${tom}${sl.t}`, k: "day", title: both("day", { g: g.name, t: sl.t }), body: both("dayB", { n }), url: "#home" });
      }
    }
  }
  if (on.absent !== false) for (const st of students) {
    const L2 = sessions.filter((s) => s.groupId === st.groupId && s.rec && s.rec[st.id]).sort((a, b) => (a.date < b.date ? -1 : 1));
    let k = 0; for (let i = L2.length - 1; i >= 0 && L2[i].rec[st.id].a === "غ"; i--) k++;
    if (k >= 2) out.push({ id: `abs-${st.id}${L2[L2.length - 1].id}`, k: "absent", title: both("abs", { s: st.name, n: k }), body: both("absB", {}), url: "#student-" + st.id });
  }
  if (on.fee !== false && +L.date.slice(8) >= (+P.feeDay || 5) && L.hour >= 10) {
    const m = L.date.slice(0, 7), pays: any[] = docs.payments?.items || [];
    const fee = (s: any) => +(groups.find((g) => g.id === s.groupId)?.fee || 0);
    const n = students.filter((s) => fee(s) > 0 && pays.filter((p) => p.sid === s.id && p.month === m).reduce((t, p) => t + (+p.amount || 0), 0) < fee(s)).length;
    const week = Math.floor((+L.date.slice(8) - 1) / 7);
    if (n) out.push({ id: `fee-${m}-w${week}`, k: "fee", title: both("fee", { n }), body: both("feeB", {}), url: "#payments" });
  }
  if (on.exam !== false) for (const e of docs.exams?.items || []) {
    const g = groups.find((x) => x.id === e.groupId)?.name || "";
    if (e.date === addDays(L.date, 1) && L.hour >= 18) out.push({ id: `ex-${e.id}-1`, k: "exam", title: both("exT", { e: e.title }), body: both("exB", { g }), url: "#exam-" + e.id });
    if (e.date === L.date && L.hour >= 8) out.push({ id: `ex-${e.id}-0`, k: "exam", title: both("exD", { e: e.title }), body: both("exB", { g }), url: "#exam-" + e.id });
  }
  return out;
}

async function sendTo(subs: any[], payload: (lang: string) => object) {
  let sent = 0;
  for (const s of subs) {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload(s.lang)), { TTL: 3600 }); sent++; }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await sql`delete from public.push_subs where endpoint = ${s.endpoint}`; else console.error("push error", e?.statusCode, e?.body); }
  }
  return sent;
}

async function userFromAuth(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const r = await fetch(Deno.env.get("SUPABASE_URL") + "/auth/v1/user", {
    headers: { authorization: h, apikey: Deno.env.get("SUPABASE_ANON_KEY")! },
  });
  if (!r.ok) return null;
  return (await r.json())?.id || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const pub = await vapid();
    if (url.searchParams.has("vapid")) return json({ publicKey: pub });

    if (url.searchParams.has("test")) {
      const uid = await userFromAuth(req);
      if (!uid) return json({ error: "unauthorized" }, 401);
      const subs = await sql`select endpoint, sub, lang from public.push_subs where teacher_id = ${uid}`;
      const n = await sendTo(subs, (l) => ({ title: TX[l]?.test || TX.ar.test, body: TX[l]?.testB || TX.ar.testB, url: "#alerts", tag: "test" }));
      return json({ sent: n, subs: subs.length });
    }

    if (req.headers.get("x-cron-key") !== (await cfg("cron_key"))) return json({ error: "forbidden" }, 403);
    const subs = await sql`select teacher_id, endpoint, sub, lang from public.push_subs`;
    const byT = new Map<string, any[]>();
    for (const s of subs) byT.set(s.teacher_id, [...(byT.get(s.teacher_id) || []), s]);
    let total = 0;
    for (const [tid, ts] of byT) {
      const prev = addDays(new Date().toISOString().slice(0, 8) + "01", -1).slice(0, 7);
      const rows = await sql`select key, body from public.app_docs where teacher_id = ${tid} and (key in ('meta','groups','students','payments','exams') or (key like 'ses-%' and key >= ${"ses-" + prev}))`;
      const docs: Record<string, any> = {}; for (const r of rows) docs[r.key] = r.body;
      for (const a of compute(docs)) {
        const ins = await sql`insert into private.push_sent(teacher_id, alert_id) values (${tid}, ${a.id}) on conflict do nothing returning alert_id`;
        if (!ins.length) continue;
        total += await sendTo(ts, (l) => ({ title: a.title[l] || a.title.ar, body: a.body[l] || a.body.ar, url: a.url, tag: a.id }));
      }
    }
    await sql`delete from private.push_sent where sent_at < now() - interval '60 days'`;
    return json({ teachers: byT.size, sent: total });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
