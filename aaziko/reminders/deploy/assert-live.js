'use strict';
/* Assert the LIVE workflows on ai.cgpe.in contain EXACTLY the Code-node strings from node-code.js
 * (so "selftest proves the shipped code" is literally true), engine is active, and there are no recent
 * error executions.
 *   node aaziko/reminders/deploy/assert-live.js
 */
const path = require('path'), fs = require('fs');
const { req } = require('../../../scripts/lib/n8n-req');
const { DECIDE, BUILD_MARK, BUILD_UI_ROW, BUILD_MARK_UI, buildDoc, buildFeed } = require('../lib/node-code');
const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'reminders-n8n.json'), 'utf8'));
const env = {}; try { fs.readFileSync(path.join(SEC_DIR, 'reminders.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }); } catch (e) {}
const codeOf = (wf, name) => { const n = wf.nodes.find(x => x.name === name); return n && n.parameters && n.parameters.jsCode; };

(async () => {
  let fails = 0;
  const ck = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fails++; };

  const create = JSON.parse((await req('GET', '/api/v1/workflows/' + ids.createWfId)).body);
  ck('create "Build Doc" live === buildDoc(SECRET)', codeOf(create, 'Build Doc') === buildDoc(env.REMINDERS_CREATE_SECRET));
  ck('create active', create.active === true);

  const eng = JSON.parse((await req('GET', '/api/v1/workflows/' + ids.engineWfId)).body);
  ck('engine "Decide" live === NC.DECIDE', codeOf(eng, 'Decide') === DECIDE);
  ck('engine "Build Mark" live === NC.BUILD_MARK', codeOf(eng, 'Build Mark') === BUILD_MARK);
  ck('engine "Build UI Row" live === NC.BUILD_UI_ROW', codeOf(eng, 'Build UI Row') === BUILD_UI_ROW);
  ck('engine "Build Mark UI" live === NC.BUILD_MARK_UI', codeOf(eng, 'Build Mark UI') === BUILD_MARK_UI);
  ck('engine active', eng.active === true);

  if (ids.uiWfId) {
    const ui = JSON.parse((await req('GET', '/api/v1/workflows/' + ids.uiWfId)).body);
    ck('ui "Build Feed" live === buildFeed(SECRET)', codeOf(ui, 'Build Feed') === buildFeed(env.REMINDERS_CREATE_SECRET));
    ck('ui active', ui.active === true);
  }

  // engine saves only ERROR execs (success logging is 'none'); count only RECENT ones (last 10 min)
  const rows = JSON.parse((await req('GET', '/api/v1/executions?workflowId=' + ids.engineWfId + '&limit=30')).body).data || [];
  const cutoff = Date.now() - 10 * 60000;
  const recentErr = rows.filter(x => x.status === 'error' && Date.parse(x.startedAt) > cutoff);
  ck('engine recent (10min) error executions == 0', recentErr.length === 0);
  if (rows.filter(x => x.status === 'error').length) console.log('   (older error execs present: ' + rows.filter(x => x.status === 'error').map(e => e.id + '@' + e.startedAt).join(', ') + ')');

  console.log(fails ? ('\n' + fails + ' LIVE CHECK(S) FAILED') : '\nALL LIVE CHECKS PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
