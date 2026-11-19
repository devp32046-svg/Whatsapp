const puppeteer=require('puppeteer-core');
const SS='/tmp/claude-1000/-home-aaziko-aaziko/3c96c3a6-1923-4f69-8b55-30b5c31632d6/scratchpad/';
(async()=>{
  const br=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage'],defaultViewport:{width:1500,height:1300}});
  const errs=[]; const pg=await br.newPage(); pg.on('pageerror',e=>errs.push(e.message));
  // full search -> click flow, exactly what the user does
  await pg.goto('http://localhost:3077/',{waitUntil:'networkidle2',timeout:90000});
  const box=await pg.$('#q')||await pg.$('input[type=search]')||await pg.$('.searchbox input');
  if(!box){console.log('search input selectors:',await pg.evaluate(()=>[...document.querySelectorAll('input')].map(i=>i.id+'|'+i.className+'|'+i.placeholder)));}
  else{
    await box.click(); await box.type('CERAMICA MAJA',{delay:40});
    await pg.waitForFunction(()=>document.querySelectorAll('.sres,.searchrow,[data-company]').length>0,{timeout:60000}).catch(()=>{});
    await new Promise(r=>setTimeout(r,1500));
    const hit=await pg.evaluate(()=>{const r=document.querySelector('.sres,.searchrow,[data-company]');return r?r.innerText.slice(0,60):null;});
    console.log('first search hit:',hit);
    await pg.evaluate(()=>{const r=document.querySelector('.sres,.searchrow,[data-company]');if(r)r.click();});
  }
  await pg.waitForFunction(()=>{const e=document.getElementById('pipelinebox');return e&&!/Loading/.test(e.textContent)&&e.textContent.length>200;},{timeout:90000});
  const t=await pg.evaluate(()=>document.getElementById('pipelinebox').innerText);
  console.log('\n=== PIPELINE BLOCK (rendered) ===\n'+t);
  const bb=await pg.evaluate(()=>{const e=document.getElementById('pipelinebox');const r=e.getBoundingClientRect();return{y:r.y+window.scrollY,h:r.height};});
  await pg.evaluate(y=>window.scrollTo(0,y-20),bb.y);
  await new Promise(r=>setTimeout(r,400));
  await pg.screenshot({path:SS+'pipeline.png',clip:{x:60,y:0,width:1400,height:Math.min(900,bb.h+40)}});
  console.log('\nPAGE ERRORS:',errs.length?errs:'none');
  await br.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
