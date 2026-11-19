'use strict';
/* The EXACT JavaScript that runs inside the n8n Code nodes, in ONE place so the deploy scripts PUT
 * these strings and selftest.js runs these SAME strings (not a side-copy).
 * Escaping: template literals, so a regex backslash is doubled (\\d -> \d in the emitted string).
 */

// ---- Fire Engine · "Decide" (runs once for all items). channel 'ui' needs no Meta creds. ----
const DECIDE = `
const IST_OFFSET_MS = 5.5*60*60*1000;
function isQuietIST(ms){ var h = new Date(ms+IST_OFFSET_MS).getUTCHours(); return h>=22 || h<8; }
const now = Date.now();
const cfg = ($('Load Config').first() && $('Load Config').first().json) || {};
const channel = cfg.channel || 'ui';
const haveCreds = !!cfg.phoneNumberId && !!cfg.token;
const enabled = cfg.sendEnabled === true && (channel === 'whatsapp' ? haveCreds : true);
const quiet = isQuietIST(now);
const rows = $input.all().map(i => i.json);
const out = [];
if (enabled && !quiet) {
  for (const r of rows) {
    if (!r || r.status !== 'active') continue;
    const due = Date.parse(r.nextFireAt);
    if (isNaN(due) || due > now) continue;           // bad ts or not due -> skip (stays active)
    out.push({ json: {
      _id: r._id, status: 'sending', __fields: 'status', channel: channel,
      recipientPhone: String(r.recipientPhone||''),
      text: String(r.text||''),
      remText: '🔔 Reminder: ' + String(r.text||''),
      graphVersion: cfg.graphVersion || 'v21.0',
      phoneNumberId: cfg.phoneNumberId || '', token: cfg.token || ''
    }});
  }
}
return out;   // gated / quiet / nothing-due -> [] -> clean no-op
`.trim();

// ---- Fire Engine · WhatsApp "Build Mark" (runs once for each item) ----
const BUILD_MARK = `
const d = $('Decide').item.json;
const resp = $json || {};
let wamid = null;
try { wamid = (resp.messages && resp.messages[0] && resp.messages[0].id) || null; } catch (e) {}
const ok = !!wamid && !resp.error;
return { json: {
  _id: d._id,
  status: ok ? 'sent' : 'failed',
  firedAt: new Date().toISOString(),
  wamid: wamid,
  sendError: ok ? null : String((resp.error && (resp.error.message || resp.error.description)) || JSON.stringify(resp.error || {}) || 'no wamid in response').replace(/[Bb]earer\\s+\\S+/g, 'Bearer [redacted]').slice(0,300),
  channel: 'whatsapp',
  __fields: 'status,firedAt,wamid,sendError,channel'
}};
`.trim();

// ---- Fire Engine · UI "Build UI Row" (runs once for each item) -> shapes the ui_inbox doc ----
const BUILD_UI_ROW = `
const d = $('Decide').item.json;
return { json: {
  reminderId: String(d._id),
  recipientPhone: String(d.recipientPhone || ''),
  text: String(d.remText || ''),
  channel: 'ui',
  delivered: true,
  firedAt: new Date().toISOString()
}};
`.trim();

// ---- Fire Engine · UI "Build Mark UI" (runs once for each item) ----
const BUILD_MARK_UI = `
const d = $('Decide').item.json;
return { json: {
  _id: d._id, status: 'sent', firedAt: new Date().toISOString(), wamid: null,
  sendError: null, channel: 'ui', __fields: 'status,firedAt,wamid,sendError,channel'
}};
`.trim();

// ---- Create · "Build Doc" (secret baked in; never throws -> clean non-200 on bad input) ----
function buildDoc(secret) {
  return `
const IST_OFFSET_MS = 5.5*60*60*1000;
function istWallToUtcIso(wall){
  const m = String(wall).trim().match(/^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})(?::(\\d{2}))?$/);
  if(!m) throw new Error('bad');
  const utcMs = Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0)) - IST_OFFSET_MS;
  return new Date(utcMs).toISOString();
}
function err(code, msg){ return [{ json: { _ok:false, _code:code, _error:msg } }]; }
const root = $input.first().json || {};
const b = root.body || {};
const hdr = root.headers || {};
const SECRET = ${JSON.stringify(secret)};
const given = (b.secret || hdr['x-aaziko-reminder-secret'] || '').toString();
if (SECRET && given !== SECRET) return err(401, 'bad or missing secret');
const text = (b.text||'').toString().trim();
const phone = (b.recipientPhone||'').toString().replace(/[^0-9]/g,'');
const istRaw = (b.nextFireAt||b.nextFireAtIST||'').toString().trim();
if(!text) return err(400, 'text required');
if(!/^[0-9]{10,15}$/.test(phone)) return err(400, 'recipientPhone required: 10-15 digits, E.164 without +');
if(/[zZ+]/.test(istRaw)) return err(400, 'send nextFireAt as IST wall-clock "YYYY-MM-DD HH:mm", not UTC/Z');
let nextFireAt;
try { nextFireAt = istWallToUtcIso(istRaw); } catch(e){ return err(400, 'nextFireAt must be IST wall-clock "YYYY-MM-DD HH:mm"'); }
return [{ json: {
  _ok:true, text, recipientPhone: phone, setBy:(b.setBy||'api').toString(), source:(b.source||'api').toString(),
  nextFireAtIST: istRaw, nextFireAt, status:'active', firedAt:null, wamid:null, createdAt: new Date().toISOString()
} }];
`.trim();
}

// ---- UI · "Build Feed" (runs once for all items). Reads config + two $facet aggregates. ----
function buildFeed(secret) {
  return `
const SECRET = ${JSON.stringify(secret)};
const q = ($('Feed Hook').first() && $('Feed Hook').first().json.query) || {};
if (SECRET && (q.k || '') !== SECRET) return [{ json: { ok:false, error:'bad key' } }];
const IST_OFFSET_MS = 5.5*60*60*1000;
const now = Date.now();
function istHHMM(ms){ var d=new Date(ms+IST_OFFSET_MS); var z=function(n){return String(n).padStart(2,'0');}; return z(d.getUTCHours())+':'+z(d.getUTCMinutes()); }
function istQuiet(ms){ var h=new Date(ms+IST_OFFSET_MS).getUTCHours(); return h>=22||h<8; }
const cfg = ($('Load Config').first() && $('Load Config').first().json) || {};
const inboxFacet = ($('Load Inbox').first() && $('Load Inbox').first().json) || {};
const pendFacet = ($('Load Pending').first() && $('Load Pending').first().json) || {};
const inbox = (inboxFacet.rows || []).map(function(r){ return { text:String(r.text||''), recipientPhone:String(r.recipientPhone||''), firedIST: r.firedAt ? istHHMM(Date.parse(r.firedAt)) : '', firedAt: r.firedAt }; });
const pending = (pendFacet.rows || []).map(function(r){ var due=Date.parse(r.nextFireAt); return { text:String(r.text||''), recipientPhone:String(r.recipientPhone||''), dueIST: isNaN(due)?'':istHHMM(due), overdue: !isNaN(due) && (now-due)>120000 }; });
return [{ json: { ok:true, sendEnabled: cfg.sendEnabled===true, channel: cfg.channel||'ui', quietNow: istQuiet(now), nowIST: istHHMM(now), inbox: inbox, pending: pending } }];
`.trim();
}

module.exports = { DECIDE, BUILD_MARK, BUILD_UI_ROW, BUILD_MARK_UI, buildDoc, buildFeed };
