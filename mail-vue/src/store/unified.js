import { defineStore } from 'pinia'
import { session } from '@/auth/session.js'
import { request } from '@/request/unified.js'
const codeOf = e => e?.response?.data?.error?.code || e?.error?.code || e?.code || 'REQUEST_FAILED'
const quiet = e => ['STALE_SESSION','ERR_CANCELED','AbortError'].includes(codeOf(e))
export const useUnifiedStore = defineStore('unified', {
  // Never persisted: source refs, bodies, upload capabilities and credentials.
  state: () => ({ selection:{source:'all',accountId:null}, items:[], detail:null, accounts:[], localAccounts:[], accountsError:'', accountsLoading:false,
    nextCursor:null, incomplete:false, resetRequired:false, sources:{}, loading:false, error:'', detailError:'',
    operation:null, operationError:'', listGeneration:0, detailGeneration:0, operationGeneration:0, accountGeneration:0 }),
  actions: {
    select(source,accountId=null) {
      this.listGeneration++; this.detailGeneration++; this.operationGeneration++
      this.selection={source,accountId}; this.items=[]; this.detail=null; this.nextCursor=null
      this.error=''; this.detailError=''; this.operation=null; this.operationError=''; this.loading=false
      this.incomplete=false; this.resetRequired=false; this.sources={}
    },
    async loadAccounts() {
      const lease=session.lease(), generation=++this.accountGeneration
      this.accountsLoading=true
      try {
        const data=await request('/external/accounts',{signal:lease.signal})
        lease.assertCurrent(); if(generation!==this.accountGeneration)return
        if(!Array.isArray(data.accounts))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'})
        this.accounts=data.accounts; this.accountsError=''
      } catch(e) { if(lease.current() && generation===this.accountGeneration && !quiet(e)) this.accountsError=codeOf(e) }
      finally { if(lease.current() && generation===this.accountGeneration)this.accountsLoading=false }
    },
    async load({append=false}={}) {
      if(append && (this.loading || !this.nextCursor || this.resetRequired))return
      const lease=session.lease(), generation=++this.listGeneration
      const query={source:this.selection.source,limit:50}
      if(this.selection.accountId!==null)query.accountId=this.selection.accountId
      if(append)query.cursor=this.nextCursor
      this.loading=true; this.error=''
      try {
        const data=await request('/unified/messages',{query,signal:lease.signal})
        lease.assertCurrent(); if(generation!==this.listGeneration)return
        const rows=append&&!data.resetRequired?[...this.items,...data.items]:data.items
        this.items=[...new Map(rows.map(m=>[m.ref,m])).values()]
        this.incomplete=!!data.incomplete; this.resetRequired=!!data.resetRequired
        this.sources=data.sources; this.nextCursor=data.resetRequired?null:data.nextCursor
        if(this.detail && !append) {
          const row=this.items.find(m=>m.ref===this.detail.ref)
          if(row)this.detail={...this.detail,...row}
          if(!row || this.detailError)await this.revalidateDetail(lease,generation)
        }
      } catch(e) { if(lease.current() && generation===this.listGeneration && !quiet(e))this.error=codeOf(e) }
      finally { if(lease.current() && generation===this.listGeneration)this.loading=false }
    },
    async revalidateDetail(lease,listGeneration) {
      const ref=this.detail?.ref, generation=this.detailGeneration, operationGeneration=this.operationGeneration
      if(!ref || ['queued','running'].includes(this.operation?.state))return
      const current=()=>lease.current() && listGeneration===this.listGeneration && generation===this.detailGeneration && operationGeneration===this.operationGeneration && this.detail?.ref===ref
      try {
        // A missing first-page row may be older than that page. Confirm against
        // the owned detail endpoint before discarding a retained selection.
        const data=await request(`/unified/messages/${encodeURIComponent(ref)}`,{signal:lease.signal})
        lease.assertCurrent();if(!current())return
        if(data.message?.ref!==ref)throw Object.assign(new Error(),{code:'INVALID_RESPONSE'})
        this.detail=data.message;this.detailError=''
      } catch(e) {
        if(!current() || quiet(e))return
        this.detailError=codeOf(e)
        if(codeOf(e)==='NOT_FOUND') {
          this.detail=null;this.detailGeneration++;this.operationGeneration++
          this.operation=null;this.operationError=''
        }
      }
    },
    async open(ref) {
      const lease=session.lease(), generation=++this.detailGeneration
      this.operationGeneration++; this.operation=null; this.operationError=''; this.detail=null; this.detailError=''
      try {
        const data=await request(`/unified/messages/${encodeURIComponent(ref)}`,{signal:lease.signal})
        lease.assertCurrent(); if(generation!==this.detailGeneration)return
        this.detail=data.message
      } catch(e) { if(lease.current() && generation===this.detailGeneration && !quiet(e))this.detailError=codeOf(e) }
    },
    applyOperation(operation, context) {
      this.operation={...operation,context}
      if(operation.state!=='succeeded')return
      if(context.kind==='trash') {
        this.items=this.items.filter(m=>m.ref!==context.ref)
        if(this.detail?.ref===context.ref)this.detail=null
      } else if(context.kind==='read') {
        const row=this.items.find(m=>m.ref===context.ref); if(row)row.unread=context.unread
        if(this.detail?.ref===context.ref)this.detail.unread=context.unread
      }
    },
    async mutate(kind,ref,body) {
      const lease=session.lease(), generation=++this.operationGeneration
      this.operationError=''; this.operation={state:'running'}
      const context={kind,ref,unread:body?.unread}
      try {
        const data=await request(`/unified/messages/${encodeURIComponent(ref)}/${kind}`,{method:'POST',body,signal:lease.signal})
        lease.assertCurrent(); if(generation!==this.operationGeneration)return
        this.applyOperation(data.operation,context)
      } catch(e) { if(lease.current() && generation===this.operationGeneration && !quiet(e)) {this.operation=null;this.operationError=codeOf(e)} }
    },
    async checkOperation() {
      if(!this.operation?.id)return
      const lease=session.lease(), generation=this.operationGeneration, previous=this.operation
      try {
        const data=await request(`/external/operations/${encodeURIComponent(previous.id)}`,{signal:lease.signal})
        lease.assertCurrent(); if(generation!==this.operationGeneration)return
        this.applyOperation(data.operation,previous.context)
      } catch(e) { if(lease.current() && generation===this.operationGeneration && !quiet(e))this.operationError=codeOf(e) }
    }
  }
})
