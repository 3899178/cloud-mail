import test from 'node:test';
import assert from 'node:assert/strict';
const load = async()=>import('../src/auth/session-core.mjs');
test('legacy token removed only after verified cookie exchange and never written back',async()=>{
 const {createSession}=await load();let stored='old-jwt';let fail=true;const calls=[];
 const state=createSession({storage:{getItem:()=>stored,removeItem:()=>{stored=null}},fetcher:async(url,options)=>{calls.push({url,options});return {ok:!fail,json:async()=>({code:fail?401:200,data:{csrfToken:'csrf'}})};},base:'/api'});
 await assert.rejects(state.bootstrap());assert.equal(stored,'old-jwt');
 fail=false;await state.bootstrap();assert.equal(stored,null);assert.equal(state.authenticated,true);assert.equal(state.csrfToken,'csrf');assert.equal(calls[0].options.headers.Authorization,'old-jwt');
});
test('cookie-only reload discovers session; reset erases memory without touching drafts',async()=>{
 const {createSession}=await load();const removed=[];
 const state=createSession({storage:{getItem:()=>null,removeItem:k=>removed.push(k)},fetcher:async()=>({ok:true,json:async()=>({code:200,data:{csrfToken:'csrf'}})}),base:'/api'});
 await state.bootstrap();assert.equal(state.authenticated,true);state.reset();assert.equal(state.authenticated,false);assert.deepEqual(removed,['token']);
});
test('permission route install clears previous owner menus before adding next owner routes',async()=>{
 const {installPermissionRoutes,clearPermissionRoutes}=await import('../src/auth/permission-routes.mjs');const names=new Set(['inbox']);const router={addRoute(parent,route){names.add(route.name);return()=>names.delete(route.name);}};
 installPermissionRoutes(router,[{name:'admin-users'},{name:'drafts'}]);assert.equal(names.has('admin-users'),true);
 installPermissionRoutes(router,[{name:'drafts'}]);assert.equal(names.has('admin-users'),false);assert.equal(names.has('drafts'),true);clearPermissionRoutes(router);assert.deepEqual([...names],['inbox']);
});
test('cookie reload and owner switch replace real router menus and clear owner caches without touching saved drafts',async()=>{
 const {createRouter,createMemoryHistory}=await import('vue-router');const {createOwnerSession}=await import('../src/auth/owner-session.mjs');
 const {createSession}=await load();const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',name:'layout',component:{},children:[]}]});
 const drafts=new Map([['old@example.test',[{text:'saved draft'}]]]);const cache={detailMap:{1:{text:'old body'}},$reset(){this.detailMap={};}};const userStore={user:{},$reset(){this.user={};}},accountStore={currentAccount:{},$reset(){this.currentAccount={};this.currentAccountId=0;}};
 const state=createSession({storage:{getItem:()=>null,removeItem:()=>{}},fetcher:async()=>({ok:true,json:async()=>({code:200,data:{csrfToken:'csrf'}})}),base:'/api'});
 const owner=createOwnerSession({session:state,router,userStore,accountStore,caches:[cache],routesFor:keys=>keys.map(name=>({name,path:'/'+name,component:{}}))});
 await state.bootstrap();await owner.load(async()=>({email:'old@example.test',account:{accountId:1},permKeys:['drafts','users']}));
 assert.equal(router.hasRoute('users'),true);assert.deepEqual(cache.detailMap,{});
 await owner.load(async()=>({email:'new@example.test',account:{accountId:2},permKeys:['drafts']}));assert.equal(router.hasRoute('users'),false);assert.equal(accountStore.currentAccountId,2);assert.equal(userStore.user.email,'new@example.test');
 await assert.rejects(owner.load(async()=>{throw Error('unavailable');}));assert.equal(state.authenticated,false);assert.equal(router.hasRoute('drafts'),false);assert.deepEqual(userStore.user,{});assert.equal(drafts.get('old@example.test')[0].text,'saved draft');
});
