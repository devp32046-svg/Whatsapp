'use strict';
/* Remove the n8n browser-extension button (#n8n-download-all-btn) from Aaziko UI.
 * Adds a CSS rule + MutationObserver to the UI HTML so it never shows, regardless of extension.
 *
 * node aaziko/brain/deploy/fix-ui-remove-extension-btn.js          -- dry run
 * node aaziko/brain/deploy/fix-ui-remove-extension-btn.js --write  -- apply
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const UI_WF_ID = ids.uiWfId; // bL0JQ2UTk4nM5rIJ
const BACKUP_DIR = path.resolve(__dirname, '..', '..', '..', 'backups');

// Inject this just before </head> or </body>
const INJECT = `
<style>#n8n-download-all-btn{display:none!important;visibility:hidden!important;pointer-events:none!important}</style>
<script>
(function(){
  function rm(){var b=document.getElementById('n8n-download-all-btn');if(b)b.remove();}
  rm();
  var mo=new MutationObserver(rm);
  mo.observe(document.documentElement,{childList:true,subtree:true});
})();
</script>`;

(async () => {
  const wf = await getWf(UI_WF_ID);
  console.log('UI workflow:', wf.name, '| nodes:', wf.nodes.length);

  // Find the node that serves HTML (Respond to Webhook or Code node with HTML)
  let htmlNodeIdx = -1;
  let htmlField = null;

  for (let i = 0; i < wf.nodes.length; i++) {
    const n = wf.nodes[i];
    if (n.parameters && n.parameters.responseBody && typeof n.parameters.responseBody === 'string' && (n.parameters.responseBody.includes('<!DOCTYPE') || n.parameters.responseBody.includes('<!doctype') || n.parameters.responseBody.includes('<html'))) {
      htmlNodeIdx = i;
      htmlField = 'responseBody';
      console.log('Found HTML in node:', n.name, '(responseBody, chars:', n.parameters.responseBody.length + ')');
      break;
    }
    if (n.parameters && n.parameters.jsCode && typeof n.parameters.jsCode === 'string' && n.parameters.jsCode.includes('<!DOCTYPE')) {
      htmlNodeIdx = i;
      htmlField = 'jsCode';
      console.log('Found HTML in node:', n.name, '(jsCode, chars:', n.parameters.jsCode.length + ')');
      break;
    }
  }

  if (htmlNodeIdx === -1) {
    // List all nodes to help diagnose
    console.log('\nAll nodes:');
    wf.nodes.forEach(n => console.log(' -', n.name, n.type, Object.keys(n.parameters || {}).join(',')));
    throw new Error('Could not find HTML node in UI workflow');
  }

  const html = wf.nodes[htmlNodeIdx].parameters[htmlField];
  const alreadyInjected = html.includes('n8n-download-all-btn') && html.includes('MutationObserver');

  if (alreadyInjected) {
    console.log('Already injected — nothing to do');
    return;
  }

  // Insert before </body> if present, else before </html>, else append
  let newHtml;
  if (html.includes('</body>')) {
    newHtml = html.replace('</body>', INJECT + '\n</body>');
  } else if (html.includes('</html>')) {
    newHtml = html.replace('</html>', INJECT + '\n</html>');
  } else {
    newHtml = html + INJECT;
  }

  console.log('\nInject location: ' + (html.includes('</body>') ? 'before </body>' : html.includes('</html>') ? 'before </html>' : 'appended'));

  if (!WRITE) {
    console.log('\nDRY RUN — would inject CSS+JS to hide #n8n-download-all-btn');
    console.log('(pass --write to apply)');
    return;
  }

  fs.writeFileSync(path.join(BACKUP_DIR, UI_WF_ID + '_before_rm_ext_btn.json'), JSON.stringify(wf, null, 2));

  wf.nodes[htmlNodeIdx].parameters[htmlField] = newHtml;

  await putWf(UI_WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  await activate(UI_WF_ID);

  // Verify
  const live = await getWf(UI_WF_ID);
  const lNode = live.nodes[htmlNodeIdx];
  const lHtml = lNode.parameters[htmlField];
  const ok = lHtml.includes('n8n-download-all-btn') && lHtml.includes('MutationObserver');
  console.log('\n=== VERIFY ===');
  console.log('Button hide injected:', ok ? '✅' : '❌');
  console.log('UI active:', live.active);
  if (ok) console.log('\n✅ Button will be hidden on Aaziko UI — refresh the page');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
