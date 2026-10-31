import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer, loadConfigFromFile, loadEnv } from 'vite';

test('local dev proxy keeps browser Host and Origin together without rewriting a hostile Origin',async t=>{
  const loaded=await loadConfigFromFile({command:'serve',mode:'dev'});
  assert.equal(loadEnv('dev',process.cwd()).VITE_BASE_URL,'/api');
  assert.equal(loaded.config.server.host,'127.0.0.1');
  assert.equal(loaded.config.server.proxy['/api'].changeOrigin,false);
  const upstream=httpServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({host:req.headers.host,origin:req.headers.origin}));});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const vite=await createServer({configFile:false,server:{...loaded.config.server,port:0,strictPort:false,proxy:{'/api':{...loaded.config.server.proxy['/api'],target:'http://127.0.0.1:'+upstream.address().port}}}});
  t.after(()=>vite.close());await vite.listen();
  const origin='http://127.0.0.1:'+vite.httpServer.address().port;
  for(const sentOrigin of [origin,'https://evil.test']){
    const result=await (await fetch(origin+'/api/session',{headers:{Origin:sentOrigin}})).json();
    assert.equal(result.host,new URL(origin).host);assert.equal(result.origin,sentOrigin);
  }
});
